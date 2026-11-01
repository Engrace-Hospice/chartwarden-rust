/**
 * CW-RUST-M02 AT-M02-05 — parity between upstream's real resolver and the Rust server, on one seeded database.
 *
 *   bun run verify:m02-parity --source <upstream checkout with node_modules> \
 *     --admin-url postgres://postgres@localhost:5433/chartwarden_catalog --rust-bin rust/target/debug/cw-server
 *
 * Bun side: upstream's own code, unmodified. `createDbEffectivePermissionStore` + `createEffectivePermissionResolver`
 * (a fresh instance, so its cache is empty) is exactly what `GET /api/v1/me/permissions` calls
 * (`modules/03-authorization/index.ts:219`), connected as `chartwarden_app`.
 * Rust side: the real `cw-server` binary over HTTP on loopback, with assertions signed here by a throwaway
 * Ed25519 key. Both read the same fixtures (`rust/crates/cw-server/tests/fixtures/m02.sql`).
 *
 * Not covered here, by design: Bun's authentication and the client-visible HTTP response (AT-M02-05b, P1).
 */
import { type KeyObject, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import { canonical, sha256 } from "./test-discovery";

const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const root = resolve(import.meta.dir, "../..");
const PATH = "/api/v1/me/permissions";
const APP_PASSWORD = "chartwarden_app_live_test";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const A = "f0000000-0000-4000-8000-00000000000a";
const B = "f0000000-0000-4000-8000-00000000000b";
const u = (n: number) => `f0000000-0000-4000-8002-${String(n).padStart(12, "0")}`;

/** Every fixture actor, plus session-class variants (upstream's route ignores the class; Rust must too). */
export const ACTORS: { name: string; org: string; user: string; cls: string }[] = [
  { name: "multi-org staff in A", org: A, user: u(1), cls: "staff" },
  { name: "multi-org staff in B", org: B, user: u(1), cls: "staff" },
  { name: "disabled role", org: A, user: u(2), cls: "staff" },
  { name: "expired + future grants", org: A, user: u(3), cls: "staff" },
  { name: "suspended membership", org: A, user: u(4), cls: "staff" },
  { name: "revoked membership", org: A, user: u(5), cls: "staff" },
  { name: "platform-owned role", org: A, user: u(6), cls: "staff" },
  { name: "reserved tenant rows", org: A, user: u(7), cls: "staff" },
  { name: "no membership", org: A, user: u(8), cls: "staff" },
  { name: "pending membership", org: A, user: u(9), cls: "staff" },
  { name: "no membership in B", org: B, user: u(2), cls: "staff" },
  { name: "unknown org", org: "f0000000-0000-4000-8000-0000000dead0", user: u(1), cls: "staff" },
  { name: "portal session, no membership", org: A, user: u(8), cls: "portal_caregiver" },
  { name: "portal class on a staff user", org: A, user: u(1), cls: "portal_patient" },
];

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function assertion(key: KeyObject, a: (typeof ACTORS)[number]) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "EdDSA", kid: "parity", typ: "JWT" }));
  const p = b64u(JSON.stringify({
    iss: "cw-bun", aud: "cw-rust", sub: a.user, org: a.org, sid: "parity-session", cls: a.cls,
    mth: "GET", pth: PATH, rid: `parity-${randomBytes(4).toString("hex")}`, jti: b64u(randomBytes(16)), iat: now, exp: now + 30,
  }));
  return `${h}.${p}.${b64u(sign(null, Buffer.from(`${h}.${p}`), key))}`;
}

function bodyIsValid(v: unknown): v is { permissions: string[] } {
  if (!v || typeof v !== "object" || Object.keys(v).length !== 1) return false;
  const p = (v as { permissions?: unknown }).permissions;
  return Array.isArray(p) && p.every((x) => typeof x === "string") && new Set(p).size === p.length;
}

async function main() {
  const source = flag("--source"), adminUrl = flag("--admin-url"), rustBin = flag("--rust-bin");
  if (!source || !adminUrl || !rustBin) throw Error("Usage: verify:m02-parity --source <upstream> --admin-url <loopback url> --rust-bin <cw-server>");
  const url = new URL(adminUrl);
  if (!LOOPBACK.has(url.hostname)) throw Error(`refusing non-loopback database ${url.hostname}`);
  const appUrl = new URL(adminUrl);
  appUrl.username = "chartwarden_app";
  appUrl.password = APP_PASSWORD;

  // 1. Seed (same SQL as the Rust live tests) and let chartwarden_app log in.
  const admin = new SQL(adminUrl);
  const fixtures = readFileSync(join(root, "rust/crates/cw-server/tests/fixtures/m02.sql"), "utf8");
  await admin.begin(async (tx) => {
    await tx.unsafe(fixtures);
    await tx.unsafe(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${APP_PASSWORD}'`);
  });
  await admin.close();

  // 2. Upstream's resolver, unmodified, as chartwarden_app.
  const { createDbClient } = await import(join(source, "packages/db/src/client.ts"));
  const { createDbEffectivePermissionStore } = await import(join(source, "packages/auth/src/rbac/drizzle-store.ts"));
  const { createEffectivePermissionResolver } = await import(join(source, "packages/auth/src/rbac/resolve.ts"));
  const handle = createDbClient({ connectionString: appUrl.toString(), max: 2 });
  const upstream = createEffectivePermissionResolver(createDbEffectivePermissionStore(handle.db));

  // 3. The Rust binary on loopback.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  const port = 18000 + Math.floor(Math.random() * 1000);
  const proc = Bun.spawn([resolve(rustBin)], {
    env: { PATH: process.env.PATH ?? "", DATABASE_URL: appUrl.toString(), CW_ACTOR_PUBLIC_KEYS: `parity=${x}`, CW_RUST_TCP: `127.0.0.1:${port}`, RUST_LOG: "warn" },
    stdout: "ignore", stderr: "pipe",
  });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`${base}/health`)).ok; } catch { await Bun.sleep(100); }
  }
  if (!up) { proc.kill(); throw Error(`cw-server did not start: ${await new Response(proc.stderr).text()}`); }

  const results = [];
  let diffs = 0;
  try {
    for (const a of ACTORS) {
      const bunSet = [...(await upstream.resolver({ organizationId: a.org, userId: a.user }))].sort();
      const res = await fetch(`${base}${PATH}`, { headers: { "x-cw-actor-assertion": assertion(privateKey, a) } });
      const contentType = res.headers.get("content-type");
      const json = await res.json().catch(() => null);
      const valid = res.status === 200 && contentType === "application/json" && bodyIsValid(json);
      const rustSet = valid ? [...json.permissions].sort() : null;
      const rustSorted = valid && JSON.stringify(json.permissions) === JSON.stringify(rustSet);
      const match = valid && rustSorted && JSON.stringify(bunSet) === JSON.stringify(rustSet);
      if (!match) diffs++;
      results.push({ actor: a.name, org: a.org, user: a.user, cls: a.cls, status: res.status, contentType, bodyValid: valid, rustSorted, bun: bunSet, rust: rustSet, match });
    }
  } finally {
    proc.kill();
    await handle.close();
  }

  // The web client's only consumer: `(res.data?.permissions ?? []).includes("role.manage")`
  // (apps/web/src/modules/03-authorization/roles-permissions.tsx:60), which is order-insensitive.
  const config = JSON.parse(readFileSync(join(root, "verification/config.json"), "utf8"));
  const report = {
    check: "AT-M02-05", upstreamCommit: config.upstream.ref, fixturesSha256: sha256(fixtures),
    actors: results.length, diffs, results,
  };
  const out = join(root, "verification/output/m02");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "parity.json"), canonical(report));
  for (const r of results) console.log(`${r.match ? "match" : "DIFF "}  ${r.actor.padEnd(32)} bun=${JSON.stringify(r.bun)} rust=${JSON.stringify(r.rust)}`);
  console.log(`\n${results.length} actors, ${diffs} diffs. Evidence: ${join(out, "parity.json")}`);
  if (diffs) process.exitCode = 1;
}
if (import.meta.main) await main();
