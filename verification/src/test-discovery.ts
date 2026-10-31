/**
 * M00-006 — runner-native test discovery.
 *
 * Inventory comes from the upstream runners themselves (`vitest list`, `playwright test --list`),
 * cross-checked against a static scan of the test files so that nothing can disappear silently:
 *   - Vitest's list mode omits skipped tests, and 500+ upstream suites are `describe.skipIf(!DB_URL)`.
 *     Discovery therefore sets *dummy, unreachable* database/Redis URLs (RFC 6761 `.invalid`):
 *     listing only collects tests, it never runs the hooks that would connect.
 *   - `.skip` / `.todo` tests are invisible to `vitest list`; the static scan records them as SKIPPED.
 *   - Any test file for which no test was discovered or statically recorded is a finding.
 *
 * Discovery never executes tests. Every discovered test is NOT_RUN or BLOCKED, never PASS.
 */
import ts from "typescript";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type Status = "PASS" | "FAIL" | "ERROR" | "BLOCKED" | "SKIPPED" | "NOT_RUN" | "NOT_APPLICABLE";
export type TestCase = {
  id: string;
  runner: "vitest" | "playwright";
  file: string;
  fullName: string;
  project?: string;
  status: Status;
  reason?: string;
  source: "runner" | "static-scan";
};
export type DiscoveryFinding = { code: string; file: string; detail: string };
export type Discovery = { runner: string; status: Status; command: string[]; exitCode: number | null; timedOut: boolean; durationMs: number; stderr: string; tests: number };

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const canonical = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/** Dummy, unreachable service URLs used only while *listing*. `.invalid` can never resolve (RFC 6761). */
export const DISCOVERY_ENV: Record<string, string> = {
  CHARTWARDEN_TEST_DATABASE_URL: "postgres://discovery-only.invalid:1/none",
  CHARTWARDEN_TEST_REDIS_URL: "redis://discovery-only.invalid:1",
};
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function stableId(runner: string, file: string, fullName: string, project?: string) {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return [runner, project ? project + "::" + normalized : normalized, fullName].join("::");
}

/** Repo-relative path; refuses anything outside the pinned checkout. */
export function repoPath(raw: string, source: string) {
  const f = raw.replaceAll("\\", "/");
  const root = source.replaceAll("\\", "/").replace(/\/$/, "");
  if (f.startsWith("/") && !f.startsWith(root + "/")) throw Error("Runner emitted test path outside pinned checkout: " + f);
  return f.startsWith(root + "/") ? f.slice(root.length + 1) : f.replace(/^\.\//, "");
}

/**
 * Vitest 4 `list --json`: a flat array of `{ name, file, projectName?, location? }`, where `name` is the
 * test's full name (suites joined by " > "). Anything else is rejected rather than guessed at.
 */
export function parseVitest(raw: unknown, source: string): TestCase[] {
  if (!Array.isArray(raw)) throw Error("Vitest list output is not an array; unsupported format");
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== "object") throw Error(`Vitest list entry ${i} is not an object`);
    const { name, file, projectName } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !name) throw Error(`Vitest list entry ${i} has no test name`);
    if (typeof file !== "string" || !file) throw Error(`Vitest list entry ${i} (${name}) has no file`);
    if (projectName !== undefined && typeof projectName !== "string") throw Error(`Vitest list entry ${i} has a non-string projectName`);
    const rel = repoPath(file, source);
    const project = projectName || undefined;
    return { id: stableId("vitest", rel, name, project), runner: "vitest" as const, file: rel, fullName: name, project, status: "NOT_RUN" as const, source: "runner" as const };
  });
}

/**
 * Playwright `--list --reporter=json`. Spec files are relative to each project's `testDir`, so they
 * are rebased onto the repo root using `config.projects[].testDir`.
 */
export function parsePlaywright(raw: unknown, source: string): TestCase[] {
  const report = raw as { config?: { projects?: { name?: string; testDir?: string }[] }; suites?: unknown[]; errors?: unknown[] };
  if (!report || !Array.isArray(report.suites)) throw Error("Playwright report has no suites array; unsupported format");
  if (Array.isArray(report.errors) && report.errors.length) throw Error(`Playwright reported ${report.errors.length} error(s) while listing`);
  const testDirs = new Map((report.config?.projects ?? []).map((p) => [p.name ?? "", p.testDir ?? ""]));
  const found: TestCase[] = [];
  const visit = (suite: any, titles: string[], file: string) => {
    if (!suite || typeof suite !== "object") return;
    const f = typeof suite.file === "string" ? suite.file : file;
    const next = suite.title && suite.title !== f && !/\.(spec|test)\.[cm]?[jt]sx?$/.test(suite.title) ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const project = typeof test.projectName === "string" && test.projectName ? test.projectName : undefined;
        if (!f) throw Error("Playwright test missing file: " + spec.title);
        const dir = testDirs.get(project ?? "");
        if (!dir) throw Error(`Playwright project ${project ?? "(default)"} has no testDir in the report`);
        const rel = repoPath(join(dir, f), source);
        const fullName = [...next, spec.title].filter(Boolean).join(" > ");
        found.push({ id: stableId("playwright", rel, fullName, project), runner: "playwright", file: rel, fullName, project, status: "NOT_RUN", source: "runner" });
      }
    }
    for (const child of suite.suites ?? []) visit(child, next, f);
  };
  for (const suite of report.suites) visit(suite, [], "");
  return found;
}

/**
 * Duplicate full names are real in upstream suites (e.g. repeated titles in `test.each`). Aborting would
 * lose the whole inventory, so each repeat gets an ordinal suffix (`#2`, `#3`, in runner order) and a
 * DUPLICATE_TEST_ID finding. Ordinals are only as stable as the declaration order — the finding says so.
 */
export function disambiguate(tests: TestCase[]): { tests: TestCase[]; findings: DiscoveryFinding[] } {
  const seen = new Map<string, number>();
  const findings: DiscoveryFinding[] = [];
  const out = tests.map((t) => {
    const n = (seen.get(t.id) ?? 0) + 1;
    seen.set(t.id, n);
    if (n === 1) return t;
    return { ...t, id: `${t.id}#${n}` };
  });
  for (const [id, n] of seen) if (n > 1) findings.push({ code: "DUPLICATE_TEST_ID", file: id.split("::").slice(-2, -1)[0] ?? "", detail: `${n} tests share id ${id}; ordinals assigned in declaration order` });
  return { tests: out.sort((a, b) => a.id.localeCompare(b.id)), findings };
}

/* ------------------------------------------------------------- static scan */

const TEST_FNS = new Set(["it", "test"]);
const SUITE_FNS = new Set(["describe", "suite"]);
type StaticEntry = { file: string; fullName: string | null; kind: "skip" | "todo" | "guarded"; detail: string };

function titleOf(arg: ts.Expression | undefined): string | null {
  if (!arg) return null;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return null;
}

/** Decompose `describe.skipIf(x)("title", fn)`, `it.todo("t")`, `xit("t")`, `test.each(rows)("t", fn)` … */
function callShape(call: ts.CallExpression): { base: string; mods: string[]; titleArg?: ts.Expression } | null {
  let callee: ts.Expression = call.expression;
  const mods: string[] = [];
  // curried forms: describe.skipIf(cond)(title) / test.each(rows)(title)
  if (ts.isCallExpression(callee)) {
    const inner = callShape(callee);
    if (!inner) return null;
    return { base: inner.base, mods: inner.mods, titleArg: call.arguments[0] };
  }
  while (ts.isPropertyAccessExpression(callee)) {
    mods.unshift(callee.name.text);
    callee = callee.expression;
  }
  if (!ts.isIdentifier(callee)) return null;
  let base = callee.text;
  if (base === "xit" || base === "xtest") { base = "it"; mods.push("skip"); }
  if (base === "xdescribe") { base = "describe"; mods.push("skip"); }
  if (!TEST_FNS.has(base) && !SUITE_FNS.has(base)) return null;
  return { base, mods, titleArg: call.arguments[0] };
}

/** Find statically skipped/todo tests and conditionally guarded blocks, with full names where titles are literal. */
export function scanTestFile(src: string, file: string): StaticEntry[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: StaticEntry[] = [];
  const visit = (node: ts.Node, suites: (string | null)[], skippedAncestor: boolean) => {
    if (ts.isCallExpression(node)) {
      const shape = callShape(node);
      if (shape && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
        const title = titleOf(shape.titleArg);
        const path = [...suites, title];
        const fullName = path.every((p) => p !== null) ? (path as string[]).join(" > ") : null;
        const skip = shape.mods.includes("skip");
        const todo = shape.mods.includes("todo");
        const guarded = shape.mods.includes("skipIf") || shape.mods.includes("runIf");
        const each = shape.mods.includes("each") || shape.mods.includes("for");
        if (TEST_FNS.has(shape.base)) {
          if (todo) out.push({ file, fullName, kind: "todo", detail: "it.todo — not listed by vitest" });
          else if (skip || skippedAncestor) out.push({ file, fullName: each ? null : fullName, kind: "skip", detail: skip ? ".skip — not listed by vitest" : "inside a skipped suite — not listed by vitest" });
          else if (guarded) out.push({ file, fullName, kind: "guarded", detail: "skipIf/runIf test" });
        } else if (guarded) {
          out.push({ file, fullName, kind: "guarded", detail: "skipIf/runIf suite" });
        }
        if (SUITE_FNS.has(shape.base)) {
          const body = node.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
          if (body) ts.forEachChild(body, (c) => visit(c, path, skippedAncestor || skip));
          return;
        }
      }
    }
    ts.forEachChild(node, (c) => visit(c, suites, skippedAncestor));
  };
  visit(sf, [], false);
  return out;
}

const IGNORED_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", "__fixtures__", "storybook-static"]);
export function listTestFiles(source: string, roots = ["apps", "packages", "scripts/__tests__"]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.test\.tsx?$/.test(e.name)) out.push(relative(source, p).replaceAll("\\", "/"));
    }
  };
  for (const r of roots) walk(join(source, r));
  return out.sort();
}

/**
 * Reconcile runner output with the static scan:
 *  - statically skipped/todo tests become SKIPPED entries (they exist but vitest does not list them);
 *  - a guarded block with a literal name that matches no listed test is a finding;
 *  - a test file with nothing discovered and nothing statically recorded is a finding.
 */
export function reconcile(listed: TestCase[], testFiles: string[], scans: Map<string, StaticEntry[]>, projectOf: (file: string) => string | undefined) {
  const findings: DiscoveryFinding[] = [];
  const extra: TestCase[] = [];
  const listedNames = new Map<string, string[]>();
  for (const t of listed) if (t.runner === "vitest") listedNames.set(t.file, [...(listedNames.get(t.file) ?? []), t.fullName]);
  for (const file of testFiles) {
    const entries = scans.get(file) ?? [];
    let dynamicSkips = 0;
    for (const e of entries) {
      if (e.kind === "guarded") {
        if (e.fullName && !(listedNames.get(file) ?? []).some((n) => n === e.fullName || n.startsWith(e.fullName + " > ")))
          findings.push({ code: "GUARDED_BLOCK_NOT_LISTED", file, detail: `${e.fullName} — skipIf/runIf condition held at discovery; its tests are not in the inventory` });
        continue;
      }
      if (!e.fullName) { dynamicSkips++; continue; }
      const project = projectOf(file);
      extra.push({ id: stableId("vitest", file, e.fullName, project), runner: "vitest", file, fullName: e.fullName, project, status: "SKIPPED", reason: e.detail, source: "static-scan" });
    }
    if (dynamicSkips) findings.push({ code: "SKIPPED_TEST_TITLE_NOT_STATIC", file, detail: `${dynamicSkips} skipped/todo test(s) with non-literal titles cannot be given stable IDs` });
    if (!listedNames.has(file) && !entries.some((e) => e.kind !== "guarded"))
      findings.push({ code: "TEST_FILE_WITHOUT_DISCOVERED_TESTS", file, detail: "no runner-listed or statically recorded test; check include globs, skip conditions or collection errors" });
  }
  return { extra, findings };
}

/* ------------------------------------------------------------- classification */

export function compareInventory(previous: string[], current: string[], approvedRetirements: string[] = []) {
  const cur = new Set(current), retired = new Set(approvedRetirements);
  return previous.filter((id) => !cur.has(id) && !retired.has(id)).sort();
}

/** Naming convention only — upstream also has DB suites named `*-live.test.ts` or not named at all. */
export const isLiveTestFile = (file: string) => /[.-]live\.test\.|\.integration\.test\./.test(file);
export const SERVICE_ENV_RE = /CHARTWARDEN_TEST_(DATABASE|REDIS)_URL/;
/** A test file needs ephemeral services if its name says so OR its source reads a service URL. */
export const needsServices = (file: string, src: string) => isLiveTestFile(file) || SERVICE_ENV_RE.test(src);

/** Discovery-time classification. Runner results always win; nothing becomes PASS without one. */
export function classifyExecution(discovered: TestCase[], results: Record<string, Status>, environment: { postgresReady: boolean; valkeyReady: boolean }, serviceFiles?: Set<string>) {
  const isService = (f: string) => (serviceFiles ? serviceFiles.has(f) : isLiveTestFile(f));
  return discovered.map((t) => {
    const status = results[t.id];
    if (status) return { ...t, status };
    if (t.status === "SKIPPED") return t;
    if (isService(t.file) && !environment.postgresReady) return { ...t, status: "BLOCKED" as const, reason: "Needs ephemeral PostgreSQL/Valkey; not executed" };
    return { ...t, status: "NOT_RUN" as const, reason: "Not executed; discovery only" };
  });
}

/* ------------------------------------------------------------- execution */

export async function runner(source: string, args: string[], timeoutMs: number, extraEnv: Record<string, string> = {}) {
  const allowed = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "USERPROFILE", "LANG", "LC_ALL", "TERM"];
  const env: Record<string, string> = { CI: "true", NODE_ENV: "test", DATABASE_URL: "", REDIS_URL: "", VALKEY_URL: "", ...extraEnv };
  for (const key of allowed) if (process.env[key]) env[key] = process.env[key]!;
  const started = Date.now();
  const proc = Bun.spawn(args, { cwd: source, stdout: "pipe", stderr: "pipe", env });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut, durationMs: Date.now() - started };
}

function git(source: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", source, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw Error(new TextDecoder().decode(r.stderr));
  return new TextDecoder().decode(r.stdout).trim();
}

const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const flags = (name: string) => process.argv.flatMap((a, i) => (a === name && process.argv[i + 1] ? [process.argv[i + 1]] : []));

export const PLAYWRIGHT_CONFIGS = ["playwright.config.ts", "playwright.config.mts", "playwright.config.js", "e2e/playwright.config.ts", "e2e/playwright.config.mts", "e2e/playwright.config.js"];

async function main() {
  const root = resolve(import.meta.dir, "../..");
  const cfgText = readFileSync(join(root, "verification/config.json"), "utf8"), cfg = JSON.parse(cfgText);
  const sourceArg = flag("--source");
  if (!sourceArg) throw Error("Usage: bun run verify:discover --source /path/to/chartwarden [--timeout-ms N] [--vitest-project name]... [--vitest-shard i/n] [--save-vitest-list file] [--vitest-list file]... [--skip-playwright]");
  const source = resolve(sourceArg), sha = git(source, "rev-parse", "HEAD");
  if (sha !== cfg.upstream.ref) throw Error("Untrusted upstream SHA: " + sha);
  const dirty = Boolean(git(source, "status", "--porcelain", "--untracked-files=all"));
  if (!existsSync(join(source, "node_modules", "vitest", "vitest.mjs"))) throw Error("Vitest must be installed in pinned checkout; refusing package-manager auto-download");
  const timeoutMs = Number(flag("--timeout-ms") ?? cfg.discovery?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error("--timeout-ms must be a positive number");
  const vitestProjects = flags("--vitest-project");
  // Pre-captured `vitest list --json=<file>` outputs (e.g. one per CI shard). Read instead of re-listing.
  const vitestLists = flags("--vitest-list").map((p) => resolve(p));
  for (const p of vitestLists) if (!existsSync(p)) throw Error("--vitest-list file not found: " + p);
  if (vitestLists.length && vitestProjects.length) throw Error("--vitest-list and --vitest-project are mutually exclusive");
  // CI sharding: list one slice, keep the raw runner output, and combine slices later with --vitest-list.
  const vitestShard = flag("--vitest-shard");
  if (vitestShard && !/^\d+\/\d+$/.test(vitestShard)) throw Error("--vitest-shard must look like 2/4");
  const saveVitestList = flag("--save-vitest-list");
  const sharded = vitestProjects.length > 0 || Boolean(vitestShard);
  const output = join(root, cfg.outputDirectory, sha);
  mkdirSync(output, { recursive: true });

  const vitestJson = join(output, ".vitest-list.json");
  rmSync(vitestJson, { force: true });
  const pwConfig = PLAYWRIGHT_CONFIGS.find((c) => existsSync(join(source, c)));
  const pwCli = join(source, "node_modules/@playwright/test/cli.js");
  const specs: { runner: "vitest" | "playwright"; command: string[]; enabled: boolean; why?: string }[] = [
    {
      runner: "vitest",
      command: ["bun", "run", "--bun", "./node_modules/vitest/vitest.mjs", "list", `--json=${vitestJson}`, ...vitestProjects.flatMap((p) => ["--project", p]), ...(vitestShard ? [`--shard=${vitestShard}`] : [])],
      enabled: true,
    },
    {
      runner: "playwright",
      command: ["bun", "run", "--bun", "./node_modules/@playwright/test/cli.js", "test", "--list", "--reporter=json", "-c", pwConfig ?? ""],
      enabled: Boolean(pwConfig) && !process.argv.includes("--skip-playwright"),
      why: !pwConfig ? `No Playwright configuration found (checked ${PLAYWRIGHT_CONFIGS.join(", ")})` : "Skipped by --skip-playwright",
    },
  ];
  if (pwConfig && !existsSync(pwCli)) specs[1].enabled = false, specs[1].why = "Playwright config exists but @playwright/test is not installed";

  let discovered: TestCase[] = [];
  const runs: Discovery[] = [];
  const findings: DiscoveryFinding[] = [];
  for (const spec of specs) {
    if (!spec.enabled) {
      // A runner that is configured but cannot be listed is an ERROR, never NOT_APPLICABLE.
      // An explicit --skip-playwright (CI listing slices) is NOT_APPLICABLE and leaves discovery incomplete.
      const configuredButUnavailable = spec.runner === "playwright" && Boolean(pwConfig) && !process.argv.includes("--skip-playwright");
      runs.push({ runner: spec.runner, status: configuredButUnavailable ? "ERROR" : "NOT_APPLICABLE", command: spec.command, exitCode: null, timedOut: false, durationMs: 0, stderr: spec.why ?? "", tests: 0 });
      continue;
    }
    if (spec.runner === "vitest" && vitestLists.length) {
      try {
        const tests = vitestLists.flatMap((p) => parseVitest(JSON.parse(readFileSync(p, "utf8")), source));
        if (!tests.length) throw Error("pre-captured Vitest listings contain zero tests");
        discovered.push(...tests);
        runs.push({ runner: "vitest", status: "PASS", command: ["(pre-captured)", ...vitestLists.map((p) => `${p.split("/").pop()} sha256=${sha256(readFileSync(p, "utf8"))}`)], exitCode: 0, timedOut: false, durationMs: 0, stderr: "", tests: tests.length });
      } catch (e) {
        runs.push({ runner: "vitest", status: "ERROR", command: ["(pre-captured)", ...vitestLists], exitCode: null, timedOut: false, durationMs: 0, stderr: String(e), tests: 0 });
      }
      continue;
    }
    try {
      const r = await runner(source, spec.command, timeoutMs, DISCOVERY_ENV);
      if (r.timedOut || r.exitCode !== 0) {
        runs.push({ runner: spec.runner, status: "ERROR", command: spec.command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, stderr: (r.timedOut ? `Timed out after ${timeoutMs} ms. ` : "") + r.stderr.slice(-4000), tests: 0 });
        continue;
      }
      let raw: unknown;
      if (spec.runner === "vitest") {
        if (!existsSync(vitestJson)) throw Error("vitest list exited 0 but wrote no JSON file");
        const text = readFileSync(vitestJson, "utf8");
        raw = JSON.parse(text);
        if (saveVitestList) { mkdirSync(dirname(resolve(saveVitestList)), { recursive: true }); writeFileSync(resolve(saveVitestList), text); }
      } else {
        raw = JSON.parse(r.stdout); // reporter JSON is the only stdout content for --list --reporter=json
      }
      const tests = spec.runner === "vitest" ? parseVitest(raw, source) : parsePlaywright(raw, source);
      if (!tests.length) {
        runs.push({ runner: spec.runner, status: "ERROR", command: spec.command, exitCode: r.exitCode, timedOut: false, durationMs: r.durationMs, stderr: "Runner returned zero tests; cannot approve discovery", tests: 0 });
        continue;
      }
      discovered.push(...tests);
      runs.push({ runner: spec.runner, status: "PASS", command: spec.command, exitCode: r.exitCode, timedOut: false, durationMs: r.durationMs, stderr: r.stderr.slice(-4000), tests: tests.length });
    } catch (e) {
      runs.push({ runner: spec.runner, status: "ERROR", command: spec.command, exitCode: null, timedOut: false, durationMs: 0, stderr: String(e), tests: 0 });
    }
  }
  rmSync(vitestJson, { force: true });

  // Static reconciliation is only meaningful for an unsharded Vitest run.
  const vitestRan = runs.some((r) => r.runner === "vitest" && r.status === "PASS");
  if (vitestRan && !sharded) {
    const testFiles = listTestFiles(source);
    const scans = new Map(testFiles.map((f) => [f, scanTestFile(readFileSync(join(source, f), "utf8"), f)]));
    const projectOf = (f: string) => (/\.dom\.test\.tsx$/.test(f) ? "dom" : discovered.find((t) => t.file === f)?.project ?? "node");
    const rec = reconcile(discovered, testFiles, scans, projectOf);
    discovered.push(...rec.extra);
    findings.push(...rec.findings);
  } else if (vitestRan) {
    findings.push({ code: "STATIC_RECONCILIATION_SKIPPED", file: "", detail: "Vitest listing was sharded (--vitest-project/--vitest-shard); reconciliation runs only on a full listing — combine shards with --vitest-list" });
  }
  const dedup = disambiguate(discovered);
  findings.push(...dedup.findings);
  findings.sort((a, b) => `${a.code}|${a.file}|${a.detail}`.localeCompare(`${b.code}|${b.file}|${b.detail}`));

  const serviceDependentFiles = listTestFiles(source).filter((f) => needsServices(f, readFileSync(join(source, f), "utf8")));
  const tests = classifyExecution(dedup.tests, {}, { postgresReady: false, valkeyReady: false }, new Set(serviceDependentFiles));
  const counts = Object.fromEntries(["PASS", "FAIL", "ERROR", "BLOCKED", "SKIPPED", "NOT_RUN", "NOT_APPLICABLE"].map((s) => [s, tests.filter((t) => t.status === s).length]));
  const discoveryComplete = !dirty && !sharded && !process.argv.includes("--skip-playwright") && runs.every((r) => r.status === "PASS" || r.status === "NOT_APPLICABLE");
  const payload = {
    sourceCommit: sha, dirty, approvedBaselineEligible: false, discoveryComplete,
    discoveryEnvironment: Object.keys(DISCOVERY_ENV).map((k) => `${k}=<unreachable .invalid placeholder>`),
    discovery: runs.map(({ stderr, ...r }) => ({ ...r, stderrTail: stderr.slice(-1000) })),
    counts, findings, serviceDependentFiles, tests,
  };
  const content = canonical(payload);
  writeFileSync(join(output, "test-results.json"), content);
  const manifest = { sourceCommit: sha, dirty, configHash: sha256(cfgText), bunVersion: Bun.version, typescriptVersion: ts.version, timeoutMs, vitestProjects, vitestShard: vitestShard ?? null, vitestLists: vitestLists.map((p) => p.split("/").pop()), discoveryChecksums: { "test-results.json": sha256(content) }, timestamp: new Date().toISOString(), note: "Discovery only; no tests executed. NOT_RUN/BLOCKED/SKIPPED are not passing." };
  writeFileSync(join(output, "test-discovery-manifest.json"), canonical(manifest));
  console.log(JSON.stringify({ discovered: tests.length, counts, findings: findings.length, runners: runs.map((r) => ({ runner: r.runner, status: r.status, tests: r.tests, seconds: Math.round(r.durationMs / 1000), reason: r.status === "PASS" ? undefined : r.stderr.slice(0, 300) })), output }, null, 2));
  if (runs.some((r) => r.status === "ERROR")) process.exitCode = 1;
}
if (import.meta.main) await main();
