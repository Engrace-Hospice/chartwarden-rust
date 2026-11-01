/**
 * CW-RUST-M02 P2 prerequisite 5 — acceptance tests on a real Bun + Rust stack (AT-M02-05b, 09, 10, 11, plus the
 * uid-1000 socket test). Driven phase by phase by `verification/local-stack/run.sh`, which owns the containers
 * (it stops and pauses `rust` between phases). Each phase writes `<out>/<phase>.json` (checks) and `<out>/<phase>.log`
 * (every bridge and sweep log line the phase produced), and exits 1 if a check failed.
 *
 *   bun run verification/src/m02-local-stack.ts <phase> --source <upstream checkout> --out <dir> --state <dir>
 *     [--admin-url <url>] [--socket /run/cw-rust/cw-rust.sock]
 *
 * Phases: setup · socket · socket-deny · e2e · fallback-stopped · fallback-recovered · shadow-stalled · logs
 *
 * Bun side: upstream's own code, unmodified — `buildServer` (the real hook chain, header hygiene first),
 * `registerAuthorizationRoutes` (the real route), the real bridge, signer and Unix-socket client, the real DB resolver as
 * `chartwarden_app`, the real sweep reader and the real audited org enumerator. The ONE substitution is
 * `authenticate`: a stub that stamps the context from x-test-* headers, as upstream's own route test does
 * (apps/backend/__tests__/m02-rust-bridge-route.test.ts). Upstream's real authenticate hook is unchanged by M02 and is
 * covered by its own suites; the 401 paths here come from the real `requireSession` preHandler.
 *
 * Safety: the database must carry the disposable marker and be the only database in its cluster (this changes
 * cluster-wide roles), exactly like verify:m02-parity. No production host can satisfy that.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import { ACTORS } from "./m02-parity";

const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const phase = process.argv[2] ?? "";
const source = resolve(flag("--source") ?? "/work/upstream");
const out = resolve(flag("--out") ?? "/out");
const state = resolve(flag("--state") ?? "/work/state");
const adminUrl = flag("--admin-url") ?? process.env.CW_M02_ADMIN_URL ?? "";
const socketPath = flag("--socket") ?? "/run/cw-rust/cw-rust.sock";
const root = resolve(import.meta.dir, "../..");

const PATH = "/api/v1/me/permissions";
const APP_PASSWORD = "chartwarden_app_live_test";
const PLATFORM_ROLE = "chartwarden_platform_m02_local";
const PLATFORM_PASSWORD = "platform_m02_local";
const EPHEMERAL_MARKER = "cw-ephemeral-test-db";
const KID = "m02local";

const A = "f0000000-0000-4000-8000-00000000000a";
const u = (n: number) => `f0000000-0000-4000-8002-${String(n).padStart(12, "0")}`;

// ---------------------------------------------------------------------------------------------------------------------
// Results and logging

type Check = { name: string; ok: boolean; detail?: Record<string, unknown> };
const checks: Check[] = [];
const logLines: string[] = [];
function check(name: string, ok: boolean, detail: Record<string, unknown> = {}) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}  ${JSON.stringify(detail)}`);
}
function capture(component: string) {
  const line = (level: string) => (o: Record<string, unknown>, m: string) => {
    logLines.push(JSON.stringify({ level, component, ...o, msg: m }));
  };
  return { info: line("info"), warn: line("warn") };
}
function finish(extra: Record<string, unknown> = {}) {
  mkdirSync(out, { recursive: true });
  const failed = checks.filter((c) => !c.ok).length;
  writeFileSync(
    join(out, `${phase}.json`),
    `${JSON.stringify({ phase, at: new Date().toISOString(), bun: Bun.version, failed, checks, ...extra }, null, 2)}\n`,
  );
  writeFileSync(join(out, `${phase}.log`), logLines.length ? `${logLines.join("\n")}\n` : "");
  console.log(`\n[${phase}] ${checks.length} checks, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number) : Number.NaN;
};
const median = (xs: number[]) => pct(xs, 50);
const round = (n: number) => Math.round(n * 100) / 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
  return cond();
}

// ---------------------------------------------------------------------------------------------------------------------
// Upstream modules (absolute paths into the checkout, so its own workspace resolution applies)

const up = (p: string) => import(join(source, p));
async function upstream() {
  const [bootstrap, identity, authz, auth, tenancy, db, store, resolveMod, bridge, enumerator] = await Promise.all([
    up("apps/backend/src/bootstrap/index.ts"),
    up("apps/backend/src/modules/02-identity/index.ts"),
    up("apps/backend/src/modules/03-authorization/index.ts"),
    up("packages/auth/src/index.ts"),
    up("packages/tenancy/src/index.ts"),
    up("packages/db/src/client.ts"),
    up("packages/auth/src/rbac/drizzle-store.ts"),
    up("packages/auth/src/rbac/resolve.ts"),
    up("apps/backend/src/bootstrap/rust-bridge/index.ts"),
    up("apps/backend/src/bootstrap/active-org-enumerator.ts"),
  ]);
  return { bootstrap, identity, authz, auth, tenancy, db, store, resolveMod, bridge, enumerator };
}
type Up = Awaited<ReturnType<typeof upstream>>;

function urls() {
  if (!adminUrl) throw Error("--admin-url (or CW_M02_ADMIN_URL) is required");
  const app = new URL(adminUrl);
  app.username = "chartwarden_app";
  app.password = APP_PASSWORD;
  const platform = new URL(adminUrl);
  platform.username = PLATFORM_ROLE;
  platform.password = PLATFORM_PASSWORD;
  return { admin: adminUrl, app: app.toString(), platform: platform.toString() };
}

function signingEnv() {
  return readFileSync(join(state, "signing.key"), "utf8").trim();
}

/** Stub authenticate: stamps what the real hook stamps (bootstrap/plugins/authenticate.ts), from test headers. */
function stubAuthenticate(request: {
  headers: Record<string, unknown>;
  context: { userId?: string; organizationId?: string; attributes: Record<string, unknown> };
}) {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user === "") return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  if (typeof org === "string" && org !== "") request.context.organizationId = org;
  request.context.attributes.sessionId = "local-session";
  request.context.attributes.sessionClass =
    typeof request.headers["x-test-class"] === "string" ? request.headers["x-test-class"] : "staff";
}

type Mode = "off" | "shadow" | "serve";
type Built = {
  app: {
    inject: (o: Record<string, unknown>) => Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }>;
    listen: (o: Record<string, unknown>) => Promise<string>;
    close: () => Promise<void>;
  };
  bridge?: { stats(): Record<string, unknown> & { fallback: Record<string, number> }; inFlight(): number; close(): void };
};

/** The real server, the real route, the real DB resolver; the bridge per `mode` exactly as index.ts wires it. */
function buildApp(U: Up, appDb: unknown, mode: Mode, opts: { timeoutMs?: number } = {}): Built {
  const env: Record<string, string> =
    mode === "off"
      ? {}
      : { RUST_ROUTES: "me-permissions", RUST_ROUTE_MODE: mode, RUST_SOCKET: socketPath, CW_ACTOR_SIGNING_KEY: signingEnv() };
  if (opts.timeoutMs) env.RUST_TIMEOUT_MS = String(opts.timeoutMs);
  const config = U.bridge.parseRustBridgeConfig(env);
  const resolver = U.resolveMod.createEffectivePermissionResolver(U.store.createDbEffectivePermissionStore(appDb));
  const freshStore = U.store.createDbEffectivePermissionStore(appDb);
  const bridge =
    mode === "off"
      ? undefined
      : U.bridge.createMePermissionsBridge({
          config,
          signer: U.bridge.createAssertionSigner(config.signingKey),
          client: U.bridge.createRustClient(config.socketPath, config.timeoutMs),
          logger: capture(`rust-bridge:${mode}`),
        });
  const app = U.bootstrap.buildServer({ authenticate: stubAuthenticate, security: { rateLimitEnabled: false } });
  U.authz.registerAuthorizationRoutes(app, {
    roles: U.authz.createInMemoryRoleStore().store,
    membershipRoles: U.authz.createInMemoryMembershipRoleStore().store,
    breakGlass: U.authz.createInMemoryBreakGlassStore().store,
    engagements: U.authz.createInMemoryEngagementStore().store,
    auditorSessions: U.authz.createInMemoryAuditorSessionMinter().minter,
    notifier: U.authz.createInMemoryComplianceNotifier().notifier,
    effectivePermissions: resolver.resolver,
    audit: U.identity.createInMemoryAuditExecutor().executor,
    cosignPolicy: async () => false,
    ...(bridge
      ? {
          mePermissionsBridge: bridge,
          // index.ts: the uncached resolution the shadow uses to explain a difference.
          freshPermissions: async ({ organizationId, userId }: { organizationId: string; userId: string }) =>
            new Set(
              U.resolveMod.resolveEffectivePermissions(await freshStore.loadGrants(organizationId, userId), Date.now())
                .permissions,
            ),
        }
      : {}),
  });
  return { app, bridge };
}

const actorHeaders = (a: { org: string; user: string; cls: string }) => ({
  "x-test-user": a.user,
  "x-test-org": a.org,
  "x-test-class": a.cls,
});
/** The fixture actors the bridge forwards (canonical UUIDs, every stamp present). */
const FORWARDABLE = ACTORS;

/** JSON paths whose values differ between two identical baseline requests (e.g. an error's correlationId). */
function volatilePaths(a: unknown, b: unknown, at = "", acc = new Set<string>()): Set<string> {
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) volatilePaths(ao[k], bo[k], `${at}/${k}`, acc);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) acc.add(at);
  return acc;
}
function maskPaths(body: string, paths: Set<string>): string {
  if (!paths.size) return body;
  try {
    const j = JSON.parse(body);
    for (const path of paths) {
      const parts = path.split("/").slice(1);
      let o = j;
      for (const k of parts.slice(0, -1)) o = o?.[k];
      const last = parts.at(-1);
      if (o && typeof o === "object" && last !== undefined && last in o) o[last] = "<volatile>";
    }
    return JSON.stringify(j);
  } catch {
    return body;
  }
}

function normalisedBody(body: string) {
  try {
    const j = JSON.parse(body);
    if (j && Array.isArray(j.permissions)) return JSON.stringify({ ...j, permissions: [...j.permissions].sort() });
    return JSON.stringify(j);
  } catch {
    return body;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Phases

async function setup() {
  const { admin } = urls();
  const sql = new SQL(admin);
  const [db] = await sql`SELECT current_database() AS name, shobj_description(oid, 'pg_database') AS comment
                         FROM pg_database WHERE datname = current_database()`;
  if (/prod|production|live|primary/i.test(db.name)) throw Error(`refusing database ${db.name}`);
  if (db.comment !== EPHEMERAL_MARKER) throw Error(`refusing database ${db.name}: not marked ${EPHEMERAL_MARKER}`);
  const others = await sql`SELECT datname FROM pg_database
                           WHERE datname NOT IN (current_database(), 'postgres', 'template0', 'template1')`;
  if (others.length) throw Error("refusing: the cluster holds other databases (this run changes cluster-wide roles)");
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`;
  check("upstream migrations applied", n > 100, { publicTables: n });

  const fixtures = readFileSync(join(root, "rust/crates/cw-server/tests/fixtures/m02.sql"), "utf8");
  await sql.begin(async (tx) => {
    await tx.unsafe(fixtures);
    await tx.unsafe(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${APP_PASSWORD}'`);
    // Stand-in for chartwarden_platform_login (created out of band in production): BYPASSRLS, SELECT on organization
    // only — the same shape upstream's m14-packet-build live suite uses.
    await tx.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${PLATFORM_ROLE}') THEN
                       CREATE ROLE ${PLATFORM_ROLE} LOGIN BYPASSRLS PASSWORD '${PLATFORM_PASSWORD}'; END IF; END $$;`);
    await tx.unsafe(`GRANT USAGE ON SCHEMA public TO ${PLATFORM_ROLE}`);
    await tx.unsafe(`GRANT SELECT ON organization TO ${PLATFORM_ROLE}`);
  });
  const [{ members }] = await sql`SELECT count(*)::int AS members FROM membership
                                  WHERE status = 'active' AND organization_id IN (SELECT id FROM organization WHERE status = 'active')`;
  check("fixtures seeded", members >= 10, { activeMembershipsInActiveOrgs: members });
  await sql.close();

  // A throwaway key pair for this run only (the run deletes the state directory at the end).
  mkdirSync(state, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const priv = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).toString("base64url");
  const pub = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  writeFileSync(join(state, "signing.key"), `${KID}=${priv}\n`, { mode: 0o600 });
  writeFileSync(join(state, "public-keys.env"), `CW_ACTOR_PUBLIC_KEYS=${KID}=${pub}\n`);
  check("throwaway signing key written", true, { kid: KID });
  finish();
}

async function rawGet(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`http://localhost${path}`, { unix: socketPath, headers } as RequestInit & { unix: string });
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get("content-type"), text };
}

async function socket() {
  const st = statSync(socketPath);
  const dir = statSync(resolve(socketPath, ".."));
  const ids = { uid: process.getuid?.(), gid: process.getgid?.() };
  try {
    const r = await rawGet("/health");
    check("uid 1000 (gid 1000) connects to the socket and /health answers 200", r.status === 200 && ids.uid === 1000, {
      ...ids,
      status: r.status,
      socketMode: (st.mode & 0o777).toString(8),
      socketOwner: `${st.uid}:${st.gid}`,
      dirMode: (dir.mode & 0o777).toString(8),
      dirOwner: `${dir.uid}:${dir.gid}`,
    });
  } catch (e) {
    check("uid 1000 (gid 1000) connects to the socket and /health answers 200", false, { ...ids, error: String(e) });
  }
  finish();
}

async function socketDeny() {
  const ids = { uid: process.getuid?.(), gid: process.getgid?.() };
  let outcome = "connected";
  try {
    await rawGet("/health");
  } catch (e) {
    outcome = (e as { code?: string }).code ?? String(e);
  }
  check("a uid outside gid 1000 cannot reach the socket", outcome !== "connected", { ...ids, outcome });
  finish();
}

async function e2e() {
  const U = await upstream();
  const { app, platform, admin } = urls();
  const appHandle = U.db.createDbClient({ connectionString: app, max: 4 });
  const platformHandle = U.db.createDbClient({ connectionString: platform, max: 2 });
  const adminSql = new SQL(admin);
  const extra: Record<string, unknown> = {};
  try {
    // ---- off by default (AT-M02-11) ----
    const def = U.bridge.parseRustBridgeConfig({});
    check("bridge and sweep are off with no RUST_* settings", def.routes.size === 0 && !def.sweepEnabled && !def.signingKey, {
      routes: def.routes.size,
      sweepEnabled: def.sweepEnabled,
    });

    // ---- AT-M02-05b: client-visible responses, off vs shadow vs serve ----
    const servers = { off: buildApp(U, appHandle.db, "off"), off2: buildApp(U, appHandle.db, "off"), shadow: buildApp(U, appHandle.db, "shadow"), serve: buildApp(U, appHandle.db, "serve") };
    const unauth = [
      { name: "no session", headers: {} },
      { name: "session without an org", headers: { "x-test-user": u(1) } },
    ];
    const cases = [
      ...FORWARDABLE.map((a) => ({ name: a.name, headers: actorHeaders(a) as Record<string, string> })),
      ...unauth.map((c) => ({ name: c.name, headers: c.headers as Record<string, string> })),
    ];
    const hit = async (s: Built, headers: Record<string, string>) => {
      const r = await s.app.inject({ method: "GET", url: PATH, headers });
      return { status: r.statusCode, headers: r.headers, body: normalisedBody(r.body) };
    };
    // Headers and body fields that differ between two identical `off` requests (dates, request and correlation ids)
    // are volatile, not a difference. Both are calibrated from the baseline, never assumed.
    // `date` is the clock second (RFC 9110 §6.6.1): volatile by definition, whether or not calibration crossed a second.
    const volatile = new Set<string>(["date"]);
    const volatileBody = new Set<string>();
    for (const c of cases) {
      const [a, b] = [await hit(servers.off, c.headers), await hit(servers.off2, c.headers)];
      for (const k of new Set([...Object.keys(a.headers), ...Object.keys(b.headers)]))
        if (String(a.headers[k]) !== String(b.headers[k])) volatile.add(k);
      try {
        volatilePaths(JSON.parse(a.body), JSON.parse(b.body), "", volatileBody);
      } catch {
        if (a.body !== b.body) volatileBody.add("");
      }
    }
    extra.volatileHeaders = [...volatile].sort();
    extra.volatileBodyPaths = [...volatileBody].sort();
    const rows = [];
    for (const c of cases) {
      const base = await hit(servers.off, c.headers);
      for (const mode of ["shadow", "serve"] as const) {
        const r = await hit(servers[mode], c.headers);
        const hdiff = [...new Set([...Object.keys(base.headers), ...Object.keys(r.headers)])].filter(
          (k) => !volatile.has(k) && String(base.headers[k]) !== String(r.headers[k]),
        );
        const sameBody = maskPaths(base.body, volatileBody) === maskPaths(r.body, volatileBody);
        rows.push({ case: c.name, mode, status: [base.status, r.status], same: base.status === r.status && sameBody && hdiff.length === 0, headerDiffs: hdiff, sameBody });
      }
    }
    const bad = rows.filter((r) => !r.same);
    check("AT-M02-05b: status, headers and body identical off/shadow/serve (modulo set order), incl. 401 paths", bad.length === 0, {
      comparisons: rows.length,
      differing: bad,
      unauthStatuses: rows.filter((r) => unauth.some((x) => x.name === r.case)).map((r) => `${r.case}:${r.status.join("/")}`),
    });
    await until(() => (servers.shadow.bridge?.inFlight() ?? 0) === 0, 5_000);
    await sleep(200);
    const sh = servers.shadow.bridge?.stats() ?? ({} as Record<string, unknown>);
    check("shadow: every forwarded request matched Rust (no unexplained, no rust_error)", sh.unexplained === 0 && sh.rustError === 0 && Number(sh.match) + Number(sh.staleCache) === FORWARDABLE.length, sh);
    const sv = servers.serve.bridge?.stats() ?? ({ fallback: {} } as Record<string, unknown> & { fallback: Record<string, number> });
    check("serve: Rust answered every forwarded request (no fallback)", sv.served === FORWARDABLE.length && Object.keys(sv.fallback).length === 0, sv);
    for (const s of Object.values(servers)) {
      s.bridge?.close();
      await s.app.close();
    }

    // ---- AT-M02-11: the parity sweep, end to end ----
    const config = U.bridge.parseRustBridgeConfig({ RUST_PARITY_SWEEP: "on", RUST_SOCKET: socketPath, CW_ACTOR_SIGNING_KEY: signingEnv() });
    const signer = U.bridge.createAssertionSigner(config.signingKey);
    const realClient = U.bridge.createRustClient(socketPath, config.timeoutMs);
    U.tenancy.registerPlatformJob(U.bridge.RUST_PARITY_SWEEP_JOB_ID);
    let audited = 0;
    const orgs = U.enumerator.buildActiveOrgEnumerator({
      platformDb: platformHandle.db,
      // Production passes m34PlatformBypassAuditor (one platform.bypass_invoked row); its write is covered upstream.
      auditBypass: async () => {
        audited++;
      },
      jobId: U.bridge.RUST_PARITY_SWEEP_JOB_ID,
      reason: "CW-RUST-M02 local stack",
    });
    const members = U.bridge.createSweepMembershipReader(appHandle.db);
    const freshStore = U.store.createDbEffectivePermissionStore(appHandle.db);
    const fresh = async (org: string, user: string) => [
      ...U.resolveMod.resolveEffectivePermissions(await freshStore.loadGrants(org, user), Date.now()).permissions,
    ];
    let inFlight = 0;
    let maxInFlight = 0;
    const counted = (inner: { get: (p: string, a: string) => Promise<unknown> }) => ({
      get: async (p: string, a: string) => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        try {
          return await inner.get(p, a);
        } finally {
          inFlight--;
        }
      },
    });
    const sweep = (name: string, over: Record<string, unknown>) => {
      const logger = capture(`rust-parity-sweep:${name}`);
      const before = logLines.length;
      return U.bridge
        .runParitySweep({
          listActiveOrgs: () => orgs.listActiveOrgs(),
          listActiveMembers: members.listActiveMembers,
          countActiveMembers: members.countActiveMembers,
          freshPermissions: fresh,
          signer,
          client: counted(realClient),
          logger,
          runId: `local-${name}`,
          ...over,
        })
        .then((s: Record<string, unknown>) => ({ s, lines: logLines.slice(before) }));
    };
    const [{ expected }] = await adminSql`SELECT count(*)::int AS expected FROM membership m JOIN organization o ON o.id = m.organization_id
                                          WHERE m.status = 'active' AND o.status = 'active'`;

    const clean = await sweep("clean", {});
    const last = JSON.parse(clean.lines.at(-1) ?? "{}");
    check("sweep: every active membership compared, count reconciled, complete, all match", last.outcome === "summary" && clean.s.compared === expected && clean.s.listed === clean.s.counted && clean.s.match === clean.s.compared && clean.s.unexplained === 0 && clean.s.abandoned === 0, {
      expectedActiveMemberships: expected,
      ...clean.s,
      auditedEnumerations: audited,
    });
    check("sweep: never more than 2 Rust calls in flight", maxInFlight <= 2 && maxInFlight >= 1, { maxInFlight });

    // A planted Rust defect: one membership's Rust body gains a key Bun does not confer.
    const planted = { org: A, user: u(1), key: "audit.read" };
    const defective = {
      get: async (p: string, a: string) => {
        const r = (await realClient.get(p, a)) as { ok: boolean; body?: { permissions: string[] } };
        const claims = JSON.parse(Buffer.from(a.split(".")[1] as string, "base64url").toString());
        if (r.ok && r.body && claims.org === planted.org && claims.sub === planted.user)
          return { ...r, body: { permissions: [...r.body.permissions, planted.key] } };
        return r;
      },
    };
    const def2 = await sweep("planted", { client: counted(defective) });
    const un = def2.lines.map((l: string) => JSON.parse(l)).filter((l: Record<string, unknown>) => l.outcome === "unexplained");
    check("sweep: a planted Rust defect is `unexplained`, logged with ids and counts only", def2.s.unexplained === 1 && un.length === 1 && un[0].org_id === planted.org && un[0].user_id === planted.user && un[0].only_rust === 1 && !def2.lines.join("\n").includes(planted.key), {
      unexplained: def2.s.unexplained,
      line: un[0],
    });

    // A real grant change between the two reads: Bun reads first, the grant is committed, then Rust reads.
    const race = { org: A, user: u(2), membership: "f0000000-0000-4000-8003-0000000002a0", role: "f0000000-0000-4000-8001-0000000000a1" };
    let release: () => void = () => {};
    const committed = new Promise<void>((r) => {
      release = r;
    });
    let bunFirst = true;
    let rustFirst = true;
    const raceFresh = async (org: string, user: string) => {
      const v = await fresh(org, user);
      if (org === race.org && user === race.user && bunFirst) {
        bunFirst = false;
        await adminSql`INSERT INTO membership_role (organization_id, membership_id, role_id, expires_at)
                       VALUES (${race.org}, ${race.membership}, ${race.role}, NULL)`;
        release();
      }
      return v;
    };
    const raceClient = {
      get: async (p: string, a: string) => {
        const claims = JSON.parse(Buffer.from(a.split(".")[1] as string, "base64url").toString());
        if (claims.org === race.org && claims.sub === race.user && rustFirst) {
          rustFirst = false;
          await committed;
        }
        return realClient.get(p, a);
      },
    };
    try {
      const r3 = await sweep("race", { freshPermissions: raceFresh, client: counted(raceClient) });
      const raced = r3.lines.map((l: string) => JSON.parse(l)).filter((l: Record<string, unknown>) => l.outcome === "explained:race");
      check("sweep: a grant changed between reads is `explained:race`, not unexplained", r3.s.explainedRace === 1 && r3.s.unexplained === 0 && raced[0]?.user_id === race.user, {
        explainedRace: r3.s.explainedRace,
        unexplained: r3.s.unexplained,
      });
    } finally {
      await adminSql`DELETE FROM membership_role WHERE membership_id = ${race.membership} AND role_id = ${race.role}`;
    }

    // Rust refuses a sweep assertion anywhere but GET /api/v1/me/permissions.
    const sweepToken = (pth: string, mth = "GET") =>
      signer.sign({ userId: u(1), organizationId: A, sessionId: "local-fence", sessionClass: U.bridge.SWEEP_CLASS, requestId: `fence-${pth}`, method: mth, path: pth });
    const onRoute = await rawGet(PATH, { "x-cw-actor-assertion": sweepToken(PATH) });
    const boundElsewhere = await rawGet(PATH, { "x-cw-actor-assertion": sweepToken("/api/v1/patients") });
    const otherPath = await rawGet("/api/v1/patients", { "x-cw-actor-assertion": sweepToken("/api/v1/patients") });
    check("Rust: a sweep assertion reads permissions on its one route", onRoute.status === 200, { status: onRoute.status });
    check("Rust: a sweep assertion bound to another path is refused", boundElsewhere.status !== 200 && !boundElsewhere.text.includes("permissions"), {
      status: boundElsewhere.status,
    });
    check("Rust: no other path serves anything to a sweep assertion", otherPath.status === 404 && !otherPath.text.includes("permissions"), {
      status: otherPath.status,
      note: "Rust authenticates only on GET /api/v1/me/permissions; the SweepNotAllowed branch itself is unit-tested in cw-actor",
    });
  } finally {
    await adminSql.close();
    await appHandle.close();
    await platformHandle.close();
  }
  finish(extra);
}

/** AT-M02-09 — run.sh has STOPPED the rust container. Serve mode must answer from Bun, counting fallback:connect. */
async function fallbackStopped() {
  const U = await upstream();
  const { app } = urls();
  const h = U.db.createDbClient({ connectionString: app, max: 4 });
  try {
    const off = buildApp(U, h.db, "off");
    const serve = buildApp(U, h.db, "serve");
    const tOff: number[] = [];
    const tServe: number[] = [];
    let wrong = 0;
    for (let round = 0; round < 5; round++) {
      for (const a of FORWARDABLE) {
        let t = performance.now();
        const b = await off.app.inject({ method: "GET", url: PATH, headers: actorHeaders(a) });
        tOff.push(performance.now() - t);
        t = performance.now();
        const s = await serve.app.inject({ method: "GET", url: PATH, headers: actorHeaders(a) });
        tServe.push(performance.now() - t);
        if (s.statusCode !== b.statusCode || normalisedBody(s.body) !== normalisedBody(b.body)) wrong++;
      }
    }
    const st = serve.bridge?.stats() ?? ({ fallback: {} } as { fallback: Record<string, number> });
    const total = FORWARDABLE.length * 5;
    check("AT-M02-09: with Rust stopped every request answers Bun's body", wrong === 0, { requests: total, wrong });
    check("AT-M02-09: fallback:connect increments (then the circuit opens)", (st.fallback.connect ?? 0) >= 1 && (st.fallback.connect ?? 0) + (st.fallback.circuit_open ?? 0) === total, {
      fallback: st.fallback,
    });
    const d = { offP50: round(median(tOff)), offP99: round(pct(tOff, 99)), serveP50: round(median(tServe)), serveP99: round(pct(tServe, 99)) };
    check("AT-M02-09: latency stays Bun's plus connection-refused time (p99 within +20 ms)", d.serveP99 - d.offP99 <= 20, d);
    serve.bridge?.close();
    await off.app.close();
    await serve.app.close();
  } finally {
    await h.close();
  }
  finish();
}

/** After run.sh restarts rust: a fresh serve bridge (closed circuit) is answered by Rust again. */
async function fallbackRecovered() {
  const U = await upstream();
  const { app } = urls();
  const h = U.db.createDbClient({ connectionString: app, max: 4 });
  try {
    const serve = buildApp(U, h.db, "serve");
    for (const a of FORWARDABLE) await serve.app.inject({ method: "GET", url: PATH, headers: actorHeaders(a) });
    const st = serve.bridge?.stats() ?? ({ fallback: {} } as Record<string, unknown> & { fallback: Record<string, number> });
    check("AT-M02-09: after Rust restarts, serve is answered by Rust again", st.served === FORWARDABLE.length && Object.keys(st.fallback).length === 0, st);
    serve.bridge?.close();
    await serve.app.close();
  } finally {
    await h.close();
  }
  finish();
}

/** AT-M02-10 — run.sh has PAUSED the rust container (accepts connections, never answers). */
async function shadowStalled() {
  const U = await upstream();
  const { app } = urls();
  const h = U.db.createDbClient({ connectionString: app, max: 8 });
  const ROUNDS = 9;
  const N = 1_000;
  try {
    const off = buildApp(U, h.db, "off");
    const control = buildApp(U, h.db, "off"); // A/A control: identical to `off`, measures the machine's own noise
    const shadow = buildApp(U, h.db, "shadow");
    const offUrl = await off.app.listen({ port: 0, host: "127.0.0.1" });
    const ctlUrl = await control.app.listen({ port: 0, host: "127.0.0.1" });
    const shUrl = await shadow.app.listen({ port: 0, host: "127.0.0.1" });
    let maxInFlight = 0;
    const sampler = setInterval(() => {
      maxInFlight = Math.max(maxInFlight, shadow.bridge?.inFlight() ?? 0);
    }, 1);
    // The load runs in a separate process (verification/src/m02-load.ts) so client work never shares the server's
    // event loop.
    const cases = [];
    for (const a of FORWARDABLE) {
      const r = await off.app.inject({ method: "GET", url: PATH, headers: actorHeaders(a) });
      cases.push({ headers: actorHeaders(a), expect: `${r.statusCode}:${normalisedBody(r.body)}` });
    }
    mkdirSync(state, { recursive: true });
    const expectedFile = join(state, "load-expected.json");
    writeFileSync(expectedFile, JSON.stringify(cases));
    let wrong = 0;
    const burst = async (base: string) => {
      const p = Bun.spawn(["bun", "run", join(import.meta.dir, "m02-load.ts"), base, String(N), expectedFile], {
        stdout: "pipe",
        stderr: "inherit",
      });
      const text = await new Response(p.stdout).text();
      if ((await p.exited) !== 0) throw Error("load generator failed");
      const r = JSON.parse(text.trim().split("\n").at(-1) as string) as { p99: number; wrong: number; times: number[] };
      wrong += r.wrong;
      return r;
    };
    for (const url of [offUrl, ctlUrl, shUrl]) await burst(url); // warm-up
    const sides = { off: { url: offUrl, p99: [] as number[], all: [] as number[] }, control: { url: ctlUrl, p99: [] as number[], all: [] as number[] }, shadow: { url: shUrl, p99: [] as number[], all: [] as number[] } };
    const order = ["off", "control", "shadow"] as const;
    // Rotate the order every round, so drift (thermal, GC, other load) and position effects hit every side alike.
    for (let r = 0; r < ROUNDS; r++) {
      for (let k = 0; k < order.length; k++) {
        const side = sides[order[(r + k) % order.length] as (typeof order)[number]];
        const res = await burst(side.url);
        side.p99.push(res.p99);
        side.all.push(...res.times);
      }
    }
    await until(() => (shadow.bridge?.inFlight() ?? 0) === 0, 5_000);
    clearInterval(sampler);
    const st = shadow.bridge?.stats() ?? ({} as Record<string, unknown>);
    const pooled = { off: round(pct(sides.off.all, 99)), control: round(pct(sides.control.all, 99)), shadow: round(pct(sides.shadow.all, 99)) };
    const added = round(pooled.shadow - pooled.off);
    const noise = round(Math.abs(pooled.control - pooled.off));
    const d = { rounds: ROUNDS, requestsPerRound: N, pooledP99: pooled, addedByShadow: added, aaNoise: noise, perRoundP99: { off: sides.off.p99.map(round), control: sides.control.p99.map(round), shadow: sides.shadow.p99.map(round) } };
    check("AT-M02-10: with Rust stalled, every response is Bun's answer", wrong === 0, { wrong, requests: N * (ROUNDS + 1) * 3 });
    // Pass needs the added p99 within 5 ms AND a machine quiet enough to resolve 5 ms (A/A noise below it).
    check(noise > 5 ? "AT-M02-10: p99 inconclusive — this machine's A/A noise exceeds 5 ms" : "AT-M02-10: no added p99 latency beyond 5 ms (pooled p99, A/A-controlled)", added <= 5 && noise <= 5, d);
    check("AT-M02-10: in-flight shadows never exceed 8", maxInFlight <= 8, { maxInFlight });
    check("AT-M02-10: drops are counted", Number(st.dropped) > 0, { dropped: st.dropped, rustError: st.rustError, match: st.match });
    await control.app.close();
    shadow.bridge?.close();
    await off.app.close();
    await shadow.app.close();
  } finally {
    await h.close();
  }
  finish();
}

/** AT-M02-08 / AT-M02-11 — no permission key and no assertion in any log line of this run (bridge, sweep, Rust). */
async function logs() {
  const { admin } = urls();
  const sql = new SQL(admin);
  const keys: string[] = (await sql`SELECT key FROM permission`).map((r: { key: string }) => r.key);
  await sql.close();
  const files = readdirSync(out).filter((f) => f.endsWith(".log"));
  const hits: Record<string, string[]> = {};
  let lines = 0;
  // An assertion is a compact JWS whose header is base64url JSON: it starts with "eyJ".
  const jws = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
  for (const f of files) {
    for (const line of readFileSync(join(out, f), "utf8").split("\n")) {
      if (!line) continue;
      lines++;
      const found = keys.filter((k) => new RegExp(`(^|[^a-z0-9_.])${k.replaceAll(".", "\\.")}([^a-z0-9_.]|$)`).test(line));
      if (jws.test(line)) found.push("<assertion>");
      if (found.length) (hits[f] ??= []).push(...found);
    }
  }
  check("no permission key and no assertion in any bridge, sweep or Rust log line", Object.keys(hits).length === 0, {
    files,
    lines,
    permissionKeysChecked: keys.length,
    hits,
  });
  check("the Rust container log was captured", files.includes("rust.log") && statSync(join(out, "rust.log")).size > 0, {});

  // Roll every phase into one summary.
  const phases = ["setup", "socket", "socket-deny", "e2e", "bridge-runtime", "fallback-stopped", "fallback-recovered", "shadow-stalled"];
  const summary = phases.map((p) => {
    const f = join(out, `${p}.json`);
    if (!existsSync(f)) return { phase: p, ran: false, failed: null };
    const j = JSON.parse(readFileSync(f, "utf8"));
    const failed = typeof j.failed === "number" ? j.failed : (j.results ?? []).filter((r: { ok: boolean }) => !r.ok).length;
    return { phase: p, ran: true, failed };
  });
  for (const p of summary) check(`phase ${p.phase} ran and passed`, p.ran && p.failed === 0, p);
  finish({ summary });
}

const phases: Record<string, () => Promise<void>> = {
  setup,
  socket,
  "socket-deny": socketDeny,
  e2e,
  "fallback-stopped": fallbackStopped,
  "fallback-recovered": fallbackRecovered,
  "shadow-stalled": shadowStalled,
  logs,
};
if (import.meta.main) {
  const run = phases[phase];
  if (!run) {
    console.error(`unknown phase '${phase}'. One of: ${Object.keys(phases).join(", ")}`);
    process.exit(2);
  }
  try {
    await run();
  } catch (e) {
    check(`phase ${phase} completed without an exception`, false, { error: (e as Error)?.stack ?? String(e) });
    finish();
  }
  // Open pools, timers or sockets from upstream modules must not keep a phase alive.
  process.exit(process.exitCode ?? 0);
}
