import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";

export type Status = "PASS" | "FAIL" | "ERROR" | "BLOCKED" | "SKIPPED" | "NOT_RUN" | "NOT_APPLICABLE";
export type TestCase = { id:string; runner:"vitest"|"playwright"; file:string; fullName:string; project?:string; status:Status; reason?:string; durationMs?:number };
export type Discovery = {runner:string;status:Status;command:string[];exitCode:number|null;stderr:string;tests:TestCase[]};
export const sha256=(s:string)=>createHash("sha256").update(s).digest("hex");
export const canonical=(v:unknown)=>JSON.stringify(v,null,2)+"\n";
export function stableId(runner:string,file:string,fullName:string,project?:string) {
  const normalized=file.replaceAll("\\","/").replace(/^\.\//,"");
  return [runner,project?project+"::"+normalized:normalized,fullName].join("::");
}
function fileOf(raw:string,source:string) {
  const f=raw.replaceAll("\\","/");
  const root=source.replaceAll("\\","/").replace(/\/$/,"");
  return f.startsWith(root+"/")?f.slice(root.length+1):f.replace(/^\.\//,"");
}
export function parseVitest(raw:unknown,source:string):TestCase[] {
  const found:TestCase[]=[];
  const visit=(node:any,suites:string[]=[],file="",project="")=>{
    if(Array.isArray(node)){for(const n of node)visit(n,suites,file,project);return;}
    if(!node||typeof node!=="object")return;
    const f=typeof node.filepath==="string"?node.filepath:typeof node.file==="string"?node.file:file;
    const p=typeof node.projectName==="string"?node.projectName:typeof node.project==="string"?node.project:project;
    const name=typeof node.name==="string"?node.name:typeof node.title==="string"?node.title:"";
    const kind=node.type??node.taskType;
    const children=node.tasks??node.children??node.testResults;
    if(Array.isArray(children)){
      // File and suite containers contribute to the test's full name; file labels do not.
      const next=kind==="suite" && name && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)?[...suites,name]:suites;
      visit(children,next,f,p);
    } else if((kind==="test"||kind==="it"||node.fullName||node.fullTestName) && name) {
      const fullName=String(node.fullName??node.fullTestName??[...suites,name].join(" › "));
      if(!f)throw Error("Vitest test missing file: "+fullName);
      found.push({runner:"vitest",file:fileOf(f,source),fullName,project:p||undefined,id:stableId("vitest",fileOf(f,source),fullName,p||undefined),status:"NOT_RUN"});
    }
    if(!Array.isArray(children)&&Array.isArray(node.files))visit(node.files,suites,f,p);
    if(!Array.isArray(children)&&Array.isArray(node.tests))visit(node.tests,suites,f,p);
  };
  visit(raw);
  return unique(found);
}
export function parsePlaywright(raw:unknown,source:string):TestCase[] {
  const found:TestCase[]=[];
  const visit=(suite:any,titles:string[]=[],file="")=>{
    if(!suite||typeof suite!=="object")return;
    const f=typeof suite.file==="string"?suite.file:file;
    const next=suite.title && !/\.(spec|test)\.[cm]?[jt]sx?$/.test(suite.title)?[...titles,suite.title]:titles;
    for(const spec of suite.specs??[]){
      for(const test of spec.tests??[]){
        const p=typeof test.projectName==="string"?test.projectName:"";
        const fullName=[...next,spec.title].filter(Boolean).join(" › ");
        if(!f)throw Error("Playwright test missing file: "+fullName);
        const rel=fileOf(f,source);
        found.push({runner:"playwright",file:rel,fullName,project:p||undefined,id:stableId("playwright",rel,fullName,p||undefined),status:"NOT_RUN"});
      }
    }
    for(const child of suite.suites??[])visit(child,next,f);
  };
  for(const suite of (raw as any)?.suites??[])visit(suite);
  return unique(found);
}
export function unique(tests:TestCase[]) {
  const ids=new Set<string>();
  for(const t of tests){if(ids.has(t.id))throw Error("Duplicate test ID: "+t.id);ids.add(t.id);}
  return tests.sort((a,b)=>a.id.localeCompare(b.id));
}
export function compareInventory(previous:string[],current:string[],approvedRetirements:string[]=[]) {
  const cur=new Set(current),retired=new Set(approvedRetirements);
  return previous.filter(id=>!cur.has(id)&&!retired.has(id)).sort();
}
export function classifyExecution(discovered:TestCase[], results:Record<string,Status>, environment:{postgresReady:boolean;valkeyReady:boolean}) {
  return discovered.map(t=>{
    const status=results[t.id];
    if(status)return {...t,status};
    const live=/\.live\.test\.|\.integration\.test\.|\/__tests__\/.*\.live\./.test(t.file);
    if(live&&!environment.postgresReady)return {...t,status:"BLOCKED" as const,reason:"Ephemeral PostgreSQL not provisioned; suite not executed"};
    return {...t,status:"NOT_RUN" as const,reason:"Not executed; no runner result"};
  });
}
export function parseJsonOutput(stdout:string):unknown {
  const text=stdout.trim();
  try{return JSON.parse(text);}catch{}
  // Runner may print a banner before JSON; refuse ambiguous multi-document output.
  const pos=[text.indexOf("{"),text.indexOf("[")].filter(i=>i>=0).sort((a,b)=>a-b)[0];
  if(pos===undefined)throw Error("Runner produced no JSON");
  return JSON.parse(text.slice(pos));
}
export async function runner(source:string,args:string[],timeoutMs=180000):Promise<{exitCode:number|null;stdout:string;stderr:string;timedOut:boolean}> {
  const proc=Bun.spawn(args,{cwd:source,stdout:"pipe",stderr:"pipe",env:{...process.env,CI:"true",DATABASE_URL:"",REDIS_URL:"",VALKEY_URL:"",NODE_ENV:"test"}});
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;proc.kill();},timeoutMs);
  const [stdout,stderr,exitCode]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  clearTimeout(timer);
  return {exitCode,stdout,stderr,timedOut};
}
function git(source:string,...args:string[]){
  const r=Bun.spawnSync(["git","-C",source,...args],{stdout:"pipe",stderr:"pipe"});
  if(r.exitCode!==0)throw Error(new TextDecoder().decode(r.stderr));
  return new TextDecoder().decode(r.stdout).trim();
}
async function main(){
  const root=resolve(import.meta.dir,"../..");
  const cfgText=readFileSync(join(root,"verification/config.json"),"utf8"),cfg=JSON.parse(cfgText);
  const i=process.argv.indexOf("--source");
  if(i<0||!process.argv[i+1])throw Error("Usage: bun run verify:discover --source /path/to/chartwarden");
  const source=resolve(process.argv[i+1]),sha=git(source,"rev-parse","HEAD");
  if(sha!==cfg.upstream.ref)throw Error("Untrusted upstream SHA: "+sha);
  const dirty=Boolean(git(source,"status","--porcelain","--untracked-files=all"));
  const output=join(root,cfg.outputDirectory,sha);mkdirSync(output,{recursive:true});
  const specs:{runner:"vitest"|"playwright";command:string[];enabled:boolean}[]=[
    {runner:"vitest",command:["bun","x","vitest","list","--json"],enabled:true},
    {runner:"playwright",command:["bun","x","playwright","test","--list","--reporter=json"],enabled:existsSync(join(source,"playwright.config.ts"))||existsSync(join(source,"playwright.config.mts"))||existsSync(join(source,"playwright.config.js"))}
  ];
  const discovered:TestCase[]=[],runs:Discovery[]=[];
  for(const spec of specs){
    if(!spec.enabled){runs.push({runner:spec.runner,status:"NOT_APPLICABLE",command:spec.command,exitCode:null,stderr:"No Playwright configuration detected",tests:[]});continue;}
    try{
      const r=await runner(source,spec.command);
      if(r.timedOut||r.exitCode!==0) {runs.push({runner:spec.runner,status:"ERROR",command:spec.command,exitCode:r.exitCode,stderr:(r.timedOut?"Timed out. ":"")+r.stderr.slice(0,4000),tests:[]});continue;}
      const tests=spec.runner==="vitest"?parseVitest(parseJsonOutput(r.stdout),source):parsePlaywright(parseJsonOutput(r.stdout),source);
      if(!tests.length){runs.push({runner:spec.runner,status:"ERROR",command:spec.command,exitCode:r.exitCode,stderr:"Runner returned zero parseable test IDs; cannot approve discovery",tests:[]});continue;}
      discovered.push(...tests);
      runs.push({runner:spec.runner,status:"PASS",command:spec.command,exitCode:r.exitCode,stderr:r.stderr.slice(0,4000),tests:[]});
    }catch(e){runs.push({runner:spec.runner,status:"ERROR",command:spec.command,exitCode:null,stderr:String(e),tests:[]});}
  }
  unique(discovered);
  const tests=classifyExecution(discovered,{}, {postgresReady:false,valkeyReady:false});
  const payload={sourceCommit:sha,dirty,approvedBaselineEligible:!dirty&&runs.every(r=>r.status==="PASS"||r.status==="NOT_APPLICABLE"),discovery:runs,tests,counts:Object.fromEntries(["PASS","FAIL","ERROR","BLOCKED","SKIPPED","NOT_RUN","NOT_APPLICABLE"].map(s=>[s,tests.filter(t=>t.status===s).length]))};
  const content=canonical(payload);writeFileSync(join(output,"test-results.json"),content);
  const manifest={sourceCommit:sha,dirty,configHash:sha256(cfgText),bunVersion:Bun.version,discoveryChecksums:{"test-results.json":sha256(content)},timestamp:new Date().toISOString(),note:"Discovery only; no tests executed. NOT_RUN/BLOCKED are not passing."};
  writeFileSync(join(output,"test-discovery-manifest.json"),canonical(manifest));
  console.log(JSON.stringify({discovered:tests.length,runners:runs.map(r=>({runner:r.runner,status:r.status,reason:r.stderr.slice(0,200)})),output},null,2));
  if(runs.some(r=>r.status==="ERROR"))process.exitCode=1;
}
if(import.meta.main)await main();
