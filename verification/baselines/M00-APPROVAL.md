# M00 baseline approval

Approved by the owner (fabwebdev) on 2026-10-31. This clears Gate 0 of `docs/CW-RUST-M02.md`.

| Item | Value |
| --- | --- |
| Upstream | `Engrace-Hospice/chartwarden@9e0899a77cf78928d9965c35bc6bd3bafe8471d7` |
| Test inventory | `test-inventory.jsonl`: 35,194 stable test IDs (Vitest 35,058 listed + 17 static skips, Playwright 119) |
| Inventory SHA-256 | `23d07f80b7ea7042ea10f9b6367ae108e733c5dd66af9efb92e7f822dc88c744` |
| Retirements | none (`retirements.json` is `[]`) |
| Harness merged | PR #1 (`d67e331`), PR #2 (`134bd89`) |

## Evidence checked before approval (2026-10-31)

- `verify:typecheck` clean; 53 harness self-tests pass.
- `verify:retention` against the full discovery run: stored 35,194, current 35,194, removed 0, unexplained 0.
- `verify:catalog` (615 migrations, `--strict --schema-only`, PostgreSQL 18.6 + pgvector 0.8.7): 659 tables;
  645 RLS enabled and forced; 571 tenant tables, 0 without RLS; 1,043 policies; 0 roles bypassing RLS; all 658
  manifest tables present. The only findings are 87 informational `TABLE_WITHOUT_TENANT_COLUMN` (global tables).
  Catalog SHA-256 `71a947365471a84364dccbd3a74d2cf61279fa047a30748aeb8abc5e9dbfe272`.
- Execution sample: unit shard 1/50 (459 PASS) and live shard 1/50 (150 PASS, real PG18 + Valkey). Planted defects
  were all detected.

## What this approval means and does not mean

- From now on, every one of these IDs must still be discovered, or be formally retired (`retirements.json`), for
  any Rust milestone to be accepted.
- It approves the **inventory** (which tests exist). It does not claim every upstream test passes: the full unit
  and live suites have been sampled, not run end to end, and Playwright has not been executed.
- Re-running `verify:retention --update` rewrites `test-inventory.meta.json` back to `candidate`. A changed
  inventory needs a fresh owner approval.
