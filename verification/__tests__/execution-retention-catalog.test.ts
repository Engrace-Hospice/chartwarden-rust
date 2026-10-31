import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkRoles, compareCatalog, type CatalogTable } from "../src/catalog";
import { assertEphemeralUrl, inShard, mapVitestReport, mergeResults, parseShard, verdict } from "../src/test-execution";
import { checkRetention, validateRetirements, type Retirement } from "../src/test-retention";
import { stableId, type TestCase } from "../src/test-discovery";

const report = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "vitest-4.1.12-run-report.json"), "utf8"));
const projectOf = () => "node";

describe("execution: mapping a real Vitest 4.1.12 run report (with planted defects)", () => {
  const { outcomes, fileErrors } = mapVitestReport(report, "/repo", projectOf);
  test("a file that fails to load is a file error, not zero tests", () => {
    expect(fileErrors.map((e) => e.file)).toEqual(["apps/backend/__tests__/authz-validation.test.ts"]);
    expect(fileErrors[0].message).toContain("planted load failure");
  });
  test("failed assertions are FAIL with their message; passing are PASS", () => {
    const intake = outcomes.filter((o) => o.file === "apps/backend/__tests__/admission-intake.test.ts");
    expect(intake.filter((o) => o.status === "FAIL")).toHaveLength(4);
    expect(intake.filter((o) => o.status === "FAIL").every((o) => (o.message ?? "").length > 0)).toBe(true);
    expect(outcomes.filter((o) => o.file === "scripts/__tests__/bootstrap.test.ts").every((o) => o.status === "PASS")).toBe(true);
  });
  test("IDs match discovery's format: ancestor titles joined with ' > '", () => {
    expect(outcomes.some((o) => o.id.startsWith("vitest::node::scripts/__tests__/bootstrap.test.ts::seam + eraser boot gate (§3.18 fail-closed) > "))).toBe(true);
  });
  test("unknown report shapes throw", () => {
    expect(() => mapVitestReport({ files: [] }, "/repo", projectOf)).toThrow("no testResults");
  });
});

describe("execution: merge precedence and integrity findings", () => {
  const tc = (file: string, name: string, extra: Partial<TestCase> = {}): TestCase => ({ id: stableId("vitest", file, name, "node"), runner: "vitest", file, fullName: name, project: "node", status: "NOT_RUN", source: "runner", ...extra });
  const discovered = [tc("a.test.ts", "ok"), tc("a.test.ts", "lost"), tc("b.test.ts", "crashes"), tc("c.live.test.ts", "db", { status: "BLOCKED" }), tc("d.test.ts", "never ran")];
  const ex = {
    suite: "unit", ranFiles: ["a.test.ts", "b.test.ts", "c.live.test.ts"], databaseProvided: true,
    fileErrors: [{ file: "b.test.ts", message: "boom" }],
    outcomes: [
      { id: discovered[0].id, file: "a.test.ts", status: "PASS" as const },
      { id: discovered[3].id, file: "c.live.test.ts", status: "SKIPPED" as const },
      { id: stableId("vitest", "a.test.ts", "surprise", "node"), file: "a.test.ts", status: "PASS" as const },
    ],
  };
  const m = mergeResults(discovered, new Set(["c.live.test.ts"]), [ex]);
  const status = (name: string) => m.tests.find((t) => t.fullName === name)!.status;
  test("runner outcome wins; crashed file → ERROR; file ran but test missing → ERROR; untouched file keeps discovery status", () => {
    expect([status("ok"), status("crashes"), status("lost"), status("never ran")]).toEqual(["PASS", "ERROR", "ERROR", "NOT_RUN"]);
  });
  test("integrity findings: undiscovered result, missing result, live skip with a database", () => {
    expect(m.findings.map((f) => f.code).sort()).toEqual(["DISCOVERED_TEST_NOT_EXECUTED", "LIVE_TEST_SKIPPED_WITH_DATABASE", "RESULT_NOT_IN_DISCOVERY"]);
  });
  test("verdict: integrity findings always fail; test failures only with --require-pass", () => {
    expect(verdict({ FAIL: 3 }, [], false).ok).toBe(true);
    expect(verdict({ FAIL: 3 }, [], true).ok).toBe(false);
    expect(verdict({}, [{ code: "RESULT_NOT_IN_DISCOVERY" }], false).ok).toBe(false);
    expect(verdict({}, [{ code: "DUPLICATE_TEST_ID" }], false).ok).toBe(true);
  });
});

describe("execution: safety and sharding", () => {
  test("refuses non-ephemeral service URLs (live suites drop schemas)", () => {
    expect(() => assertEphemeralUrl("postgres://u:p@prod-db.example.com:5432/chartwarden", "Database")).toThrow("not loopback");
    expect(() => assertEphemeralUrl("postgres://u:p@10.0.0.5/x", "Database")).toThrow("not loopback");
    expect(() => assertEphemeralUrl("postgres://postgres:postgres@localhost:5432/chartwarden_test", "Database")).not.toThrow();
    expect(() => assertEphemeralUrl("redis://valkey:6379", "Redis")).not.toThrow();
  });
  test("shards partition files exactly once and are stable", () => {
    const files = Array.from({ length: 500 }, (_, i) => `apps/x/f${i}.test.ts`);
    const shards = [1, 2, 3, 4].map((i) => files.filter((f) => inShard(f, { index: i, total: 4 })));
    expect(shards.reduce((n, s) => n + s.length, 0)).toBe(500);
    expect(new Set(shards.flat()).size).toBe(500);
    expect(() => parseShard("5/4")).toThrow();
    expect(parseShard("2/8")).toEqual({ index: 2, total: 8 });
  });
});

describe("retention against the stored inventory", () => {
  const ret = (r: Partial<Retirement>): Retirement => ({ id: "x", kind: "replacement", successor: "y", reason: "r", approvedBy: ["engineering:a"], date: "2026-10-31", ...r });
  test("unexplained removal fails; a count-preserving swap is still caught", () => {
    const r = checkRetention(["a", "b"], ["a", "c"], []);
    expect(r.unexplained).toEqual(["b"]);
    expect(r.added).toEqual(["c"]);
  });
  test("an approved retirement explains the removal; its successor must exist", () => {
    expect(checkRetention(["a", "b"], ["a", "c"], [ret({ id: "b", successor: "c" })]).unexplained).toEqual([]);
    expect(checkRetention(["a", "b"], ["a"], [ret({ id: "b", successor: "c" })]).successorMissing).toEqual(["b"]);
  });
  test("regulatory-correction retirements need an authority and a clinical/billing/compliance approver", () => {
    expect(validateRetirements([ret({ kind: "regulatory-correction" })]).errors.join("\n")).toContain("authoritative source");
    expect(validateRetirements([ret({ kind: "regulatory-correction", authority: "CMS Pub. 100-04 Ch. 11" })]).errors.join("\n")).toContain("clinical:, billing: or compliance:");
    expect(validateRetirements([ret({ kind: "regulatory-correction", authority: "CMS Pub. 100-04 Ch. 11", approvedBy: ["engineering:a", "billing:b"] })]).errors).toEqual([]);
    expect(validateRetirements([ret({ successor: undefined })]).errors.join("\n")).toContain("successor");
  });
});

describe("catalog comparison", () => {
  const table = (name: string, x: Partial<CatalogTable> = {}): CatalogTable => ({ schema: "public", name, partitioned: false, partitions: 0, rlsEnabled: true, rlsForced: true, tenantColumn: "organization_id", columns: [], constraints: [], indexes: [], policies: [{ name: "p", command: "ALL", permissive: true, roles: ["public"], using: "true", withCheck: null }], triggers: [], ...x });
  const owners = new Map([["patient", [5]], ["claim", [23]], ["missing", [9]]]);
  test("planted defects are each reported", () => {
    const f = compareCatalog([
      table("patient", { rlsEnabled: false }),
      table("claim", { rlsForced: false }),
      table("orphan"),
      table("_chartwarden_migration", { tenantColumn: null, rlsEnabled: false, policies: [] }),
      table("audit_event", { policies: [] }),
    ], owners, new Set(["audit_event"]));
    const codes = f.map((x) => `${x.code}:${x.table}`);
    expect(codes).toContain("TENANT_TABLE_WITHOUT_RLS:patient");
    expect(codes).toContain("RLS_NOT_FORCED:claim");
    expect(codes).toContain("MANIFEST_TABLE_NOT_IN_DATABASE:missing");
    expect(codes).toContain("DATABASE_TABLE_NOT_IN_MANIFEST:orphan");
    expect(codes).toContain("RLS_WITHOUT_POLICY:audit_event");
    expect(codes.some((c) => c.includes("_chartwarden_migration") && c.startsWith("DATABASE_TABLE"))).toBe(false);
  });
  test("any non-bootstrap role with BYPASSRLS or SUPERUSER is a finding", () => {
    expect(checkRoles([
      { name: "postgres", superuser: true, bypassRls: true, login: true },
      { name: "chartwarden_app", superuser: false, bypassRls: true, login: true },
      { name: "chartwarden_readonly", superuser: false, bypassRls: false, login: false },
    ]).map((r) => r.table)).toEqual(["(role) chartwarden_app"]);
  });
});
