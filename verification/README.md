# M00 verification harness — initial implementation

This repository is separate from `Engrace-Hospice/chartwarden`. The upstream repository is read-only for this tool.

## Pinned source

Upstream SHA: `9e0899a77cf78928d9965c35bc6bd3bafe8471d7`.

Clone or check out that exact commit locally:

```bash
git clone https://github.com/Engrace-Hospice/chartwarden.git ../chartwarden
git -C ../chartwarden checkout 9e0899a77cf78928d9965c35bc6bd3bafe8471d7
bun install
bun run verify:selftest
bun run verify:inventory --source ../chartwarden
```

Do not run this tool against production data. It only reads source files and Git metadata. It writes generated files under `verification/output/<source-sha>/`.

## Current implementation status

Validated by execution against the pinned checkout on 2026-10-31 (Bun 1.4.4, TypeScript 5.9).

| Area | Status | Evidence at the pinned SHA |
| --- | --- | --- |
| Module inventory | Implemented | 41 modules, 658 declared tables, no duplicate owners, no missing code paths |
| Import discovery (`verification/src/inventory-v2.ts`) | Implemented | TypeScript AST over `apps/` and `packages/`, including multi-line, re-export, dynamic, `require`, `import x = require()` and type-position `import("x").T`; test files included because upstream's boundary rules apply to them |
| Import resolution (`verification/src/dependencies.ts`) | Implemented | Relative paths, workspace `exports` (incl. `*` patterns), npm and builtins; 0 unresolved; deep imports that bypass `exports` are flagged |
| Forbidden-edge detection | Implemented | Evaluates upstream's own `architecture/.dependency-cruiser.cjs` `forbidden` rules (70) with an independent engine; unsupported matcher keys are reported, never skipped. 0 violations, matching `bun run arch:boundaries` (dependency-cruiser 16) |
| Cross-check vs dependency-cruiser | Done manually | Identical internal edge set: 29,942 file→file edges in common, 0 missed |
| Cycles | Implemented | Iterative Tarjan SCC at file and module level; 0 cycles |
| Module edge classification | Implemented | Each module→module edge labelled `dependsOn`, `helper` (LEAF/FOUNDATION_HELPER, ADR-0005 D4) or `undeclared`; 69 / 11 / 0 |
| Orphan production files | Implemented | 53 files no module `codePath` covers (tests and LEAF packages excluded) — reported as findings for manifest review |
| Static routes | Implemented | 1,889 registrations (receiver `app\|scope\|server\|fastify\|instance\|router` with ≥2 args); 1,887 literal, all documented in OpenAPI after `::` normalisation; 2 `UNRESOLVED_ROUTE` (templated FHIR route, DoseSpot webhook constant) |
| Negative controls | Implemented | 22 self-tests; planted boundary, AI-block, vendor-SDK and cycle violations in a scratch copy were all reported |
| Determinism | Verified | Two runs produce byte-identical exports (only `run-manifest.json` carries a timestamp) |

Not implemented yet: runtime route registration and auth metadata; PostgreSQL catalog and RLS comparison; upstream test discovery/execution and wiring of stable test IDs (`findMissingTests`); formal JSON schemas; CI workflow; dependency-cruiser cross-check as an automated step; P1 reproduction and fixes.

The output is **preliminary**, not an approved M00 baseline.

### Trust note

The inventory `import()`s upstream `architecture/module-manifest.ts` and `require()`s `architecture/.dependency-cruiser.cjs` (and its `module-manifest.cjs`) to read the policy. That executes upstream code, so only run it against a checkout you trust — the pinned SHA, not an arbitrary branch.

## Safety

Do not delete, rename, or alter any upstream tests, fixtures, audit gates or migrations. Historical P1 findings must be independently reproduced on the pinned source before classification.

## Source specification

ADR-0060 and CW-RUST-M00 govern the next implementation phases. The approved uploaded revisions should be imported without rewriting or losing their original wording.
