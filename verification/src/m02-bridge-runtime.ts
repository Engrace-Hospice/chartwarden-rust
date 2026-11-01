/**
 * CW-RUST-M02 P1 — runtime check of upstream's Bun→Rust client against misbehaving Unix-socket servers (review P1-4).
 *
 *   bun run verify:m02-bridge-runtime --source <upstream checkout>
 *
 * Unit tests inject `fetch`; this runs upstream's real `createRustClient` and `createMePermissionsBridge` under Bun's
 * real Unix-socket fetch, against raw socket servers that:
 *   1. accept and never answer               → `timeout` within budget, connection closed
 *   2. send headers, part of a body, stall   → `timeout` within budget, connection closed
 *   3. stream an endless chunked body        → `bad_json` (byte cap) well before the timeout, connection closed
 *   4. close at once                         → `connect`/`bad_json`, never a throw
 *   5. no socket file                        → `connect`
 * and checks that serve mode answers from Bun in each case, with no unhandled rejection. Exit 1 on any failure.
 *
 * "Connection closed" means the server saw the socket close. It does not prove which side closed it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonical } from "./test-discovery";

const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const TIMEOUT_MS = 300;
const BUDGET_MS = TIMEOUT_MS + 250;

type Behaviour = "silent" | "stall-body" | "endless" | "close";

function serve(path: string, behaviour: Behaviour) {
  const state = { opened: 0, closed: 0 };
  const server = Bun.listen<{ timer?: ReturnType<typeof setInterval> }>({
    unix: path,
    socket: {
      open(s) {
        state.opened++;
        s.data = {};
        if (behaviour === "close") s.end();
      },
      data(s) {
        if (behaviour === "stall-body") {
          s.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n");
          s.write('f\r\n{"permissions":\r\n');
        }
        if (behaviour === "endless") {
          s.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n");
          const chunk = `4000\r\n${"a".repeat(0x4000)}\r\n`;
          s.data.timer = setInterval(() => { if (s.write(chunk) < 0) clearInterval(s.data.timer); }, 1);
        }
      },
      close(s) {
        state.closed++;
        if (s.data?.timer) clearInterval(s.data.timer);
      },
      error() {},
    },
  });
  return { state, stop: () => server.stop(true) };
}

async function main() {
  const source = flag("--source");
  if (!source) throw Error("Usage: verify:m02-bridge-runtime --source <upstream checkout>");
  const base = resolve(source, "apps/backend/src/bootstrap/rust-bridge");
  const { createRustClient } = await import(join(base, "client.ts"));
  const { createMePermissionsBridge } = await import(join(base, "forwarder.ts"));
  const { parseRustBridgeConfig } = await import(join(base, "config.ts"));

  let unhandled = 0;
  process.on("unhandledRejection", () => { unhandled++; });

  const dir = mkdtempSync(join(tmpdir(), "cw-m02-rt-"));
  const key = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 5)]).toString("base64url");
  const results: Record<string, unknown>[] = [];
  let failed = 0;
  const check = (name: string, ok: boolean, detail: Record<string, unknown>) => {
    results.push({ name, ok, ...detail });
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"}  ${name}  ${JSON.stringify(detail)}`);
  };
  const actor = { userId: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222", sessionId: "s", sessionClass: "staff", requestId: "r" };
  const signer = { sign: () => "h.p.s" };
  const logger = { info() {}, warn() {} };

  const cases: [Behaviour | "missing", string[], number][] = [
    ["silent", ["timeout"], BUDGET_MS],
    ["stall-body", ["timeout"], BUDGET_MS],
    ["endless", ["bad_json"], BUDGET_MS],
    ["close", ["connect", "bad_json"], BUDGET_MS],
    ["missing", ["connect"], BUDGET_MS],
  ];
  for (const [behaviour, expected, budget] of cases) {
    const path = join(dir, `${behaviour}.sock`);
    const srv = behaviour === "missing" ? undefined : serve(path, behaviour);
    const client = createRustClient(path, TIMEOUT_MS);
    const t0 = performance.now();
    const r = await client.get("/api/v1/me/permissions", "h.p.s");
    const ms = Math.round(performance.now() - t0);
    await Bun.sleep(100); // let the server observe the connection closing (either side)
    const connectionClosed = srv ? srv.state.closed === srv.state.opened && srv.state.opened > 0 : true;
    check(`client vs ${behaviour}`, !r.ok && expected.includes(r.reason) && ms <= budget && connectionClosed, {
      result: r.ok ? "ok" : r.reason, ms, budget, connections: srv?.state,
    });

    const bridge = createMePermissionsBridge({
      config: parseRustBridgeConfig({ RUST_ROUTES: "me-permissions", RUST_ROUTE_MODE: "serve", RUST_SOCKET: path, CW_ACTOR_SIGNING_KEY: `k=${key}` }),
      signer, client, logger,
    });
    const t1 = performance.now();
    const body = await bridge.handle({ actor, bun: async () => ({ permissions: ["BUN"] }), fresh: async () => ({ permissions: ["BUN"] }), afterResponse: () => {} });
    const ms2 = Math.round(performance.now() - t1);
    check(`serve falls back vs ${behaviour}`, JSON.stringify(body) === '{"permissions":["BUN"]}' && ms2 <= budget, { ms: ms2, fallback: bridge.stats().fallback });
    bridge.close();
    srv?.stop();
  }
  await Bun.sleep(100);
  check("no unhandled rejections", unhandled === 0, { unhandled });
  rmSync(dir, { recursive: true, force: true });

  const out = resolve(import.meta.dir, "../output/m02");
  await Bun.write(join(out, "bridge-runtime.json"), canonical({ check: "AT-M02-09/10 runtime (Bun Unix-socket fetch)", bun: Bun.version, timeoutMs: TIMEOUT_MS, results }));
  console.log(`\n${results.length} checks, ${failed} failed. Evidence: ${join(out, "bridge-runtime.json")}`);
  if (failed) process.exitCode = 1;
}
if (import.meta.main) await main();
