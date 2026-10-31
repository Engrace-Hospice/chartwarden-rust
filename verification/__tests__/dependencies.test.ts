import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  evaluateRules,
  findCycles,
  loadWorkspace,
  moduleGraph,
  modulesForPath,
  resolveEdges,
  resolveSpecifier,
  type DepcruiseRule,
  type ModuleDef,
} from "../src/dependencies";
import { scanSource } from "../src/inventory-v2";

let root: string;
const put = (rel: string, content = "export {};\n") => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "m00-deps-"));
  put("packages/db/package.json", JSON.stringify({ name: "@x/db", exports: { ".": "./src/index.ts", "./schema": "./src/schema/index.ts" } }));
  put("packages/db/src/index.ts");
  put("packages/db/src/schema/index.ts");
  put("packages/kit/package.json", JSON.stringify({ name: "@x/kit", exports: { "./*": "./src/*.ts" } }));
  put("packages/kit/src/button.ts");
  put("packages/loose/package.json", JSON.stringify({ name: "@x/loose", exports: { ".": "./src/index.ts" } }));
  put("packages/loose/src/index.ts");
  put("packages/loose/src/internal.ts");
  put("apps/api/src/a.ts");
  put("apps/api/src/b.ts");
  put("apps/api/src/dir/index.ts");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const modules: ModuleDef[] = [
  { id: 1, name: "Foundation", codePaths: ["packages/db"], dependsOn: [] },
  { id: 2, name: "Billing", codePaths: ["apps/api/src/billing", "packages/billing"], dependsOn: [1] },
  { id: 3, name: "AI", codePaths: ["packages/ai"], dependsOn: [] },
  { id: 4, name: "Nested", codePaths: ["packages/db/src/schema"], dependsOn: [] },
];

describe("import resolution", () => {
  test("relative, extensionless, index and .js→.ts", () => {
    const ws = loadWorkspace(root);
    expect(resolveSpecifier(root, "apps/api/src/a.ts", "./b", ws)).toMatchObject({ targetKind: "internal", to: "apps/api/src/b.ts" });
    expect(resolveSpecifier(root, "apps/api/src/a.ts", "./b.js", ws).to).toBe("apps/api/src/b.ts");
    expect(resolveSpecifier(root, "apps/api/src/a.ts", "./dir", ws).to).toBe("apps/api/src/dir/index.ts");
    expect(resolveSpecifier(root, "apps/api/src/a.ts", "./missing", ws).targetKind).toBe("unresolved");
  });
  test("workspace packages via exports, subpaths and star patterns", () => {
    const ws = loadWorkspace(root);
    expect(resolveSpecifier(root, "apps/api/src/a.ts", "@x/db", ws)).toMatchObject({ to: "packages/db/src/index.ts", resolution: "workspace-exports" });
    expect(resolveSpecifier(root, "apps/api/src/a.ts", "@x/db/schema", ws).to).toBe("packages/db/src/schema/index.ts");
    expect(resolveSpecifier(root, "apps/api/src/a.ts", "@x/kit/button", ws).to).toBe("packages/kit/src/button.ts");
  });
  test("deep import that bypasses package exports is flagged as fallback", () => {
    const ws = loadWorkspace(root);
    expect(resolveSpecifier(root, "apps/api/src/a.ts", "@x/loose/internal", ws)).toMatchObject({ resolution: "workspace-fallback", to: "packages/loose/src/internal.ts" });
  });
  test("builtins and npm packages", () => {
    const ws = loadWorkspace(root);
    expect(resolveSpecifier(root, "a.ts", "node:fs", ws).targetKind).toBe("core");
    expect(resolveSpecifier(root, "a.ts", "crypto", ws).targetKind).toBe("core");
    expect(resolveSpecifier(root, "a.ts", "bun:test", ws).targetKind).toBe("core");
    expect(resolveSpecifier(root, "a.ts", "@anthropic-ai/sdk/resources", ws)).toMatchObject({ targetKind: "npm", to: "node_modules/@anthropic-ai/sdk" });
  });
  test("module attribution respects segment boundaries and nesting", () => {
    expect(modulesForPath("packages/dbx/a.ts", modules)).toEqual([]);
    expect(modulesForPath("packages/db/src/schema/patient.ts", modules)).toEqual([1, 4]);
  });
});

describe("forbidden-edge policy (negative controls)", () => {
  const boundary: DepcruiseRule = {
    name: "module-2-boundary",
    from: { path: "^(apps/api/src/billing|packages/billing)(/|$)" },
    to: { path: "^(apps|packages)/", pathNot: "^(apps/api/src/billing|packages/billing|packages/db|packages/shared)(/|$)" },
  };
  const vendor: DepcruiseRule = {
    name: "vendor-adapter-anthropic",
    from: { pathNot: "^packages/ai(/|$)" },
    to: { dependencyTypes: ["npm"], path: "node_modules/@anthropic-ai/sdk(/|$)" },
  };
  const edge = (from: string, to: string, targetKind: "internal" | "npm" = "internal") => ({
    from, line: 1, specifier: to, kind: "import", targetKind, to, resolution: "relative" as const,
    fromModules: modulesForPath(from, modules), toModules: modulesForPath(to, modules),
  });

  test("planted cross-module import is a violation with file and line", () => {
    const { violations } = evaluateRules([edge("packages/billing/src/claim.ts", "packages/ai/src/index.ts")], [boundary]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: "module-2-boundary", from: "packages/billing/src/claim.ts", line: 1 });
  });
  test("imports of declared dependencies, own code and leaves are allowed", () => {
    const ok = [
      edge("packages/billing/src/claim.ts", "packages/db/src/index.ts"),
      edge("packages/billing/src/claim.ts", "packages/billing/src/rates.ts"),
      edge("packages/billing/src/claim.ts", "packages/shared/src/index.ts"),
    ];
    expect(evaluateRules(ok, [boundary]).violations).toEqual([]);
  });
  test("vendor SDK outside its adapter is a violation; inside it is not", () => {
    const { violations } = evaluateRules(
      [edge("packages/billing/src/claim.ts", "node_modules/@anthropic-ai/sdk", "npm"), edge("packages/ai/src/client.ts", "node_modules/@anthropic-ai/sdk", "npm")],
      [vendor],
    );
    expect(violations.map((v) => v.from)).toEqual(["packages/billing/src/claim.ts"]);
  });
  test("rules with matcher keys we cannot evaluate are reported, never silently skipped", () => {
    const odd: DepcruiseRule = { name: "reachable-rule", from: { path: "x" }, to: { reachable: false } as never };
    expect(evaluateRules([], [odd]).unsupported).toEqual(["reachable-rule: unsupported matcher keys reachable"]);
  });
});

describe("cycles and module graph", () => {
  test("detects a 3-file cycle and a self-import, ignores a DAG", () => {
    const cycles = findCycles([
      { from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" },
      { from: "s", to: "s" },
      { from: "x", to: "y" }, { from: "y", to: "z" },
    ]);
    expect(cycles).toEqual([["a", "b", "c"], ["s"]]);
  });
  test("handles a long chain without stack overflow", () => {
    const chain = Array.from({ length: 50_000 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` }));
    expect(findCycles(chain)).toEqual([]);
    expect(findCycles([...chain, { from: "n50000", to: "n0" }])[0]).toHaveLength(50_001);
  });
  test("module edge basis: dependsOn, helper-only, undeclared", () => {
    const ws = loadWorkspace(root);
    const edges = resolveEdges(root, [
      { from: "apps/api/src/billing/x.ts", specifier: "@x/db", line: 1, kind: "import" },
      { from: "packages/ai/src/x.ts", specifier: "@x/db", line: 1, kind: "import" },
    ], modules, ws);
    const g = moduleGraph(edges, modules, []);
    expect(g.actual).toEqual([
      { from: 2, to: 1, imports: 1, declared: true, basis: "dependsOn" },
      { from: 3, to: 1, imports: 1, declared: false, basis: "undeclared" },
    ]);
    expect(moduleGraph(edges, modules, ["packages/db"]).actual[1].basis).toBe("helper");
  });
});

describe("route and import scanning regressions", () => {
  test("Map/Set lookups in route files are not routes", () => {
    const src = `const cache = new Map(); app.get("/real", handler); cache.get(id); mapper.get("x", y); headers.delete("x");`;
    const r = scanSource(src, "apps/backend/src/modules/10-hope/routes/service.ts");
    expect(r.routes.map((x) => x.path)).toEqual(["/real"]);
    expect(r.findings).toEqual([]);
  });
  test("type-position import() is a compile-time edge", () => {
    const r = scanSource(`type D = { g?: import("./unlock-guard").UnlockGuard };`, "apps/backend/src/modules/02-identity/identity-ports.ts");
    expect(r.imports).toEqual([{ from: "apps/backend/src/modules/02-identity/identity-ports.ts", specifier: "./unlock-guard", line: 1, kind: "import-type" }]);
  });
});
