/**
 * M00 AT-009 — test retention against a stored inventory.
 *
 *   verify:retention --discovery <test-results.json> [--update]
 *
 * `verification/baselines/test-inventory.jsonl` holds one JSON-encoded stable test ID per line (sorted;
 * JSON because upstream test names can contain newlines). Every ID in it
 * must still be discovered, or be covered by an entry in `verification/baselines/retirements.json`.
 * Counts alone are never compared, so swapping 50 tests for 50 unrelated ones fails.
 *
 * Retirement kinds (ADR-0060 invariant 1):
 *   - "replacement": a named successor test exists; both must have run green on the same commit.
 *   - "regulatory-correction": the old test asserted behaviour contradicting CMS/payer/clinical rules;
 *      requires the authoritative source, a replacement regression test, and a clinical/billing approver.
 *   - "rename": the same test under a new ID (successor required).
 * `--update` rewrites the stored inventory, and refuses while any removal is unexplained.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonical, sha256 } from "./test-discovery";

export type Retirement = {
  id: string;
  kind: "replacement" | "regulatory-correction" | "rename";
  successor?: string;
  reason: string;
  authority?: string; // e.g. "CMS Pub. 100-04 Ch. 11 §30.3" — required for regulatory-correction
  approvedBy: string[]; // e.g. ["engineering:…", "billing:…"]
  date: string;
};

export function validateRetirements(list: unknown): { retirements: Retirement[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(list)) return { retirements: [], errors: ["retirements.json must be an array"] };
  const seen = new Set<string>();
  for (const [i, r] of list.entries()) {
    const at = `retirement[${i}]`;
    if (!r || typeof r !== "object") { errors.push(`${at} is not an object`); continue; }
    const x = r as Partial<Retirement>;
    if (!x.id) errors.push(`${at} has no id`);
    if (x.id && seen.has(x.id)) errors.push(`${at} duplicates ${x.id}`);
    if (x.id) seen.add(x.id);
    if (!["replacement", "regulatory-correction", "rename"].includes(String(x.kind))) errors.push(`${at} (${x.id}) has invalid kind ${x.kind}`);
    if (!x.reason) errors.push(`${at} (${x.id}) has no reason`);
    if (!x.date || !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) errors.push(`${at} (${x.id}) needs an ISO date`);
    if (!Array.isArray(x.approvedBy) || !x.approvedBy.length) errors.push(`${at} (${x.id}) needs approvedBy`);
    if ((x.kind === "replacement" || x.kind === "rename" || x.kind === "regulatory-correction") && !x.successor) errors.push(`${at} (${x.id}) needs a successor test id`);
    if (x.kind === "regulatory-correction") {
      if (!x.authority) errors.push(`${at} (${x.id}) regulatory-correction needs an authoritative source`);
      if (!(x.approvedBy ?? []).some((a) => /^(clinical|billing|compliance):/.test(a))) errors.push(`${at} (${x.id}) regulatory-correction needs a clinical:, billing: or compliance: approver`);
    }
  }
  return { retirements: errors.length ? [] : (list as Retirement[]), errors };
}

export function checkRetention(stored: string[], current: string[], retirements: Retirement[]) {
  const cur = new Set(current), prev = new Set(stored);
  const retired = new Map(retirements.map((r) => [r.id, r]));
  const removed = stored.filter((id) => !cur.has(id)).sort();
  const unexplained = removed.filter((id) => !retired.has(id));
  const retiredApplied = removed.filter((id) => retired.has(id));
  const successorMissing = retiredApplied.filter((id) => !cur.has(retired.get(id)!.successor!));
  const added = current.filter((id) => !prev.has(id)).sort();
  const staleRetirements = retirements.filter((r) => cur.has(r.id)).map((r) => r.id).sort();
  return { removed: removed.length, unexplained, retired: retiredApplied, successorMissing, added, staleRetirements };
}

const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const root = resolve(import.meta.dir, "../..");
  const discoveryPath = flag("--discovery");
  if (!discoveryPath) throw Error("Usage: verify:retention --discovery <test-results.json> [--update]");
  const discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
  if (!discovery.discoveryComplete) throw Error("Retention needs a complete (unsharded, clean) discovery; got discoveryComplete=false");
  const current: string[] = discovery.tests.map((t: { id: string }) => t.id).sort();
  const dir = join(root, "verification/baselines");
  const invPath = join(dir, "test-inventory.jsonl"), metaPath = join(dir, "test-inventory.meta.json"), retPath = join(dir, "retirements.json");
  const { retirements, errors } = validateRetirements(existsSync(retPath) ? JSON.parse(readFileSync(retPath, "utf8")) : []);
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; return; }

  if (!existsSync(invPath)) {
    if (!process.argv.includes("--update")) throw Error("No stored inventory; create one with --update from a complete discovery");
  }
  const stored: string[] = existsSync(invPath) ? readFileSync(invPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const result = checkRetention(stored, current, retirements);
  const report = { sourceCommit: discovery.sourceCommit, storedFrom: existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")).sourceCommit : null, stored: stored.length, current: current.length, ...result };
  const outDir = dirname(resolve(discoveryPath));
  writeFileSync(join(outDir, "retention-report.json"), canonical(report));
  console.log(JSON.stringify({ ...report, unexplained: result.unexplained.slice(0, 20), added: result.added.length, retired: result.retired.length }, null, 2));

  const failed = result.unexplained.length > 0 || result.successorMissing.length > 0;
  if (process.argv.includes("--update")) {
    if (failed) throw Error("Refusing to update the stored inventory while removals are unexplained or successors are missing");
    mkdirSync(dir, { recursive: true });
    const text = current.map((id) => JSON.stringify(id)).join("\n") + "\n";
    writeFileSync(invPath, text);
    writeFileSync(metaPath, canonical({ sourceCommit: discovery.sourceCommit, tests: current.length, sha256: sha256(text), status: "candidate — not approved as the M00 baseline until the owner signs off" }));
    if (!existsSync(retPath)) writeFileSync(retPath, "[]\n");
    console.log(`Stored inventory updated: ${current.length} IDs`);
  }
  if (failed) process.exitCode = 1;
}
if (import.meta.main) await main();
