/**
 * M00-005 — PostgreSQL catalog and RLS comparison.
 *
 *   verify:catalog --source <upstream> --database-url postgres://…@localhost/<empty db> [--migrate]
 *
 * With --migrate, upstream's own migrator (`scripts/db/migrate.ts --strict --schema-only`, the same
 * flags as its pre-deploy gate) is run into the given EMPTY ephemeral database first. The catalog is
 * then read from pg_catalog and compared with the module manifest's declared table ownership.
 *
 * Findings:
 *   MANIFEST_TABLE_NOT_IN_DATABASE / DATABASE_TABLE_NOT_IN_MANIFEST
 *   TENANT_TABLE_WITHOUT_RLS      — has an organization_id column but RLS is not enabled
 *   RLS_NOT_FORCED                — RLS enabled but not forced (table owner bypasses it)
 *   RLS_WITHOUT_POLICY            — RLS enabled with no policy (deny-all; usually a mistake)
 *   TABLE_WITHOUT_TENANT_COLUMN   — informational: manifest-owned table with no organization_id
 *   ROLE_BYPASSES_RLS             — a non-bootstrap role is SUPERUSER or has BYPASSRLS
 * Tables in the manifest's HELPER_ONLY_TABLES are expected to exist without a module owner.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonical, runner, sha256 } from "./test-discovery";
import { assertEphemeralUrl } from "./test-execution";

export type CatalogTable = {
  schema: string; name: string; partitioned: boolean; partitions: number;
  rlsEnabled: boolean; rlsForced: boolean; tenantColumn: string | null;
  columns: { name: string; type: string; notNull: boolean; default: string | null }[];
  constraints: { name: string; type: string; definition: string }[];
  indexes: { name: string; definition: string }[];
  policies: { name: string; command: string; permissive: boolean; roles: string[]; using: string | null; withCheck: string | null }[];
  triggers: { name: string; definition: string }[];
};
export type CatalogFinding = { code: string; table: string; detail: string };

/** Names the migrator itself owns; never module-owned. */
export const MIGRATION_TRACKER_TABLES = new Set(["_chartwarden_migration"]);
export type DbRole = { name: string; superuser: boolean; bypassRls: boolean; login: boolean };

/** ADR-0060 invariant 6: no application role may bypass RLS. The postgres bootstrap superuser is excluded. */
export function checkRoles(roles: DbRole[]): CatalogFinding[] {
  return roles
    .filter((r) => r.name !== "postgres" && !r.name.startsWith("pg_") && (r.bypassRls || r.superuser))
    .map((r) => ({ code: "ROLE_BYPASSES_RLS", table: "(role) " + r.name, detail: r.superuser ? "role is SUPERUSER" : "role has BYPASSRLS" }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

export function compareCatalog(tables: CatalogTable[], manifestOwners: Map<string, number[]>, helperOnly: Set<string>): CatalogFinding[] {
  const f: CatalogFinding[] = [];
  const inDb = new Set(tables.filter((t) => t.schema === "public").map((t) => t.name));
  for (const [table, owners] of manifestOwners) if (!inDb.has(table)) f.push({ code: "MANIFEST_TABLE_NOT_IN_DATABASE", table, detail: `declared by module(s) ${owners.join(",")} but not created by migrations` });
  for (const t of tables) {
    const q = t.schema === "public" ? t.name : `${t.schema}.${t.name}`;
    const owned = t.schema === "public" && manifestOwners.has(t.name);
    if (!owned && !helperOnly.has(t.name) && !MIGRATION_TRACKER_TABLES.has(t.name)) f.push({ code: "DATABASE_TABLE_NOT_IN_MANIFEST", table: q, detail: "created by migrations but owned by no module" });
    if (t.tenantColumn && !t.rlsEnabled) f.push({ code: "TENANT_TABLE_WITHOUT_RLS", table: q, detail: `has ${t.tenantColumn} but row-level security is disabled` });
    if (t.rlsEnabled && !t.rlsForced) f.push({ code: "RLS_NOT_FORCED", table: q, detail: "RLS enabled but not FORCE'd; the table owner bypasses policies" });
    if (t.rlsEnabled && t.policies.length === 0) f.push({ code: "RLS_WITHOUT_POLICY", table: q, detail: "RLS enabled with no policy: every non-owner query returns nothing" });
    if (owned && !t.tenantColumn) f.push({ code: "TABLE_WITHOUT_TENANT_COLUMN", table: q, detail: "informational: no organization_id column (platform/global table?)" });
  }
  return f.sort((a, b) => `${a.code}|${a.table}`.localeCompare(`${b.code}|${b.table}`));
}

export async function readCatalog(url: string): Promise<CatalogTable[]> {
  const sql = new Bun.SQL(url);
  try {
    const rels: any[] = await sql`
      select c.oid, n.nspname as schema, c.relname as name, c.relkind = 'p' as partitioned,
             c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             (select count(*)::int from pg_inherits i where i.inhparent = c.oid) as partitions
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','p') and not c.relispartition
        and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
      order by n.nspname, c.relname`;
    const cols: any[] = await sql`
      select a.attrelid as oid, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull,
             pg_get_expr(d.adbin, d.adrelid) as def
      from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attnum > 0 and not a.attisdropped order by a.attrelid, a.attnum`;
    const cons: any[] = await sql`select conrelid as oid, conname as name, contype as type, pg_get_constraintdef(oid) as def from pg_constraint where conrelid <> 0 order by conrelid, conname`;
    const idx: any[] = await sql`select i.indrelid as oid, c.relname as name, pg_get_indexdef(i.indexrelid) as def from pg_index i join pg_class c on c.oid = i.indexrelid order by i.indrelid, c.relname`;
    const pols: any[] = await sql`select polrelid as oid, polname as name, polcmd as cmd, polpermissive as permissive,
             coalesce((select array_agg(rolname order by rolname) from pg_roles where oid = any(polroles)), array['public']) as roles,
             pg_get_expr(polqual, polrelid) as using, pg_get_expr(polwithcheck, polrelid) as check
      from pg_policy order by polrelid, polname`;
    const trg: any[] = await sql`select tgrelid as oid, tgname as name, pg_get_triggerdef(oid) as def from pg_trigger where not tgisinternal order by tgrelid, tgname`;
    const group = <T>(rows: any[], map: (r: any) => T) => { const m = new Map<number, T[]>(); for (const r of rows) { const k = Number(r.oid); m.set(k, [...(m.get(k) ?? []), map(r)]); } return m; };
    const C = group(cols, (r) => ({ name: r.name, type: r.type, notNull: r.notnull, default: r.def ?? null }));
    const K = group(cons, (r) => ({ name: r.name, type: ({ p: "PRIMARY KEY", f: "FOREIGN KEY", u: "UNIQUE", c: "CHECK", x: "EXCLUSION", n: "NOT NULL", t: "TRIGGER" } as Record<string, string>)[r.type] ?? r.type, definition: r.def }));
    const I = group(idx, (r) => ({ name: r.name, definition: r.def }));
    const P = group(pols, (r) => ({ name: r.name, command: ({ r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", "*": "ALL" } as Record<string, string>)[r.cmd] ?? r.cmd, permissive: r.permissive, roles: [...r.roles], using: r.using ?? null, withCheck: r.check ?? null }));
    const T = group(trg, (r) => ({ name: r.name, definition: r.def }));
    return rels.map((r) => {
      const oid = Number(r.oid);
      const columns = C.get(oid) ?? [];
      const tenant = columns.find((c) => c.name === "organization_id" || c.name === "org_id" || c.name === "tenant_id");
      return { schema: r.schema, name: r.name, partitioned: r.partitioned, partitions: r.partitions, rlsEnabled: r.rls, rlsForced: r.forced, tenantColumn: tenant?.name ?? null,
        columns, constraints: K.get(oid) ?? [], indexes: I.get(oid) ?? [], policies: P.get(oid) ?? [], triggers: T.get(oid) ?? [] };
    });
  } finally {
    await sql.close();
  }
}

const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const root = resolve(import.meta.dir, "../..");
  const cfg = JSON.parse(await Bun.file(join(root, "verification/config.json")).text());
  const sourceArg = flag("--source"), url = flag("--database-url");
  if (!sourceArg || !url) throw Error("Usage: verify:catalog --source <upstream> --database-url postgres://…@localhost/<db> [--migrate]");
  assertEphemeralUrl(url, "Database");
  const source = resolve(sourceArg);
  const sha = new TextDecoder().decode(Bun.spawnSync(["git", "-C", source, "rev-parse", "HEAD"]).stdout).trim();
  if (sha !== cfg.upstream.ref) throw Error("Untrusted upstream SHA: " + sha);

  let migration: { exitCode: number | null; durationMs: number; tail: string } | null = null;
  if (process.argv.includes("--migrate")) {
    const pre = new Bun.SQL(url);
    const [{ n }] = await pre`select count(*)::int as n from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='public' and c.relkind in ('r','p')`;
    await pre.close();
    if (n > 0) throw Error(`--migrate needs an EMPTY database; ${n} tables already exist`);
    const r = await runner(source, ["bun", "run", "scripts/db/migrate.ts", "--strict", "--schema-only"], 30 * 60 * 1000, { DATABASE_URL: url });
    migration = { exitCode: r.exitCode, durationMs: r.durationMs, tail: (r.stdout + r.stderr).slice(-1500) };
    if (r.exitCode !== 0 || r.timedOut) { console.error(migration.tail); throw Error("Upstream migrations failed; catalog not read"); }
  }

  const manifest = await import(pathToFileURL(join(source, "architecture/module-manifest.ts")).href);
  const owners = new Map<string, number[]>();
  for (const m of manifest.MODULES) for (const t of m.ownedTables) owners.set(t, [...(owners.get(t) ?? []), m.id]);
  const helperOnly = new Set<string>(Object.keys(manifest.HELPER_ONLY_TABLES ?? {}));
  const tables = await readCatalog(url);
  const meta = new Bun.SQL(url);
  const [{ version }] = await meta`select current_setting('server_version') as version`;
  const extensions = (await meta`select extname as name, extversion as version from pg_extension order by 1`).map((e: any) => ({ name: e.name, version: e.version }));
  const roles: DbRole[] = (await meta`select rolname as name, rolsuper as superuser, rolbypassrls as bypass, rolcanlogin as login from pg_roles order by rolname`).map((r: any) => ({ name: r.name, superuser: r.superuser, bypassRls: r.bypass, login: r.login }));
  await meta.close();
  const findings = [...compareCatalog(tables, owners, helperOnly), ...checkRoles(roles)].sort((a, b) => `${a.code}|${a.table}`.localeCompare(`${b.code}|${b.table}`));
  const by = (code: string) => findings.filter((x) => x.code === code).length;
  const summary = {
    tables: tables.length, partitionedParents: tables.filter((t) => t.partitioned).length,
    rlsEnabled: tables.filter((t) => t.rlsEnabled).length, rlsForced: tables.filter((t) => t.rlsForced).length,
    tenantTables: tables.filter((t) => t.tenantColumn).length, policies: tables.reduce((n, t) => n + t.policies.length, 0),
    manifestTables: owners.size,
    findings: Object.fromEntries([...new Set(findings.map((x) => x.code))].sort().map((c) => [c, by(c)])),
  };
  const out = join(root, cfg.outputDirectory, sha);
  mkdirSync(out, { recursive: true });
  const payload = { sourceCommit: sha, postgres: version, extensions, roles: roles.filter((r) => !r.name.startsWith("pg_")), migration: migration && { exitCode: migration.exitCode, durationMs: migration.durationMs }, summary, findings, tables };
  const content = canonical(payload);
  writeFileSync(join(out, "database-catalog.json"), content);
  writeFileSync(join(out, "database-catalog.sha256"), sha256(content) + "\n");
  console.log(JSON.stringify({ postgres: version, extensions: extensions.map((e: any) => `${e.name} ${e.version}`), ...summary, out }, null, 2));
  if (existsSync(join(out, "database-catalog.json")) && (by("TENANT_TABLE_WITHOUT_RLS") || by("MANIFEST_TABLE_NOT_IN_DATABASE") || by("ROLE_BYPASSES_RLS"))) process.exitCode = 1;
}
if (import.meta.main) await main();
