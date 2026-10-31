# M00 execution, retention, catalog and CI

Builds on runner-native discovery (`TEST-DISCOVERY.md`). Nothing here can mark the M00 baseline approved:
every payload carries `approvedBaselineEligible: false` until the owner signs off.

## Commands

```sh
# 1. Discover (or combine CI listing slices with repeated --vitest-list)
bun run verify:discover --source ../chartwarden

# 2. Retention: every stored test ID is still discovered or formally retired
bun run verify:retention --discovery verification/output/<sha>/test-results.json

# 3. Execute, sharded. Unit runs with no service URLs; live runs one file at a time.
bun run verify:execute --source ../chartwarden --discovery <test-results.json> --suite unit --shard 1/4
bun run verify:execute --source ../chartwarden --discovery <test-results.json> --suite live --shard 1/8 \
  --database-url postgres://postgres:postgres@localhost:5432/chartwarden_test --redis-url redis://localhost:6379

# 4. Merge shards onto discovery IDs and judge integrity
bun run verify:merge --discovery <test-results.json> executions/*.json [--require-pass]

# 5. Catalog: migrate an EMPTY ephemeral DB with upstream's migrator, compare with the manifest
bun run verify:catalog --source ../chartwarden --database-url postgres://postgres@localhost:5433/chartwarden_catalog --migrate
```

## Semantics

| Situation | Status / finding |
| --- | --- |
| Runner reported `passed` / `failed` | `PASS` / `FAIL` (with failure message) |
| File failed to load | every discovered test in it → `ERROR` |
| File ran, a discovered test produced no result | `ERROR` + `DISCOVERED_TEST_NOT_EXECUTED` |
| Result for an ID discovery never saw | `RESULT_NOT_IN_DISCOVERY` |
| Service-dependent test skipped while a DB URL was given | `LIVE_TEST_SKIPPED_WITH_DATABASE` |
| Needs PostgreSQL/Valkey, not executed | `BLOCKED` |
| Not executed | `NOT_RUN` |

"Service-dependent" is decided by content: a test file that reads `CHARTWARDEN_TEST_DATABASE_URL` or
`CHARTWARDEN_TEST_REDIS_URL`, or follows the `.live.`/`-live.` naming. Ten upstream DB suites (including
`packages/db/migrations/__tests__/rls-isolation.test.ts`) do not follow the naming convention.

`verify:merge` always fails on integrity findings (the evidence cannot be trusted). Test `FAIL`/`ERROR`
outcomes are recorded faithfully and fail the merge only with `--require-pass` — M00 records the baseline;
it does not require every upstream test to pass.

## Retention

`verification/baselines/test-inventory.jsonl` — one JSON-encoded stable test ID per line (JSON because some
upstream test names contain newlines). `retirements.json` lists approved removals:

```json
{ "id": "<old id>", "kind": "replacement | rename | regulatory-correction", "successor": "<new id>",
  "reason": "…", "authority": "CMS Pub. 100-04 Ch. 11 §…", "approvedBy": ["engineering:…", "billing:…"], "date": "2026-11-02" }
```

`regulatory-correction` requires `authority` and a `clinical:`, `billing:` or `compliance:` approver
(ADR-0060 invariant 1). `--update` refuses while any removal is unexplained. The stored inventory is a
**candidate** (35,194 IDs at `9e0899a`) until the owner approves the M00 baseline.

## Catalog findings

`MANIFEST_TABLE_NOT_IN_DATABASE`, `DATABASE_TABLE_NOT_IN_MANIFEST`, `TENANT_TABLE_WITHOUT_RLS`,
`RLS_NOT_FORCED`, `RLS_WITHOUT_POLICY`, `ROLE_BYPASSES_RLS` (fail the run) and the informational
`TABLE_WITHOUT_TENANT_COLUMN`.

Upstream property found while building this: migration `1139` renames cluster-wide roles, so **two
databases in one PostgreSQL cluster cannot both be migrated from scratch** (the second fails at `1142`).
CI therefore uses one fresh container per job; locally, use a separate cluster for catalog and live tests.

## Local validation at the pinned SHA (2026-10-31)

PostgreSQL 18.6 + pgvector 0.8.7 built from source (Docker Hub is unreachable from the build sandbox),
Valkey 7.2 (CI uses `pgvector/pgvector:pg18` and `valkey/valkey:8-alpine`), `max_locks_per_transaction=4096`.

| Check | Result |
| --- | --- |
| Discovery (full harness run, 44 min) | 35,194 tests: 7,219 BLOCKED, 27,958 NOT_RUN, 17 SKIPPED; 508 service-dependent files |
| Unit shard 1/50 | 30 files, 459 PASS, every discovered test in those files mapped |
| Live shard 1/50 (real PG18 + Valkey) | 10 files, 150 PASS in 165 s (≈16 s/file; ~510 service files) |
| Planted defects | broken assertion → 4 FAIL; load error → 19 ERROR; extra test → `RESULT_NOT_IN_DISCOVERY`; runtime skip with DB → `LIVE_TEST_SKIPPED_WITH_DATABASE`; merge exits 1 |
| Catalog (615 migrations, `--strict --schema-only`) | 659 tables, 59 partitioned parents; 645 RLS enabled and forced; 571 tenant tables, **0 without RLS**; 1,043 policies; 0 roles bypassing RLS; all 658 manifest tables present; 87 informational global tables |
| Retention | unchanged → pass; one test dropped → fails naming it; equal-count swap → fails |

The full unit and live suites were not run end to end locally (≈2.3 h of live suites alone on 2 CPUs);
CI shards them (`UNIT_SHARDS=4`, `LIVE_SHARDS=8`).

## CI (`.github/workflows/verification.yml`)

**Manual only** (`workflow_dispatch`): it does not run on push or pull request. Start it from the Actions tab when
independent evidence is wanted; everything it does also runs locally with the commands above.

`static` → typecheck, self-tests, inventory, determinism · `list` ×6 → `discover` (+ retention) →
`unit` ×4 and `live` ×8 · `catalog` · `report` (every shard must report; integrity verdict).

- `permissions: contents: read`; no secrets referenced; `persist-credentials: false` everywhere.
- Third-party actions pinned to commit SHAs.
- `.github/actions/pinned-upstream` refuses to run upstream code unless the pinned SHA is on upstream `main`,
  and installs upstream dependencies with `--ignore-scripts --frozen-lockfile`.
- If `Engrace-Hospice/chartwarden` is made private, the checkout needs a read-only token for that repository.

Not covered yet: Playwright execution (needs the full stack: backend, seeded data, object storage),
P1 reproduction, approval of the candidate inventory.
