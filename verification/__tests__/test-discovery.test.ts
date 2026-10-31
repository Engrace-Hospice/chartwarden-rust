import {describe,test,expect} from "bun:test";
import {parseVitest,parsePlaywright,stableId,compareInventory,classifyExecution,parseJsonOutput} from "../src/test-discovery";
describe("runner-native test inventory",()=>{
 test("Vitest nested suites and generated cases get stable IDs",()=>{
   const x=[{filepath:"/repo/apps/backend/a.test.ts",type:"suite",name:"a.test.ts",tasks:[{type:"suite",name:"claim",tasks:[{type:"test",name:"row 1"},{type:"test",name:"row 2"}]}]}];
   const t=parseVitest(x,"/repo");
   expect(t.map(x=>x.id)).toEqual(["vitest::apps/backend/a.test.ts::claim › row 1","vitest::apps/backend/a.test.ts::claim › row 2"]);
 });
 test("Playwright project is part of identity",()=>{
   const x={suites:[{file:"/repo/e2e/smoke.spec.ts",title:"smoke.spec.ts",specs:[{title:"works",tests:[{projectName:"chromium"},{projectName:"firefox"}]}]}]};
   expect(parsePlaywright(x,"/repo").map(t=>t.id)).toEqual(["playwright::chromium::e2e/smoke.spec.ts::works","playwright::firefox::e2e/smoke.spec.ts::works"]);
 });
 test("duplicate identities fail closed",()=>{
   const x=[{filepath:"/repo/a.test.ts",type:"test",name:"same"},{filepath:"/repo/a.test.ts",type:"test",name:"same"}];
   expect(()=>parseVitest(x,"/repo")).toThrow("Duplicate test ID");
 });
 test("stable IDs normalize path separators",()=>{
   expect(stableId("vitest","apps\\x.test.ts","test")).toBe("vitest::apps/x.test.ts::test");
 });
 test("unapproved test disappearance is detected",()=>{
   expect(compareInventory(["a","b"],["a","c"])).toEqual(["b"]);
   expect(compareInventory(["a","b"],["a","c"],["b"])).toEqual([]);
 });
 test("live suites are blocked, not passed",()=>{
   const input=[{id:"x",runner:"vitest" as const,file:"packages/db/migrations/a.live.test.ts",fullName:"x",status:"NOT_RUN" as const}];
   expect(classifyExecution(input,{}, {postgresReady:false,valkeyReady:false})[0].status).toBe("BLOCKED");
 });
 test("non-live unexecuted tests are NOT_RUN",()=>{
   const input=[{id:"x",runner:"vitest" as const,file:"apps/a.test.ts",fullName:"x",status:"NOT_RUN" as const}];
   expect(classifyExecution(input,{}, {postgresReady:false,valkeyReady:false})[0].status).toBe("NOT_RUN");
 });
 test("runner results override environment classification",()=>{
   const input=[{id:"x",runner:"vitest" as const,file:"a.live.test.ts",fullName:"x",status:"NOT_RUN" as const}];
   expect(classifyExecution(input,{x:"FAIL"}, {postgresReady:false,valkeyReady:false})[0].status).toBe("FAIL");
 });
 test("malformed output fails closed",()=>{expect(()=>parseJsonOutput("no json")).toThrow();});
});
