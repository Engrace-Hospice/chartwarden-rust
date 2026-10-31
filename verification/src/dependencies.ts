/**
 * M00-003 — module dependency resolution and forbidden-edge detection.
 *
 * Independent re-implementation of the upstream boundary check:
 *   - imports are resolved to concrete files with our own resolver (relative paths,
 *     workspace package `exports`, npm packages, Node/Bun builtins);
 *   - the policy is upstream's own `architecture/.dependency-cruiser.cjs` `forbidden`
 *     array (static + generated from the module manifest), evaluated here rather than
 *     by dependency-cruiser, so a disagreement between the two tools is itself evidence;
 *   - cycles are found with Tarjan's algorithm at file level (as depcruise does) and
 *     summarised at module level.
 *
 * Nothing in this file reads or writes outside the upstream checkout it is given, and it
 * never writes to that checkout.
 */
import { builtinModules } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { Finding, ImportEdge } from "./inventory-v2";

export type ModuleDef = { id: number; name: string; codePaths: string[]; dependsOn: number[] };

export type TargetKind = "internal" | "npm" | "core" | "unresolved";

export type ResolvedEdge = {
  from: string;
  line: number;
  specifier: string;
  kind: string; // import | export | dynamic-import | require
  targetKind: TargetKind;
  /** repo-relative file for internal edges; `node_modules/<pkg>` for npm; builtin name for core. */
  to: string | null;
  resolution: "relative" | "workspace-exports" | "workspace-fallback" | "npm" | "core" | "none";
  fromModules: number[];
  toModules: number[];
};

export type RuleViolation = {
  rule: string;
  severity: string;
  from: string;
  line: number;
  specifier: string;
  to: string;
  fromModules: number[];
  toModules: number[];
};

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".mjs", ".cjs", ".json"];
const INDEXES = ["/index.ts", "/index.tsx", "/index.mts", "/index.js"];
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, "")]));

/** A path prefix "covers" a file only on a segment boundary: packages/db covers packages/db/x, not packages/dbx. */
export function coveredBy(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
}

/** Every module whose codePaths cover the file (more than one when code paths nest, e.g. packages/db vs packages/db/src/schema/x). */
export function modulesForPath(path: string, modules: ModuleDef[]): number[] {
  return modules.filter((m) => m.codePaths.some((p) => coveredBy(path, p))).map((m) => m.id).sort((a, b) => a - b);
}

export type Workspace = { byName: Map<string, { dir: string; exports: Record<string, string> }> };

/** Read apps/* and packages/* package.json names and string `exports` maps. */
export function loadWorkspace(source: string): Workspace {
  const byName = new Map<string, { dir: string; exports: Record<string, string> }>();
  for (const group of ["apps", "packages"]) {
    const root = join(source, group);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root).sort()) {
      const pkgPath = join(root, entry, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (!pkg.name) continue;
      const exports: Record<string, string> = {};
      const raw = pkg.exports ?? (pkg.types || pkg.main ? { ".": pkg.types ?? pkg.main } : undefined);
      if (typeof raw === "string") exports["."] = raw;
      else if (raw && typeof raw === "object") {
        for (const [key, value] of Object.entries(raw)) {
          const target = typeof value === "string" ? value : pickCondition(value);
          if (target) exports[key] = target;
        }
      }
      byName.set(pkg.name, { dir: `${group}/${entry}`, exports });
    }
  }
  return { byName };
}

function pickCondition(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  for (const c of ["types", "import", "bun", "default", "require"]) {
    if (typeof v[c] === "string") return v[c] as string;
    if (v[c] && typeof v[c] === "object") {
      const nested = pickCondition(v[c]);
      if (nested) return nested;
    }
  }
  return null;
}

/** Try a repo-relative path as a file, with TS extension and index fallbacks (incl. `.js` → `.ts` under Bundler resolution). */
export function resolveFile(source: string, rel: string): string | null {
  const candidates = [rel, ...EXTENSIONS.map((e) => rel + e), ...INDEXES.map((i) => rel + i)];
  if (/\.(m|c)?js$/.test(rel)) {
    const stem = rel.replace(/\.(m|c)?js$/, "");
    candidates.push(stem + ".ts", stem + ".tsx", stem + ".mts", stem + ".cts");
  }
  for (const c of candidates) {
    const abs = join(source, c);
    if (existsSync(abs) && statSync(abs).isFile()) return posix.normalize(c);
  }
  return null;
}

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function resolveSpecifier(
  source: string,
  from: string,
  spec: string,
  workspace: Workspace,
): Pick<ResolvedEdge, "targetKind" | "to" | "resolution"> {
  if (spec.startsWith("node:") || spec.startsWith("bun:") || BUILTINS.has(spec) || spec === "bun") {
    return { targetKind: "core", to: spec.replace(/^node:/, ""), resolution: "core" };
  }
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const rel = posix.normalize(posix.join(posix.dirname(from), spec));
    const file = resolveFile(source, rel);
    return file
      ? { targetKind: "internal", to: file, resolution: "relative" }
      : { targetKind: "unresolved", to: rel, resolution: "none" };
  }
  const name = packageName(spec);
  const pkg = workspace.byName.get(name);
  if (pkg) {
    const sub = spec.length > name.length ? "." + spec.slice(name.length) : ".";
    let target = pkg.exports[sub];
    if (!target) {
      // single-star subpath patterns, e.g. "./*": "./src/*.ts"
      for (const [key, value] of Object.entries(pkg.exports)) {
        const star = key.indexOf("*");
        if (star < 0) continue;
        const [pre, post] = [key.slice(0, star), key.slice(star + 1)];
        if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= pre.length + post.length) {
          target = value.replace("*", sub.slice(pre.length, sub.length - post.length));
          break;
        }
      }
    }
    if (target) {
      const file = resolveFile(source, posix.normalize(posix.join(pkg.dir, target)));
      if (file) return { targetKind: "internal", to: file, resolution: "workspace-exports" };
    }
    // Not exported: record where a bundler without `exports` enforcement would look, and flag it.
    const loose = sub === "." ? pkg.dir : posix.join(pkg.dir, sub.slice(2));
    const file = resolveFile(source, loose) ?? resolveFile(source, posix.join(pkg.dir, "src", sub.slice(2)));
    return file
      ? { targetKind: "internal", to: file, resolution: "workspace-fallback" }
      : { targetKind: "unresolved", to: spec, resolution: "none" };
  }
  return { targetKind: "npm", to: `node_modules/${name}`, resolution: "npm" };
}

export function resolveEdges(source: string, imports: ImportEdge[], modules: ModuleDef[], workspace: Workspace): ResolvedEdge[] {
  return imports.map((imp) => {
    const r = resolveSpecifier(source, imp.from, imp.specifier, workspace);
    return {
      from: imp.from,
      line: imp.line,
      specifier: imp.specifier,
      kind: imp.kind,
      ...r,
      fromModules: modulesForPath(imp.from, modules),
      toModules: r.targetKind === "internal" && r.to ? modulesForPath(r.to, modules) : [],
    };
  });
}

/* ------------------------------------------------------------------ policy */

type Matcher = { path?: string; pathNot?: string; dependencyTypes?: string[]; circular?: boolean };
export type DepcruiseRule = { name: string; severity?: string; from?: Matcher; to?: Matcher };

const test = (re: string | undefined, s: string) => (re === undefined ? true : new RegExp(re).test(s));
const testNot = (re: string | undefined, s: string) => (re === undefined ? true : !new RegExp(re).test(s));

/** depcruise dependencyTypes we can reproduce: "npm" (package in node_modules) and "core" (builtin). */
function depType(edge: ResolvedEdge): string[] {
  if (edge.targetKind === "npm") return ["npm"];
  if (edge.targetKind === "core") return ["core"];
  if (edge.targetKind === "internal") return ["local"];
  return ["unknown"];
}

/**
 * Evaluate non-circular forbidden rules. Cycle rules (`to.circular`) are handled by findCycles.
 * Returns violations plus rules we could not evaluate faithfully, so nothing is silently skipped.
 */
export function evaluateRules(edges: ResolvedEdge[], rules: DepcruiseRule[]): { violations: RuleViolation[]; unsupported: string[] } {
  const violations: RuleViolation[] = [];
  const unsupported: string[] = [];
  const supportedKeys = new Set(["path", "pathNot", "dependencyTypes", "circular"]);
  for (const rule of rules) {
    const keys = [...Object.keys(rule.from ?? {}), ...Object.keys(rule.to ?? {})];
    const extra = keys.filter((k) => !supportedKeys.has(k));
    if (extra.length) {
      unsupported.push(`${rule.name}: unsupported matcher keys ${extra.join(",")}`);
      continue;
    }
    if (rule.to?.circular) continue;
    for (const e of edges) {
      if (e.targetKind === "unresolved" || !e.to) continue;
      if (!test(rule.from?.path, e.from) || !testNot(rule.from?.pathNot, e.from)) continue;
      if (rule.to?.dependencyTypes && !rule.to.dependencyTypes.some((t) => depType(e).includes(t))) continue;
      if (!test(rule.to?.path, e.to) || !testNot(rule.to?.pathNot, e.to)) continue;
      violations.push({
        rule: rule.name,
        severity: rule.severity ?? "error",
        from: e.from,
        line: e.line,
        specifier: e.specifier,
        to: e.to,
        fromModules: e.fromModules,
        toModules: e.toModules,
      });
    }
  }
  violations.sort((a, b) => `${a.rule}|${a.from}|${a.line}|${a.to}`.localeCompare(`${b.rule}|${b.from}|${b.line}|${b.to}`));
  return { violations, unsupported: unsupported.sort() };
}

/* ------------------------------------------------------------------ cycles */

/** Tarjan SCC. Returns components with >1 node, or a single node with a self-edge; each sorted, list sorted. */
export function findCycles(edges: { from: string; to: string }[]): string[][] {
  const graph = new Map<string, Set<string>>();
  for (const { from, to } of edges) {
    if (!graph.has(from)) graph.set(from, new Set());
    if (!graph.has(to)) graph.set(to, new Set());
    graph.get(from)!.add(to);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let next = 0;
  // Iterative to survive deep graphs (tens of thousands of files).
  for (const root of [...graph.keys()].sort()) {
    if (index.has(root)) continue;
    const work: { node: string; it: Iterator<string> }[] = [];
    const enter = (n: string) => {
      index.set(n, next); low.set(n, next); next++;
      stack.push(n); onStack.add(n);
      work.push({ node: n, it: [...graph.get(n)!].sort()[Symbol.iterator]() });
    };
    enter(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const step = frame.it.next();
      if (!step.done) {
        const w = step.value;
        if (!index.has(w)) enter(w);
        else if (onStack.has(w)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const comp: string[] = [];
        let w: string;
        do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== frame.node);
        if (comp.length > 1 || graph.get(frame.node)!.has(frame.node)) out.push(comp.sort());
      }
    }
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

/* ------------------------------------------------------------------ module graph */

/**
 * Module-level edges with the basis that permits each one:
 *   "dependsOn"  — the manifest declares the edge;
 *   "helper"     — every import lands in a LEAF or FOUNDATION_HELPER package (ADR-0005 D4: no edge needed);
 *   "undeclared" — at least one import has neither basis (should coincide with a FORBIDDEN_EDGE).
 */
export function moduleGraph(edges: ResolvedEdge[], modules: ModuleDef[], universallyAllowed: string[] = []) {
  const declared = new Map(modules.map((m) => [m.id, new Set(m.dependsOn)]));
  const counts = new Map<string, { imports: number; outsideHelpers: number }>();
  for (const e of edges) {
    if (e.targetKind !== "internal" || !e.to) continue;
    const viaHelper = universallyAllowed.some((p) => coveredBy(e.to!, p));
    for (const f of e.fromModules) for (const t of e.toModules) {
      if (f === t) continue;
      const k = `${f}->${t}`;
      const c = counts.get(k) ?? { imports: 0, outsideHelpers: 0 };
      c.imports++;
      if (!viaHelper) c.outsideHelpers++;
      counts.set(k, c);
    }
  }
  const actual = [...counts].map(([k, c]) => {
    const [from, to] = k.split("->").map(Number);
    const isDeclared = declared.get(from)?.has(to) ?? false;
    const basis = isDeclared ? "dependsOn" : c.outsideHelpers === 0 ? "helper" : "undeclared";
    return { from, to, imports: c.imports, declared: isDeclared, basis };
  }).sort((a, b) => a.from - b.from || a.to - b.to);
  const actualSet = new Set(actual.map((e) => `${e.from}->${e.to}`));
  const declaredUnused = modules.flatMap((m) => m.dependsOn.filter((d) => !actualSet.has(`${m.id}->${d}`)).map((d) => ({ from: m.id, to: d })));
  const moduleCycles = findCycles(actual.map((e) => ({ from: String(e.from), to: String(e.to) })))
    .map((c) => c.map(Number).sort((a, b) => a - b));
  return { actual, declaredUnused, moduleCycles };
}

/** Load upstream's dependency-cruiser rule set (CommonJS; requires its sibling module-manifest.cjs). */
export function loadUpstreamRules(source: string): DepcruiseRule[] {
  const configPath = join(source, "architecture/.dependency-cruiser.cjs");
  if (!existsSync(configPath)) throw new Error("Upstream architecture/.dependency-cruiser.cjs not found");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const config = require(configPath);
  return config.forbidden as DepcruiseRule[];
}

export function dependencyFindings(edges: ResolvedEdge[], violations: RuleViolation[], unsupported: string[], fileCycles: string[][]): Finding[] {
  const f: Finding[] = [];
  for (const e of edges) {
    if (e.targetKind === "unresolved") f.push({ code: "UNRESOLVED_IMPORT_TARGET", file: e.from, line: e.line, detail: e.specifier });
    if (e.resolution === "workspace-fallback") f.push({ code: "IMPORT_NOT_IN_PACKAGE_EXPORTS", file: e.from, line: e.line, detail: `${e.specifier} -> ${e.to}` });
  }
  for (const v of violations) f.push({ code: "FORBIDDEN_EDGE", file: v.from, line: v.line, detail: `${v.rule}: ${v.specifier} -> ${v.to}` });
  for (const u of unsupported) f.push({ code: "RULE_NOT_EVALUATED", file: "architecture/.dependency-cruiser.cjs", line: 0, detail: u });
  for (const c of fileCycles) f.push({ code: "IMPORT_CYCLE", file: c[0], line: 0, detail: `${c.length} files: ${c.slice(0, 6).join(" → ")}${c.length > 6 ? " …" : ""}` });
  return f;
}

