# CW-RUST-M22: WardenLens P0 review-readiness parity contract

Status: proposed; parity not implemented in Rust.
Upstream: Engrace-Hospice/chartwarden branch `fix/wardenlens-p0-review-readiness-20261121`.
Scope: M22 intake document field-review eligibility, not general document-level review.

## Observed TypeScript behavior and remediation

The current upstream `documents-route-service-db.ts` previously allowed `openReview` for an `uploaded` batch because it only rejected terminal and parse-failed states. The upstream P0 patch requires:
- A tenant-scoped batch in `extraction_complete` status.
- At least one candidate joined via extraction job and classified page to that batch.
- Otherwise HTTP 409 `EXTRACTION_NOT_READY` or `NO_REVIEWABLE_FIELDS`.
- No review row or batch status mutation on rejection.
- Existing membership, permission, RLS, and Part 2 gates remain authoritative.

The web workspace disables Start review unless `batch.status === "extraction_complete"` and candidates exist. Frontend gating is advisory; server enforcement is mandatory.

## Rust parity requirements

1. Preserve the current HTTP route `POST /api/v1/intake/uploads/:id/review` and successful response contract.
2. In one tenant-scoped transaction, verify batch existence, status, and at least one candidate owned by that batch before inserting a review.
3. Preserve `404` for cross-tenant or nonexistent batch, `409 EXTRACTION_NOT_READY` for incomplete extraction, and `409 NO_REVIEWABLE_FIELDS` for empty extracted field sets.
4. Serialize competing review starts; preserve the existing unique lock/constraint behavior and error semantics. Never create two active reviews.
5. Do not use global candidate counts, unscoped external IDs, or caller-provided tenant IDs to authorize.
6. Never write extracted PHI into logs, error bodies, job payloads or audit metadata.
7. A valid zero-field document must enter a separately designed document-level review path, not a fake field review.
8. Preserve current role, permission, SUD/42 CFR Part 2, audit, and clinical writeback boundaries.
9. Add regression tests: uploaded, docling_complete, classifier_complete, parse_failed, extraction_complete with zero candidates, extraction_complete with candidate, wrong-tenant batch, duplicate concurrent starts.
10. Confirm parity with pinned TypeScript golden responses before Rust traffic cutover.

## Migration gates

- This document does not authorize M22 cutover.
- Confirm M00 inventory and M22 domain ownership before implementation.
- Capture upstream branch commit SHA and pin it in parity fixtures.
- Require live PostgreSQL RLS and transaction tests, not mocks alone.
- Keep all TypeScript behavior active until Rust parity is approved and deployment rollback is documented.

## Follow-up P0/P1

Trace `POST /intake/uploads` → extraction enqueue → worker registration → Docling → classified pages → extraction jobs → candidates → review. Add explicit durable processing-attempt evidence, actionable error states, stuck-job detection and controlled retries after measuring the existing worker/outbox behavior. Do not invent status transitions without checking schema and consumers.
