/**
 * M00-007 — test execution against ephemeral infrastructure.
 *
 *   verify:execute --source <upstream> --discovery <test-results.json> --suite unit|live
 *                  [--database-url postgres://…@localhost…] [--redis-url redis://localhost…]
 *                  [--shard 1/4] [--timeout-ms N] [--out <file>]
 *   verify:merge   --discovery <test-results.json> <execution-*.json>… [--out <file>]
 *
 * unit: every non-live Vitest file, file-parallel, with NO service URLs (live suites cannot run).
 * live: `*.live.test.*` files, one file at a time (each replays all migrations into the shared DB),
 *       against an ephemeral PostgreSQL (and Valkey when given).
 *
 * Results are mapped onto discovery's stable IDs. Nothing is PASS without a runner "passed".
 * A file that fails to load marks all of its discovered tests ERROR. A live test that still
 * skips while a database URL was provided is a finding — a failure cannot hide as a skip.
 *
 * Safety: live suites DROP and recreate schemas. Service URLs must point at a loopback or CI
 * service host; anything else is refused before a runner starts.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonical, repoPath, runner, sha256, stableId, type Status, type TestCase } from "./test-discovery";

export type Outcome = { id: string; file: string; status: Status; durationMs?: number; message?: string };
export type ExecFinding = { code: string; file: string; detail: string };

const SAFE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres", "valkey", "redis"]);
/** Refuse any service URL whose host is not loopback or a CI service-container alias. */
export function assertEphemeralUrl(url: string, kind: string): void {
  let host: string;
  try { host = new URL(url).hostname; } catch { throw Error(`${kind} URL is not a valid URL`); }
  if (!SAFE_HOSTS.has(host)) throw Error(`${kind} URL host "${host}" is not loopback or a CI service alias; refusing (live suites drop schemas)`);
}

/** Deterministic shard assignment by file path hash, so shards are stable as files are added. */
export function inShard(file: string, shard: { index: number; total: number } | null): boolean {
  if (!shard) return true;
  const h = parseInt(createHash("sha1").update(file).digest("hex").slice(0, 8), 16);
  return h % shard.total === shard.index - 1;
}

export function parseShard(s: string | undefined): { index: number; total: number } | null {
  if (!s) return null;
  const m = /^(\d+)\/(\d+)$/.exec(s);
  if (!m) throw Error("--shard must look like 2/8");
  const [index, total] = [Number(m[1]), Number(m[2])];
  if (index < 1 || index > total) throw Error("--shard index out of range");
  return { index, total };
}

/**
 * Map Vitest's JSON reporter (jest-compatible) onto discovery IDs.
 * Repeated full names in a file are matched in order, mirroring discovery's `#2` ordinals.
 */
export function mapVitestReport(report: any, source: string, projectOf: (file: string) => string | undefined): { outcomes: Outcome[]; fileErrors: { file: string; message: string }[] } {
  if (!report || !Array.isArray(report.testResults)) throw Error("Vitest JSON report has no testResults array; unsupported format");
  const outcomes: Outcome[] = [];
  const fileErrors: { file: string; message: string }[] = [];
  for (const fileResult of report.testResults) {
    const file = repoPath(String(fileResult.name), source);
    const seen = new Map<string, number>();
    const assertions: any[] = fileResult.assertionResults ?? [];
    if (fileResult.status === "failed" && assertions.length === 0) {
      fileErrors.push({ file, message: String(fileResult.message ?? "suite failed to load").slice(0, 2000) });
      continue;
    }
    for (const a of assertions) {
      const fullName = [...(a.ancestorTitles ?? []), a.title].filter((x: unknown) => typeof x === "string" && x.length).join(" > ");
      const base = stableId("vitest", file, fullName, projectOf(file));
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const id = n === 1 ? base : `${base}#${n}`;
      const status: Status =
        a.status === "passed" ? "PASS"
        : a.status === "failed" ? "FAIL"
        : a.status === "skipped" || a.status === "pending" || a.status === "todo" || a.status === "disabled" ? "SKIPPED"
        : "ERROR";
      outcomes.push({ id, file, status, durationMs: typeof a.duration === "number" ? Math.round(a.duration) : undefined, message: status === "FAIL" || status === "ERROR" ? (a.failureMessages ?? []).join("\n").slice(0, 2000) : undefined });
    }
    // A file can also fail after some tests ran (afterAll throw, unhandled error).
    if (fileResult.status === "failed" && assertions.every((a) => a.status !== "failed"))
      fileErrors.push({ file, message: String(fileResult.message ?? "suite reported failure without a failing test").slice(0, 2000) });
  }
  return { outcomes, fileErrors };
}

/**
 * Combine discovery with one or more execution shards. Precedence for each test:
 * explicit runner outcome > file-level ERROR > discovery classification (BLOCKED/NOT_RUN/SKIPPED).
 */
export function mergeResults(discovered: TestCase[], serviceFiles: Set<string>, executions: { suite: string; outcomes: Outcome[]; fileErrors: { file: string; message: string }[]; ranFiles: string[]; databaseProvided: boolean }[]) {
  const byId = new Map(discovered.map((t) => [t.id, t]));
  const findings: ExecFinding[] = [];
  const outcome = new Map<string, Outcome>();
  const erroredFiles = new Map<string, string>();
  const ranFiles = new Set<string>();
  for (const ex of executions) {
    for (const f of ex.ranFiles) ranFiles.add(f);
    for (const e of ex.fileErrors) erroredFiles.set(e.file, e.message);
    for (const o of ex.outcomes) {
      if (outcome.has(o.id)) findings.push({ code: "DUPLICATE_EXECUTION_RESULT", file: o.id.split("::").at(-2) ?? "", detail: `${o.id} executed in more than one shard` });
      outcome.set(o.id, o);
      if (!byId.has(o.id)) findings.push({ code: "RESULT_NOT_IN_DISCOVERY", file: o.id.split("::").at(-2) ?? "", detail: `${o.id} ran but was not discovered (generated at runtime, renamed, or discovery is stale)` });
      const t = byId.get(o.id);
      // A statically declared .skip/.todo is expected to skip; anything else skipping while services were provided is suspect.
      if (o.status === "SKIPPED" && serviceFiles.has(o.file) && ex.databaseProvided && t?.source !== "static-scan")
        findings.push({ code: "LIVE_TEST_SKIPPED_WITH_DATABASE", file: o.file, detail: `${o.id} skipped although a database URL was provided` });
    }
  }
  const tests = discovered.map((t) => {
    const o = outcome.get(t.id);
    if (o) return { ...t, status: o.status, reason: o.message, durationMs: o.durationMs };
    if (erroredFiles.has(t.file)) return { ...t, status: "ERROR" as Status, reason: "Test file failed: " + erroredFiles.get(t.file)!.slice(0, 300) };
    if (ranFiles.has(t.file) && t.status !== "SKIPPED") {
      findings.push({ code: "DISCOVERED_TEST_NOT_EXECUTED", file: t.file, detail: `${t.fullName} was discovered but produced no result although its file ran` });
      return { ...t, status: "ERROR" as Status, reason: "Discovered test produced no result although its file ran" };
    }
    return t;
  });
  const counts = Object.fromEntries(["PASS", "FAIL", "ERROR", "BLOCKED", "SKIPPED", "NOT_RUN", "NOT_APPLICABLE"].map((s) => [s, tests.filter((t) => t.status === s).length]));
  findings.sort((a, b) => `${a.code}|${a.file}|${a.detail}`.localeCompare(`${b.code}|${b.file}|${b.detail}`));
  return { tests, counts, findings };
}

/* --------------------------------------------------------------------- CLI */

const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

function git(source: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", source, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw Error(new TextDecoder().decode(r.stderr));
  return new TextDecoder().decode(r.stdout).trim();
}

async function execute() {
  const root = resolve(import.meta.dir, "../..");
  const cfgText = readFileSync(join(root, "verification/config.json"), "utf8"), cfg = JSON.parse(cfgText);
  const source = resolve(flag("--source") ?? "");
  const discoveryPath = flag("--discovery");
  const suite = flag("--suite");
  if (!flag("--source") || !discoveryPath || (suite !== "unit" && suite !== "live"))
    throw Error("Usage: verify:execute --source <upstream> --discovery <test-results.json> --suite unit|live [--database-url …] [--redis-url …] [--shard i/n] [--timeout-ms N] [--out file]");
  const sha = git(source, "rev-parse", "HEAD");
  if (sha !== cfg.upstream.ref) throw Error("Untrusted upstream SHA: " + sha);
  const dirty = Boolean(git(source, "status", "--porcelain", "--untracked-files=all"));
  const discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
  if (discovery.sourceCommit !== sha) throw Error(`Discovery is for ${discovery.sourceCommit}, source is ${sha}`);
  const databaseUrl = flag("--database-url"), redisUrl = flag("--redis-url");
  if (suite === "live" && !databaseUrl) throw Error("--suite live requires --database-url (ephemeral PostgreSQL)");
  if (suite === "unit" && (databaseUrl || redisUrl)) throw Error("--suite unit runs without service URLs; omit --database-url/--redis-url");
  if (databaseUrl) assertEphemeralUrl(databaseUrl, "Database");
  if (redisUrl) assertEphemeralUrl(redisUrl, "Redis");
  const shard = parseShard(flag("--shard"));
  const timeoutMs = Number(flag("--timeout-ms") ?? cfg.execution?.timeoutMs ?? 6 * 60 * 60 * 1000);

  const tests: TestCase[] = discovery.tests;
  const vitestFiles = [...new Set(tests.filter((t) => t.runner === "vitest").map((t) => t.file))].sort();
  if (!Array.isArray(discovery.serviceDependentFiles)) throw Error("Discovery output lacks serviceDependentFiles; re-run verify:discover");
  const serviceFiles = new Set<string>(discovery.serviceDependentFiles);
  const files = vitestFiles.filter((f) => (suite === "live" ? serviceFiles.has(f) : !serviceFiles.has(f))).filter((f) => inShard(f, shard));
  const projectOf = (f: string) => tests.find((t) => t.file === f)?.project;

  const out = resolve(flag("--out") ?? join(root, cfg.outputDirectory, sha, `execution-${suite}${shard ? `-${shard.index}of${shard.total}` : ""}.json`));
  mkdirSync(dirname(out), { recursive: true });
  const reportFile = out.replace(/\.json$/, ".vitest-report.json");
  rmSync(reportFile, { force: true });
  const env: Record<string, string> = {};
  if (databaseUrl) env.CHARTWARDEN_TEST_DATABASE_URL = databaseUrl;
  if (redisUrl) env.CHARTWARDEN_TEST_REDIS_URL = redisUrl;
  // File list is passed explicitly so the run covers exactly the discovered files of this suite/shard.
  const listFile = out.replace(/\.json$/, ".files.txt");
  writeFileSync(listFile, files.join("\n") + "\n");
  const args = ["bun", "run", "--bun", "./node_modules/vitest/vitest.mjs", "run", "--reporter=json", `--outputFile=${reportFile}`];
  if (suite === "live") args.push("--no-file-parallelism", "--maxWorkers=1");
  args.push(...files);

  const started = new Date().toISOString();
  const r = files.length ? await runner(source, args, timeoutMs, env) : { exitCode: 0, stdout: "", stderr: "no files in this shard", timedOut: false, durationMs: 0 };
  const findings: ExecFinding[] = [];
  let mapped = { outcomes: [] as Outcome[], fileErrors: [] as { file: string; message: string }[] };
  let runStatus: Status = "PASS";
  if (r.timedOut) { runStatus = "ERROR"; findings.push({ code: "EXECUTION_TIMED_OUT", file: "", detail: `after ${timeoutMs} ms` }); }
  if (files.length) {
    if (existsSync(reportFile)) {
      try { mapped = mapVitestReport(JSON.parse(readFileSync(reportFile, "utf8")), source, projectOf); }
      catch (e) { runStatus = "ERROR"; findings.push({ code: "REPORT_UNPARSEABLE", file: "", detail: String(e) }); }
    } else { runStatus = "ERROR"; findings.push({ code: "NO_RUNNER_REPORT", file: "", detail: `exit ${r.exitCode}: ${r.stderr.slice(-1500)}` }); }
    const anyFail = mapped.outcomes.some((o) => o.status === "FAIL") || mapped.fileErrors.length > 0;
    if (r.exitCode !== 0 && !anyFail && !r.timedOut) { runStatus = "ERROR"; findings.push({ code: "RUNNER_FAILED_WITHOUT_FAILING_TEST", file: "", detail: `exit ${r.exitCode}: ${r.stderr.slice(-1500)}` }); }
    if (r.exitCode === 0 && anyFail) findings.push({ code: "RUNNER_EXIT_ZERO_WITH_FAILURES", file: "", detail: "runner exit code disagrees with its report" });
  }
  const payload = {
    sourceCommit: sha, sourceDirty: dirty, suite, shard: shard ? `${shard.index}/${shard.total}` : null, startedAt: started, durationMs: r.durationMs,
    runStatus, exitCode: r.exitCode, databaseProvided: Boolean(databaseUrl), redisProvided: Boolean(redisUrl),
    ranFiles: files, findings, fileErrors: mapped.fileErrors, outcomes: mapped.outcomes.sort((a, b) => a.id.localeCompare(b.id)),
    stderrTail: r.stderr.slice(-2000),
  };
  writeFileSync(out, canonical(payload));
  rmSync(listFile, { force: true });
  const counts = Object.fromEntries(["PASS", "FAIL", "ERROR", "SKIPPED"].map((s) => [s, mapped.outcomes.filter((o) => o.status === s).length]));
  console.log(JSON.stringify({ suite, shard: payload.shard, files: files.length, runStatus, exitCode: r.exitCode, seconds: Math.round(r.durationMs / 1000), counts, fileErrors: mapped.fileErrors.length, findings: findings.length, out }, null, 2));
  if (runStatus === "ERROR") process.exitCode = 1;
}

/**
 * Integrity findings mean the evidence itself cannot be trusted — they always fail the merge.
 * Test FAIL/ERROR outcomes are recorded faithfully but only fail the merge with --require-pass
 * (M00 records the baseline; it does not require every upstream test to pass).
 */
export const INTEGRITY_CODES = new Set([
  "RESULT_NOT_IN_DISCOVERY", "DISCOVERED_TEST_NOT_EXECUTED", "DUPLICATE_EXECUTION_RESULT", "LIVE_TEST_SKIPPED_WITH_DATABASE",
  "RUNNER_FAILED_WITHOUT_FAILING_TEST", "RUNNER_EXIT_ZERO_WITH_FAILURES", "NO_RUNNER_REPORT", "REPORT_UNPARSEABLE", "EXECUTION_TIMED_OUT",
]);
export function verdict(counts: Record<string, number>, findings: { code: string }[], requirePass: boolean) {
  const integrity = findings.filter((f) => INTEGRITY_CODES.has(f.code)).length;
  const failing = (counts.FAIL ?? 0) + (counts.ERROR ?? 0);
  return { integrityFindings: integrity, failingTests: failing, ok: integrity === 0 && (!requirePass || failing === 0) };
}

async function merge() {
  const discoveryPath = flag("--discovery");
  const shards = process.argv.slice(2).filter((a, i, all) => a.endsWith(".json") && all[i - 1] !== "--discovery" && all[i - 1] !== "--out");
  if (!discoveryPath || !shards.length) throw Error("Usage: verify:merge --discovery <test-results.json> <execution-*.json>… [--out file]");
  const discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
  const executions = shards.map((p) => JSON.parse(readFileSync(p, "utf8")));
  for (const ex of executions) if (ex.sourceCommit !== discovery.sourceCommit) throw Error(`Execution ${ex.suite} is for ${ex.sourceCommit}, discovery for ${discovery.sourceCommit}`);
  const merged = mergeResults(discovery.tests, new Set(discovery.serviceDependentFiles ?? []), executions);
  const runFindings = executions.flatMap((ex: any) => ex.findings.map((f: ExecFinding) => ({ ...f, detail: `[${ex.suite}${ex.shard ? " " + ex.shard : ""}] ${f.detail}` })));
  const allFindings = [...discovery.findings, ...runFindings, ...merged.findings];
  const payload = {
    sourceCommit: discovery.sourceCommit, approvedBaselineEligible: false,
    verdict: verdict(merged.counts, allFindings, process.argv.includes("--require-pass")),
    sourceDirty: executions.some((ex: any) => ex.sourceDirty),
    executions: executions.map((ex: any) => ({ suite: ex.suite, shard: ex.shard, sourceDirty: ex.sourceDirty, runStatus: ex.runStatus, files: ex.ranFiles.length, durationMs: ex.durationMs, databaseProvided: ex.databaseProvided, redisProvided: ex.redisProvided })),
    counts: merged.counts, findings: allFindings, tests: merged.tests,
  };
  const content = canonical(payload);
  const out = resolve(flag("--out") ?? join(dirname(discoveryPath), "test-execution-results.json"));
  writeFileSync(out, content);
  writeFileSync(out.replace(/\.json$/, ".sha256"), sha256(content) + "\n");
  const v = verdict(merged.counts, payload.findings, process.argv.includes("--require-pass"));
  console.log(JSON.stringify({ counts: merged.counts, findings: payload.findings.length, verdict: v, executions: payload.executions, out }, null, 2));
  if (!v.ok || executions.some((e: any) => e.runStatus === "ERROR")) process.exitCode = 1;
}

if (import.meta.main) {
  const mode = process.argv.includes("--merge") ? merge : execute;
  await mode();
}
