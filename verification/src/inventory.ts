import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, relative, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

type Module = { id: number; name: string; codePaths: string[]; dependsOn: number[]; ownedTables: string[] };
type Route = { method: string; path: string; module: string; file: string; openapi: boolean; runtimeRegistered: "UNKNOWN"; auth: "UNKNOWN" };
const root = resolve(import.meta.dir, "../..");
const config = JSON.parse(readFileSync(join(root, "verification/config.json"), "utf8"));
const sourceArg = process.argv.indexOf("--source");
if (sourceArg < 0 || !process.argv[sourceArg + 1]) throw new Error("Usage: bun run verify:inventory --source /absolute/path/to/chartwarden");
const source = resolve(process.argv[sourceArg + 1]);
if (!existsSync(join(source, "architecture/module-manifest.ts"))) throw new Error("Invalid upstream checkout: missing module manifest");
const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", source, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
};
const sha = git(["rev-parse", "HEAD"]);
if (sha !== config.upstream.ref) throw new Error(`Source commit mismatch: expected ${config.upstream.ref}, got ${sha}`);
if (git(["status", "--porcelain"]).length) throw new Error("Upstream checkout must be clean for an approved inventory");
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
const canonical = (data: unknown) => JSON.stringify(data, null, 2) + "\n";
function walk(path: string): string[] {
  if (!existsSync(path)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
    if (["node_modules", "dist", ".git", "__tests__", ".next"].includes(entry.name)) continue;
    const next = join(path, entry.name);
    if (entry.isDirectory()) out.push(...walk(next));
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)) out.push(next);
  }
  return out;
}
const manifestUrl = pathToFileURL(join(source, "architecture/module-manifest.ts")).href;
const manifest = await import(manifestUrl);
const modules: Module[] = [...manifest.MODULES].sort((a,b)=>a.id-b.id);
if (!modules.length) throw new Error("No modules exported by manifest");
const moduleIds = new Set(modules.map(m=>m.id));
const findings: { code: string; detail: string }[] = [];
const owners = new Map<string, number[]>();
for (const m of modules) {
  for (const dep of m.dependsOn) if (!moduleIds.has(dep)) findings.push({code:"UNKNOWN_DEPENDENCY",detail:`${m.id} -> ${dep}`});
  for (const table of m.ownedTables) owners.set(table, [...(owners.get(table) ?? []), m.id]);
  for (const path of m.codePaths) if (!existsSync(join(source,path))) findings.push({code:"MISSING_CODE_PATH",detail:`${m.id}: ${path}`});
}
for (const [table, ids] of owners) if (ids.length !== 1) findings.push({code:"DUPLICATE_TABLE_OWNER",detail:`${table}: ${ids.join(",")}`});
const files = walk(join(source, "apps/backend/src"));
const openapiPath = join(source, "docs/api/openapi.json");
const openapi = existsSync(openapiPath) ? JSON.parse(readFileSync(openapiPath,"utf8")) : {paths:{}};
const routes: Route[] = [];
const imports: {from:string;specifier:string;line:number}[] = [];
for (const file of files) {
  const rel = relative(source,file).replaceAll("\\","/");
  const src = readFileSync(file,"utf8");
  const slug = rel.match(/modules\/([^/]+)\//)?.[1] ?? "bootstrap";
  for (const m of src.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
    const method=m[1].toUpperCase(), path=m[2];
    const oaPath=path.replace(/:([A-Za-z_][\w]*)/g,"{$1}");
    const documented=Boolean(openapi.paths?.[oaPath]?.[method.toLowerCase()]);
    routes.push({method,path,module:slug,file:rel,openapi:documented,runtimeRegistered:"UNKNOWN",auth:"UNKNOWN"});
    if (!documented) findings.push({code:"ROUTE_NOT_IN_OPENAPI",detail:`${method} ${path} in ${rel}`});
  }
  for (const m of src.matchAll(/(?:import|export)\s+(?:[^"'\n]*?\s+from\s+)?["']([^"']+)["']/g)) {
    imports.push({from:rel,specifier:m[1],line:src.slice(0,m.index).split("\n").length});
  }
}
routes.sort((a,b)=>(a.path+" "+a.method+" "+a.file).localeCompare(b.path+" "+b.method+" "+b.file));
imports.sort((a,b)=>(a.from+":"+String(a.line)).localeCompare(b.from+":"+String(b.line)));
const output = join(root, config.outputDirectory, sha);
mkdirSync(output,{recursive:true});
const artifacts: Record<string,unknown> = {
  "modules.json": {sourceCommit:sha,modules,findings:findings.filter(x=>x.code==="MISSING_CODE_PATH")},
  "dependencies.json": {sourceCommit:sha,declared:modules.flatMap(m=>m.dependsOn.map(dep=>({from:m.id,to:dep}))),imports,findings:findings.filter(x=>x.code==="UNKNOWN_DEPENDENCY"),note:"Raw imports only; resolved module edges and cycle detection pending M00-003"},
  "routes.json": {sourceCommit:sha,routes,findings:findings.filter(x=>x.code==="ROUTE_NOT_IN_OPENAPI"),note:"Static literal scanner only; runtime registration and auth status remain UNKNOWN until M00-004"},
  "database-ownership.json": {sourceCommit:sha,tables:[...owners].sort(([a],[b])=>a.localeCompare(b)).map(([table,ownerIds])=>({table,ownerIds,rls:"UNKNOWN",catalogVerified:false})),findings:findings.filter(x=>x.code==="DUPLICATE_TABLE_OWNER"),note:"Declared ownership only; migrated PostgreSQL catalog comparison pending M00-005"}
};
const checksums: Record<string,string>={};
for (const [name,data] of Object.entries(artifacts)) {
  const content=canonical(data);
  writeFileSync(join(output,name),content);
  checksums[name]=sha256(content);
}
writeFileSync(join(output,"run-manifest.json"),canonical({upstream:config.upstream,sourceCommit:sha,dirty:false,tool:"m00-static-inventory-v0",checksums,limitations:["No live database access","No runtime route registration","No test execution"]}));
writeFileSync(join(output,"summary.md"),`# M00 static inventory\n\nSource commit: ${sha}\n\nModules: ${modules.length}\nDeclared tables: ${owners.size}\nStatic routes: ${routes.length}\nFindings: ${findings.length}\n\n**Not a complete M00 baseline.** Runtime routes, PostgreSQL catalog, test execution and approved baseline verification remain pending.\n`);
console.log(`Wrote preliminary inventory to ${output}; ${findings.length} findings. No upstream files modified.`);
