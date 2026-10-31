import ts from "typescript";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

export type Finding = { code: string; file: string; line: number; detail: string };
export type ImportEdge = { from: string; specifier: string; line: number; kind: string };
export type Route = { method: string; path: string | null; expression: string; module: string; file: string; line: number; openapi: boolean | "UNKNOWN"; runtimeRegistered: "UNKNOWN"; auth: "UNKNOWN" };
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const ignored = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".turbo"]);
export function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e => {
    if (ignored.has(e.name)) return [];
    const p=join(dir,e.name);
    if (e.isDirectory()) return walk(p);
    return e.isFile() && /\.(ts|tsx|mts|cts)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) ? [p] : [];
  });
}
const position = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
export function normalizeOpenApiPath(path: string): string {
  // Fastify double-colon escapes a literal colon, e.g. /foo/::bulk-approve.
  return path.replace(/::/g, "\u0000").replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}").replace(/\u0000/g, ":");
}
function staticPath(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return null;
  return null;
}
export function scanSource(src: string, file: string): { imports: ImportEdge[]; routes: Route[]; findings: Finding[] } {
  const sf=ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true,file.endsWith("tsx")?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  const imports: ImportEdge[]=[],routes: Route[]=[],findings: Finding[]=[];
  const module=file.match(/apps\/backend\/src\/modules\/([^/]+)\//)?.[1] ?? "bootstrap";
  function addImport(spec: ts.Expression, node: ts.Node, kind: string) {
    if (ts.isStringLiteralLike(spec)) imports.push({from:file,specifier:spec.text,line:position(sf,node),kind});
    else findings.push({code:"UNRESOLVED_IMPORT",file,line:position(sf,node),detail:spec.getText(sf).slice(0,160)});
  }
  function visit(n: ts.Node) {
    if (ts.isImportDeclaration(n) && n.moduleSpecifier) addImport(n.moduleSpecifier,n,"import");
    if (ts.isExportDeclaration(n) && n.moduleSpecifier) addImport(n.moduleSpecifier,n,"export");
    if (ts.isCallExpression(n)) {
      if (n.expression.kind===ts.SyntaxKind.ImportKeyword && n.arguments[0]) addImport(n.arguments[0],n,"dynamic-import");
      if (ts.isIdentifier(n.expression) && n.expression.text==="require" && n.arguments[0]) addImport(n.arguments[0],n,"require");
      if (ts.isPropertyAccessExpression(n.expression) && ["get","post","put","patch","delete","head","options","all"].includes(n.expression.name.text) && n.arguments.length>0) {
        const receiver=n.expression.expression.getText(sf);
        // Registration-like calls are candidates, not proof of runtime registration.
        // Limit to backend route files or common Fastify receiver names to avoid counting arbitrary collection methods.
        if (file.startsWith("apps/backend/src/") && (/(route|router|app|scope|server|fastify)/i.test(receiver) || /routes?\//.test(file))) {
          const arg=n.arguments[0],path=staticPath(arg),method=n.expression.name.text.toUpperCase();
          routes.push({method,path,expression:arg.getText(sf).slice(0,200),module,file,line:position(sf,n),openapi:"UNKNOWN",runtimeRegistered:"UNKNOWN",auth:"UNKNOWN"});
          if (path===null) findings.push({code:"UNRESOLVED_ROUTE",file,line:position(sf,n),detail:`${method} ${arg.getText(sf).slice(0,160)}`});
        }
      }
      if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text==="route" && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
        const obj=n.arguments[0];
        const url=obj.properties.find(p=>ts.isPropertyAssignment(p) && p.name.getText(sf)==="url") as ts.PropertyAssignment|undefined;
        const method=obj.properties.find(p=>ts.isPropertyAssignment(p) && p.name.getText(sf)==="method") as ts.PropertyAssignment|undefined;
        if (url && file.startsWith("apps/backend/src/")) {
          const path=staticPath(url.initializer);
          const verb=method && ts.isStringLiteral(method.initializer)?method.initializer.text.toUpperCase():"UNKNOWN";
          routes.push({method:verb,path,expression:url.initializer.getText(sf).slice(0,200),module,file,line:position(sf,n),openapi:"UNKNOWN",runtimeRegistered:"UNKNOWN",auth:"UNKNOWN"});
          if (path===null || verb==="UNKNOWN") findings.push({code:"UNRESOLVED_ROUTE",file,line:position(sf,n),detail:obj.getText(sf).slice(0,160)});
        }
      }
    }
    ts.forEachChild(n,visit);
  }
  visit(sf);
  return {imports,routes,findings};
}
export function compareRoutes(routes: Route[], openapi: any): Finding[] {
  const findings: Finding[]=[];
  for (const r of routes) {
    if (r.path===null || r.method==="UNKNOWN") continue;
    const normalized=normalizeOpenApiPath(r.path);
    const documented=Boolean(openapi.paths?.[normalized]?.[r.method.toLowerCase()]);
    r.openapi=documented;
    if (!documented) findings.push({code:"ROUTE_NOT_IN_OPENAPI",file:r.file,line:r.line,detail:`${r.method} ${r.path} (normalized ${normalized})`});
  }
  return findings;
}
export function validateOwners(modules: {id:number;ownedTables:string[]}[]): Finding[] {
  const owners=new Map<string,number[]>();
  for (const m of modules) for (const table of m.ownedTables) owners.set(table,[...(owners.get(table)??[]),m.id]);
  return [...owners].filter(([,ids])=>ids.length!==1).map(([table,ids])=>({code:"DUPLICATE_TABLE_OWNER",file:"architecture/module-manifest.ts",line:0,detail:`${table}: ${ids.join(",")}`}));
}
export function findMissingTests(previous: string[], current: string[], retirements: string[]=[]): string[] {
  const now=new Set(current),allowed=new Set(retirements);
  return previous.filter(id=>!now.has(id)&&!allowed.has(id)).sort();
}
async function main() {
  const project=resolve(import.meta.dir,"../..");
  const configText=readFileSync(join(project,"verification/config.json"),"utf8");
  const config=JSON.parse(configText);
  const idx=process.argv.indexOf("--source");
  if(idx<0 || !process.argv[idx+1]) throw Error("Usage: bun run verify:inventory --source /path/to/chartwarden");
  const source=resolve(process.argv[idx+1]);
  if(!existsSync(join(source,"architecture/module-manifest.ts"))) throw Error("Missing upstream manifest");
  function git(...args:string[]) {
    const p=Bun.spawnSync(["git","-C",source,...args],{stdout:"pipe",stderr:"pipe"});
    if(p.exitCode!==0) throw Error(new TextDecoder().decode(p.stderr));
    return new TextDecoder().decode(p.stdout).trim();
  }
  const sha=git("rev-parse","HEAD");
  if(sha!==config.upstream.ref) throw Error(`Pinned SHA mismatch: expected ${config.upstream.ref}; got ${sha}`);
  const dirty=Boolean(git("status","--porcelain","--untracked-files=all"));
  const manifest=await import(pathToFileURL(join(source,"architecture/module-manifest.ts")).href);
  const modules=[...manifest.MODULES].sort((a:any,b:any)=>a.id-b.id);
  const findings:Finding[]=validateOwners(modules);
  for(const m of modules) for(const p of m.codePaths) if(!existsSync(join(source,p))) findings.push({code:"MISSING_CODE_PATH",file:"architecture/module-manifest.ts",line:0,detail:`${m.id}: ${p}`});
  const ids=new Set(modules.map((m:any)=>m.id));
  for(const m of modules) for(const d of m.dependsOn) if(!ids.has(d)) findings.push({code:"UNKNOWN_DEPENDENCY",file:"architecture/module-manifest.ts",line:0,detail:`${m.id} -> ${d}`});
  const paths=[...walk(join(source,"apps")),...walk(join(source,"packages"))];
  const imports:ImportEdge[]=[],routes:Route[]=[];
  for(const p of paths) {
    const rel=relative(source,p).replaceAll("\\","/");
    const scanned=scanSource(readFileSync(p,"utf8"),rel);
    imports.push(...scanned.imports);routes.push(...scanned.routes);findings.push(...scanned.findings);
  }
  const openapiPath=join(source,"docs/api/openapi.json");
  const openapi=existsSync(openapiPath)?JSON.parse(readFileSync(openapiPath,"utf8")):{paths:{}};
  findings.push(...compareRoutes(routes,openapi));
  imports.sort((a,b)=>(a.from+":"+String(a.line)+":"+a.specifier).localeCompare(b.from+":"+String(b.line)+":"+b.specifier));
  routes.sort((a,b)=>(a.file+":"+String(a.line)+":"+a.method).localeCompare(b.file+":"+String(b.line)+":"+b.method));
  findings.sort((a,b)=>(a.code+":"+a.file+":"+String(a.line)+":"+a.detail).localeCompare(b.code+":"+b.file+":"+String(b.line)+":"+b.detail));
  const owners=new Map<string,number[]>();
  for(const m of modules) for(const table of m.ownedTables) owners.set(table,[...(owners.get(table)??[]),m.id]);
  const artifacts:Record<string,unknown>={
    "modules.json":{sourceCommit:sha,modules},
    "dependencies.json":{sourceCommit:sha,declared:modules.flatMap((m:any)=>m.dependsOn.map((to:number)=>({from:m.id,to}))),imports,note:"AST-extracted workspace imports; module resolution and forbidden-edge analysis pending"},
    "routes.json":{sourceCommit:sha,routes,note:"AST route candidates; runtime registration remains UNKNOWN"},
    "database-ownership.json":{sourceCommit:sha,tables:[...owners].sort(([a],[b])=>a.localeCompare(b)).map(([table,ownerIds])=>({table,ownerIds,rls:"UNKNOWN",catalogVerified:false})),note:"Manifest only; database catalog pending"},
    "findings.json":{sourceCommit:sha,findings}
  };
  const out=join(project,config.outputDirectory,sha);mkdirSync(out,{recursive:true});
  const checksums:Record<string,string>={};
  for(const [name,data] of Object.entries(artifacts)){const s=json(data);writeFileSync(join(out,name),s);checksums[name]=digest(s);}
  const summary=`# M00 preliminary static inventory\n\nSource SHA: ${sha}\n\nModules: ${modules.length}\nDeclared tables: ${owners.size}\nAST imports: ${imports.length}\nRoute candidates: ${routes.length}\nUnresolved routes: ${findings.filter(f=>f.code==="UNRESOLVED_ROUTE").length}\nFindings: ${findings.length}\n\n**NOT AN APPROVED BASELINE.** Module dependency resolution, runtime routes, database catalog, tests and CI gates remain pending.\n`;
  writeFileSync(join(out,"summary.md"),summary);checksums["summary.md"]=digest(summary);
  const run={sourceCommit:sha,sourceDirty:dirty,approvedBaselineEligible:!dirty,sourceDiffHash:dirty?digest(git("diff","HEAD")+"\n"+git("ls-files","--others","--exclude-standard")):null,tool:"m00-ast-inventory-v1",bunVersion:Bun.version,typescriptVersion:ts.version,configHash:digest(configText),startedAt:new Date().toISOString(),checksums,limitations:["No database catalog","No runtime route proof","No test execution","No module dependency resolution"]};
  writeFileSync(join(out,"run-manifest.json"),json(run));
  console.log(`M00 preliminary inventory: ${modules.length} modules, ${imports.length} imports, ${routes.length} route candidates, ${findings.length} findings. Dirty=${dirty}. Output: ${out}`);
}
if(import.meta.main) await main();
