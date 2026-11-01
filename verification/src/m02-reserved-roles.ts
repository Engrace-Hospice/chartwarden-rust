/**
 * CW-RUST-M02 — keep Rust's reserved-platform-role data identical to upstream.
 *
 *   bun run verify:m02-reserved --source <upstream checkout>            # check (exit 1 on drift)
 *   bun run verify:m02-reserved --source <upstream checkout> --write    # regenerate
 *
 * Rust ports the LOGIC of `roleConfersKey` (packages/auth/src/roles/platform-reserved.ts) and reads the DATA
 * from `rust/crates/cw-authz/reserved_platform_roles.json`. This script imports upstream's real exports and
 * compares them with that file. It also pins a SHA-256 of `platform-reserved.ts` itself: any edit upstream,
 * including a logic change the data comparison cannot see, fails the check until a human re-reviews the port.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const root = resolve(import.meta.dir, "../..");
const target = join(root, "rust/crates/cw-authz/reserved_platform_roles.json");

export async function generate(source: string) {
  const file = "packages/auth/src/roles/platform-reserved.ts";
  const reserved = await import(join(source, file));
  const templates = await import(join(source, "packages/auth/src/roles/templates.ts"));
  const config = JSON.parse(readFileSync(join(root, "verification/config.json"), "utf8"));
  return {
    generatedFrom: {
      repository: config.upstream.repository,
      commit: config.upstream.ref,
      file,
      sha256: createHash("sha256").update(readFileSync(join(source, file))).digest("hex"),
    },
    reservedPrefix: reserved.RESERVED_PLATFORM_ROLE_PREFIX as string,
    reservedKeys: [...(reserved.RESERVED_PLATFORM_ROLE_KEYS as readonly string[])].sort(),
    reservedCategory: reserved.RESERVED_PLATFORM_ROLE_CATEGORY as string,
    // Test data only: upstream's GAP-003 test asserts every platform-ops key is reserved.
    platformOpsRoleKeys: [...(templates.PLATFORM_OPS_ROLE_KEYS as readonly string[])].sort(),
  };
}

async function main() {
  const source = flag("--source");
  if (!source) throw Error("Usage: verify:m02-reserved --source <upstream checkout> [--write]");
  const fresh = JSON.stringify(await generate(resolve(source)), null, 2) + "\n";
  if (process.argv.includes("--write")) {
    writeFileSync(target, fresh);
    console.log(`wrote ${target}`);
    return;
  }
  const stored = readFileSync(target, "utf8");
  if (stored !== fresh) {
    console.error("reserved_platform_roles.json differs from upstream. Re-review the Rust port of roleConfersKey, then --write.");
    console.error(fresh);
    process.exitCode = 1;
    return;
  }
  console.log("reserved_platform_roles.json matches upstream");
}
if (import.meta.main) await main();
