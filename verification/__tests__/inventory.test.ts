import { describe, expect, test } from "bun:test";
import { scanSource, normalizeOpenApiPath, compareRoutes, validateOwners, findMissingTests } from "../src/inventory-v2";

describe("M00 AST extraction negative controls", () => {
  test("captures multiline imports and re-exports", () => {
    const s=`import {
      getAck,
      saveAck,
    } from "./ack-types";
    export { thing } from "../other";`;
    const result=scanSource(s,"packages/billing/src/ack-store-db.ts");
    expect(result.imports.map(x=>x.specifier)).toEqual(["./ack-types","../other"]);
  });
  test("detects templated FHIR route as unresolved", () => {
    const s="app.get(\`/fhir/\${resource}\`, handler)";
    const result=scanSource(s,"apps/backend/src/modules/28-fhir/routes/fhir-r4.routes.ts");
    expect(result.findings.some(f=>f.code==="UNRESOLVED_ROUTE")).toBe(true);
  });
  test("detects scoped webhook constant as unresolved", () => {
    const result=scanSource("scope.post(DOSESPOT_WEBHOOK_PATH, handler)","apps/backend/src/modules/19-medications/routes/webhooks.ts");
    expect(result.findings.some(f=>f.code==="UNRESOLVED_ROUTE")).toBe(true);
  });
  test("escaped Fastify colon is literal and does not become path parameter", () => {
    expect(normalizeOpenApiPath("/claims/::bulk-approve")).toBe("/claims/:bulk-approve");
    expect(normalizeOpenApiPath("/patients/:id")).toBe("/patients/{id}");
  });
  test("matches escaped-colon OpenAPI route", () => {
    const r=scanSource('app.post("/claims/::bulk-approve", handler)',"apps/backend/src/modules/20-billing/routes.ts");
    expect(compareRoutes(r.routes,{paths:{"/claims/:bulk-approve":{post:{}}}})).toEqual([]);
    expect(r.routes[0].openapi).toBe(true);
  });
  test("reports absent OpenAPI path", () => {
    const r=scanSource('app.get("/api/new", handler)',"apps/backend/src/modules/20-billing/routes.ts");
    expect(compareRoutes(r.routes,{paths:{}})[0].code).toBe("ROUTE_NOT_IN_OPENAPI");
  });
  test("detects duplicate table owner", () => {
    expect(validateOwners([{id:1,ownedTables:["patient"]},{id:2,ownedTables:["patient"]}])[0].code).toBe("DUPLICATE_TABLE_OWNER");
  });
  test("stable test identity detects replacement by unrelated test", () => {
    expect(findMissingTests(["a::test1","b::test2"],["a::test1","c::test3"])).toEqual(["b::test2"]);
    expect(findMissingTests(["b::test2"],["c::test3"],["b::test2"])).toEqual([]);
  });
});
