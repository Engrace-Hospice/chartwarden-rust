import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DISCOVERY_ENV,
  PLAYWRIGHT_CONFIGS,
  classifyExecution,
  compareInventory,
  disambiguate,
  needsServices,
  parsePlaywright,
  parseVitest,
  reconcile,
  scanTestFile,
  stableId,
  type TestCase,
} from "../src/test-discovery";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8"));

describe("Vitest 4.1.12 list --json (real runner output)", () => {
  const listed = parseVitest(fixture("vitest-4.1.12-list.json"), "/repo");

  test("parses every entry of the real flat format", () => {
    expect(listed).toHaveLength(118);
    expect(listed[0]).toMatchObject({
      file: "packages/billing/__tests__/admission-codes.test.ts",
      fullName: "claimAdmissionCodes > passes recorded codes through",
      project: "node",
      id: "vitest::node::packages/billing/__tests__/admission-codes.test.ts::claimAdmissionCodes > passes recorded codes through",
    });
  });

  test("live suites appear only with a placeholder DB URL — regression for the silent-omission defect", () => {
    const withoutDb = parseVitest(fixture("vitest-4.1.12-list-no-db.json"), "/repo");
    const live = (ts: TestCase[]) => ts.filter((t) => t.file.includes(".live.test.")).length;
    expect(live(withoutDb)).toBe(0);
    expect(live(listed)).toBe(109);
    expect(DISCOVERY_ENV.CHARTWARDEN_TEST_DATABASE_URL).toContain(".invalid");
    expect(DISCOVERY_ENV.CHARTWARDEN_TEST_REDIS_URL).toContain(".invalid");
  });

  test("rejects the nested shape the first adapter assumed, instead of returning zero tests", () => {
    expect(() => parseVitest({ files: [] }, "/repo")).toThrow("not an array");
    expect(() => parseVitest([{ type: "suite", tasks: [] }], "/repo")).toThrow("no test name");
  });

  test("refuses paths outside the pinned checkout", () => {
    expect(() => parseVitest([{ name: "x", file: "/elsewhere/a.test.ts" }], "/repo")).toThrow("outside pinned checkout");
  });
});

describe("Playwright --list --reporter=json (real runner output)", () => {
  test("IDs are repo-relative (rebased on the project's testDir) and include the project", () => {
    const t = parsePlaywright(fixture("playwright-1.62-list.json"), "/repo");
    expect(t.length).toBeGreaterThan(0);
    expect(t.every((x) => x.file.startsWith("e2e/specs/"))).toBe(true);
    expect(t[0].id.startsWith("playwright::chromium::e2e/specs/")).toBe(true);
  });
  test("the upstream config location under e2e/ is searched", () => {
    expect(PLAYWRIGHT_CONFIGS).toContain("e2e/playwright.config.ts");
  });
  test("listing errors fail closed", () => {
    expect(() => parsePlaywright({ suites: [], errors: [{ message: "boom" }] }, "/repo")).toThrow("error");
    expect(() => parsePlaywright({}, "/repo")).toThrow("no suites");
  });
});

describe("duplicate identities", () => {
  test("repeated full names get ordinals and a finding instead of aborting the inventory", () => {
    const t = (name: string): TestCase => ({ id: stableId("vitest", "a.test.ts", name), runner: "vitest", file: "a.test.ts", fullName: name, status: "NOT_RUN", source: "runner" });
    const r = disambiguate([t("same"), t("same"), t("other")]);
    expect(r.tests.map((x) => x.id)).toEqual(["vitest::a.test.ts::other", "vitest::a.test.ts::same", "vitest::a.test.ts::same#2"]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].code).toBe("DUPLICATE_TEST_ID");
  });
});

describe("static scan and reconciliation (nothing disappears silently)", () => {
  const src = `
    describe("claims", () => {
      it("assembles", () => {});
      it.todo("handles NOTR");
      it.skip("legacy path", () => {});
      describe.skip("old suite", () => { it("inner", () => {}); });
      test.each([1, 2])("row %s", () => {});
    });
    xit("orphan skip", () => {});
    describe.skipIf(!DB_URL)("LIVE rls", () => { it("isolates", () => {}); });
  `;
  const scan = scanTestFile(src, "packages/billing/__tests__/claims.test.ts");

  test("records .todo, .skip, skipped-suite children and x-prefixed tests with full names", () => {
    const named = scan.filter((e) => e.kind !== "guarded").map((e) => `${e.kind}:${e.fullName}`);
    expect(named).toEqual(["todo:claims > handles NOTR", "skip:claims > legacy path", "skip:claims > old suite > inner", "skip:orphan skip"]);
    expect(scan.filter((e) => e.kind === "guarded").map((e) => e.fullName)).toEqual(["LIVE rls"]);
  });

  test("skipped tests become SKIPPED inventory entries; never NOT_RUN or PASS", () => {
    const listed = parseVitest([{ name: "claims > assembles", file: "/repo/packages/billing/__tests__/claims.test.ts", projectName: "node" }], "/repo");
    const files = ["packages/billing/__tests__/claims.test.ts"];
    const r = reconcile(listed, files, new Map([[files[0], scan]]), () => "node");
    expect(r.extra.every((t) => t.status === "SKIPPED" && t.source === "static-scan")).toBe(true);
    expect(r.extra).toHaveLength(4);
    const classified = classifyExecution([...listed, ...r.extra], {}, { postgresReady: false, valkeyReady: false });
    expect(classified.filter((t) => t.status === "SKIPPED")).toHaveLength(4);
    expect(classified.some((t) => t.status === "PASS")).toBe(false);
  });

  test("a guarded block that the runner did not list is a finding", () => {
    const files = ["packages/billing/__tests__/claims.test.ts"];
    const listed = parseVitest([{ name: "claims > assembles", file: "/repo/" + files[0] }], "/repo");
    const r = reconcile(listed, files, new Map([[files[0], scan]]), () => undefined);
    expect(r.findings.map((f) => f.code)).toContain("GUARDED_BLOCK_NOT_LISTED");
    const listedAll = parseVitest([{ name: "claims > assembles", file: "/repo/" + files[0] }, { name: "LIVE rls > isolates", file: "/repo/" + files[0] }], "/repo");
    expect(reconcile(listedAll, files, new Map([[files[0], scan]]), () => undefined).findings.map((f) => f.code)).not.toContain("GUARDED_BLOCK_NOT_LISTED");
  });

  test("a test file with nothing discovered is a finding", () => {
    const r = reconcile([], ["apps/x/__tests__/empty.test.ts"], new Map(), () => undefined);
    expect(r.findings).toEqual([{ code: "TEST_FILE_WITHOUT_DISCOVERED_TESTS", file: "apps/x/__tests__/empty.test.ts", detail: expect.any(String) }]);
  });
});

describe("service-dependent test files", () => {
  test("detected by content, not only by the .live naming convention — regression for misfiled DB suites", () => {
    // upstream: packages/db/migrations/__tests__/rls-isolation.test.ts, apps/backend/__tests__/gap-097-…-live.test.ts
    expect(needsServices("packages/db/migrations/__tests__/rls-isolation.test.ts", "const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;")).toBe(true);
    expect(needsServices("apps/backend/__tests__/gap-097-tenant-export-approval-live.test.ts", "")).toBe(true);
    expect(needsServices("apps/x/__tests__/queue.test.ts", "process.env.CHARTWARDEN_TEST_REDIS_URL")).toBe(true);
    expect(needsServices("apps/x/__tests__/pure.test.ts", "expect(1).toBe(1)")).toBe(false);
  });
  test("BLOCKED follows the service-file set when given", () => {
    const t: TestCase = { id: "x", runner: "vitest", file: "packages/db/migrations/__tests__/rls-isolation.test.ts", fullName: "x", status: "NOT_RUN", source: "runner" };
    expect(classifyExecution([t], {}, { postgresReady: false, valkeyReady: false })[0].status).toBe("NOT_RUN");
    expect(classifyExecution([t], {}, { postgresReady: false, valkeyReady: false }, new Set([t.file]))[0].status).toBe("BLOCKED");
  });
});

describe("classification and retention", () => {
  test("live suites are BLOCKED without PostgreSQL; others NOT_RUN; runner results win", () => {
    const t = (file: string): TestCase => ({ id: file, runner: "vitest", file, fullName: "x", status: "NOT_RUN", source: "runner" });
    const out = classifyExecution([t("packages/db/a.live.test.ts"), t("apps/a.test.ts"), t("apps/b.live.test.ts")], { "apps/b.live.test.ts": "FAIL" }, { postgresReady: false, valkeyReady: false });
    expect(out.map((x) => x.status)).toEqual(["BLOCKED", "NOT_RUN", "FAIL"]);
  });
  test("unapproved test disappearance is detected; approved retirement is not", () => {
    expect(compareInventory(["a", "b"], ["a", "c"])).toEqual(["b"]);
    expect(compareInventory(["a", "b"], ["a", "c"], ["b"])).toEqual([]);
  });
  test("stable IDs normalize path separators", () => {
    expect(stableId("vitest", "apps\\x.test.ts", "t")).toBe("vitest::apps/x.test.ts::t");
  });
});
