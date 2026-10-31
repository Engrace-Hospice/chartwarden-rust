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

- Implemented on the correction branch: pinned source SHA check; dirty checkout labeling; declared module inventory; TypeScript AST import discovery across apps and packages; unresolved route candidate findings; escaped-colon path normalization; declared table ownership; canonical JSON output, checksums, and initial self-tests.
- Not implemented: full import resolution and forbidden-edge checks; verified complete route coverage and runtime registration; PostgreSQL catalog and RLS inspection; full test discovery and execution; formal JSON schemas; CI integration; P1 reproduction and fixes. Self-tests have been committed but not executed by this assistant.

All unavailable observations are marked `UNKNOWN` or explicitly described as pending. The current output is **preliminary**, not an approved M00 baseline. This branch is awaiting execution against the pinned checkout and must not be merged on the basis of code review alone.

## Safety

Do not delete, rename, or alter any upstream tests, fixtures, audit gates or migrations. Historical P1 findings must be independently reproduced on the pinned source before classification.

## Source specification

ADR-0060 and CW-RUST-M00 govern the next implementation phases. The approved uploaded revisions should be imported without rewriting or losing their original wording.
