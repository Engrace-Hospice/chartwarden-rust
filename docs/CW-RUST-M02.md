# CW-RUST-M02 — First Rust endpoint (shadow, then serve)

Version: **0.2** · Status: **proposed** · Upstream pin: `Engrace-Hospice/chartwarden@9e0899a` · Depends on: M00, ADR-0060

Changes from 0.1 (review of PR #3): an M00 gate, a transport threat model and replay control, database-level
fail-closed RLS tests, Bun-owned HTTP behaviour, a deterministic stale-cache rule, bounded shadow traffic, wider
fallback conditions, an honest rollback mechanism, redacted diff logging, and supply-chain failure handling.

## Goal

Put the first piece of Rust in the request path, safely enough to prove the whole pipeline: build, database access
under RLS, deployment next to Bun, parity against Bun, and rollback. M02 is about **trusting the pipeline**, not about
speed. Every M02 request still passes through Bun, so no latency gain is claimed.

## Gate 0 — M00 prerequisite

P0 implementation may start now. **P0 acceptance** requires all of these:

- PR #1 (test discovery) and PR #2 (execution, retention, catalog) merged by the owner;
- the candidate test inventory (35,194 IDs at `9e0899a`) approved as the M00 baseline;
- a catalog run at the pinned SHA with 0 fail-level findings.

The evidence exists on PR #2 (catalog: 571 tenant tables, 0 without RLS, 0 roles bypassing RLS; unit and live
shards executed with planted-defect detection). It is not approved yet, and M02 acceptance cannot get ahead of that.

## The endpoint: `GET /api/v1/me/permissions`

Upstream: `apps/backend/src/modules/03-authorization/routes/authz-routes.ts:400`. It returns
`{ "permissions": string[] }`, the caller's effective permission keys in the active organization.

| Property | Why it matters for a first endpoint |
| --- | --- |
| Read-only, no audit event, no outbox emit | Nothing to reconcile if Rust misbehaves |
| No PHI (but security-sensitive; see Logging) | Diffs can be classified without touching patient data |
| Tenant-scoped, three-table join under RLS | Exercises the hard part: `app.org_id`, the `chartwarden_app` role, FORCE RLS |
| Real security rules | Disabled roles, expired grants, inactive memberships, reserved platform roles |
| Called by the web app (`apps/web/src/modules/03-authorization/*`) | Real traffic for shadow comparison |

The Rust binary also serves `/health` and `/version` for container health and build identity. They're not counted as
the M02 endpoint.

### Behaviour to reproduce exactly

The upstream route calls the RBAC handle's resolver with only `{organizationId, userId}`
(`modules/03-authorization/index.ts:219`). The session-class wrapper is **not** applied on this route, so portal and
funeral sessions get only what membership grants, normally `[]`. Rust reproduces that.

Resolution (`packages/auth/src/rbac/drizzle-store.ts` `loadGrants`, `resolve.ts` `resolveEffectivePermissions`). Inside
one transaction with `app.org_id` and `app.user_id` set:

1. `memberships ⋈ membership_roles ⋈ roles` where `memberships.user_id = $user`, `memberships.organization_id = $org`,
   `memberships.status = 'active'`.
2. Drop roles that do not confer. A role confers when `roles.organization_id IS NULL`, **or** it is not reserved.
   Reserved means: the key starts with `platform_`; or the key is in `RESERVED_PLATFORM_ROLE_KEYS` (today
   `ai_safety_owner`); or `category = 'platform_staff'` (`packages/auth/src/roles/platform-reserved.ts`).
3. `role_permissions` for the remaining role ids.
4. Fold: skip `enabled = false`; skip grants with `expires_at <= now`; union the keys.

The reserved-key list comes from a generated file. A test compares it with upstream's TS export, so a new reserved
key upstream fails the Rust build instead of silently conferring.

Upstream returns keys in DB row order, which isn't stable, so parity compares as **sets**. Rust returns keys sorted.
AT-M02-05 confirms the web client is order-insensitive.

### Stale-cache rule (replaces the 0.1 five-minute excuse)

Bun caches each actor's set in-process for up to 5 minutes (capped by the soonest grant expiry). Rust has no cache in
M02. A diff is **never** excused by elapsed time. In shadow mode:

1. On a diff, Bun re-resolves the set once **bypassing its cache** (`store.loadGrants` + the same fold).
2. If the fresh Bun set equals Rust's, the outcome is `explained:stale-cache`, recorded with the cache entry's age.
   Otherwise it is `unexplained`.
3. A run of `explained:stale-cache` outcomes for one actor beyond the cache TTL plus 10 s is itself `unexplained`.
   That would mean invalidation is broken, not that Rust is wrong.

## HTTP behaviour: Bun owns the wire

Clients never receive a Rust-generated HTTP response:

- Authentication, session expiry (`SESSION_EXPIRED`), org selection (`ORGANIZATION_NOT_SELECTED`) and every other 401
  or 403 path run in Bun **before** forwarding, exactly as today.
- In serve mode, Bun validates Rust's body against the route schema (an object with exactly `permissions`, an array
  of unique strings). Bun then sends it through its own `reply.send`, so status, headers, content type, security
  headers and error envelopes are Bun's by construction.
- Anything other than a valid `200` from Rust makes Bun serve its own handler (see Fallback).

HTTP parity therefore reduces to the body, plus one end-to-end check that the bytes clients receive are unchanged
(AT-M02-05b).

## Authentication bridge: Bun authenticates, Rust verifies a signed actor assertion

Upstream authentication (`apps/backend/src/bootstrap/plugins/authenticate.ts`, 375 lines) covers:

- session classes, membership revocation and MFA enrolment;
- idle and absolute timeouts, which **write** activity;
- credential state and auditor stages.

Porting it is a milestone of its own (proposed M04). The options for M02:

- **A (chosen):** Bun runs its unchanged hook, then calls Rust with a signed actor assertion. Rust never sees or
  accepts the Better Auth cookie.
- B (deferred): Rust validates Better Auth sessions itself.
- C (rejected for M02): nginx `auth_request`. It adds a hop for every request and changes production nginx.

### Threat model

| Threat | Control |
| --- | --- |
| A client forges an assertion | Ed25519 signature; Rust holds only public keys; strict verification (below) |
| A client injects the header through nginx/Bun | Bun always deletes and replaces `X-CW-Actor-Assertion` before forwarding; nginx drops it on public vhosts; both tested |
| A compromised sibling container calls Rust directly | Default transport is a **Unix domain socket** on a volume shared only by `api` and `rust`; Rust publishes no TCP port. Fallback, if UDS is unworkable: a dedicated compose network joined by `api` and `rust` only |
| An assertion is captured and replayed | Single-use `jti` (128-bit random): Rust keeps an in-memory set of seen `jti` values until `exp` + skew and rejects a repeat. Combined with method/path/org binding and ≤ 30 s lifetime, the residual risk is a replay to a different Rust instance inside 30 s. Accepted for M02 because there is one instance; revisit before scaling out |
| The signing key leaks | Key held only by `api`; `kid` lets Rust accept a rotation list; rotation runbook in P1 |
| Rust over-trusts the assertion | Rust re-validates `sub` and `org` as UUIDs and still runs every query under RLS as `chartwarden_app`. The assertion selects the tenant but grants no database privilege |

mTLS is unnecessary while traffic stays on a UDS; it becomes required if Rust ever runs on another host.

### Assertion format and verification

Compact JWS. Rust accepts **only** `alg: EdDSA` with a known `kid`; any other `alg` (including `none`) or a `crit`
header is rejected before signature verification. Implemented with `ed25519-dalek` (strict verification); no general
JWT library.

| Claim | Value |
| --- | --- |
| `iss` / `aud` | `cw-bun` / `cw-rust` |
| `sub` / `org` | user id / active organization id; both UUIDs, both required |
| `sid`, `cls` | session id and session class; required non-empty, not logged, not used for decisions |
| `mth`, `pth` | HTTP method and path; must equal the forwarded request |
| `rid` | request id, which correlates Bun and Rust logs |
| `jti` | single-use nonce |
| `iat`, `exp` | `exp - iat ≤ 30 s`; skew allowance 5 s |

Register `X-CW-Actor-Assertion` in upstream's `arch:request-header-auth` as `verified`.

## Database access and RLS

Rust connects as **`chartwarden_app` (NOBYPASSRLS)** with its own small pool. Per request:

1. Validate `sub` and `org` as UUIDs; otherwise reject without touching the database.
2. `BEGIN READ ONLY`.
3. `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`, with bound parameters only.
4. Run the queries, then `COMMIT`. Any error rolls back and returns `500` to Bun, which falls back.

Upstream facts this must survive (from the policy shape `organization_id = current_setting('app.org_id', true)::uuid`
and the note in `modules/33-reporting/wiring.ts`):

- unset GUC → `NULL` → no rows;
- on a reused pooled connection, a transaction-local GUC reverts to the **empty string**, not unset, so `''::uuid`
  raises `22P02`;
- both outcomes must fail closed, and neither may return another tenant's rows.

## Rust layout (in this repo)

```
rust/
  Cargo.toml              workspace; Cargo.lock committed; builds use --locked
  rust-toolchain.toml     exact toolchain version
  deny.toml               licences, advisories, sources
  crates/
    cw-server/            Axum binary: UDS listener, /health, /version, /api/v1/me/permissions, graceful shutdown
    cw-actor/             assertion verification + jti replay cache
    cw-tenancy/           with_org_context(): READ ONLY tx + bound set_config
    cw-authz/             grant query + roleConfersKey + fold; pure core unit-tested
```

- Axum, Tokio, SQLx (Postgres, `runtime-tokio`, `tls-rustls`), Serde, `tracing` (JSON).
- `#![forbid(unsafe_code)]` in every crate. This is a proprietary codebase, so no copyleft dependencies.
- Container image: a digest-pinned base, non-root user, read-only root filesystem, image digest recorded per build.

## Logging

Permission keys are not PHI, but they are security-sensitive. Production logs carry:

- request id, route, status and latency;
- user and org ids (not the session id; the request id correlates Bun and Rust);
- outcome (`match`, `explained:stale-cache`, `unexplained`, `fallback:<reason>`);
- the size of each set (no fingerprint: a plain hash of a low-entropy permission set can be reversed by enumeration, so
  production logs carry no hash of it; the comparison itself happens in Bun's memory);
- for `unexplained` only, the **count** of keys only in Bun and only in Rust.

Full key lists appear only in local and test runs. Assertions and cookies are never logged anywhere.

## Rollout phases

Each phase ends with the owner's go-ahead. No phase changes production until P2.

**P0 — Rust alone (this repo only).** Build the crates. Run unit and live tests against a migrated ephemeral
PostgreSQL (the M00 catalog setup), plus parity against a local Bun stack using test-signed assertions.

**P1 — Upstream forwarding seam, off by default.** One upstream PR adds:

- the assertion signer and forwarder;
- `RUST_ROUTES` (empty by default) and `RUST_ROUTE_MODE=shadow|serve`;
- a `rust` compose service: digest-pinned, `mem_limit`/`cpus`, UDS volume shared only with `api`, health check;
- a `controls.yaml` row for the new trust boundary;
- exactly one Rust replica (no `scale`, no `deploy.replicas > 1`), because the `jti` replay cache is per process,
  **enforced by a deployment-policy test** that fails on more than one replica, more than one Rust service, or any Rust
  listener other than the shared socket (e.g. a published TCP port or `CW_RUST_TCP` in production);
- the socket directory owned by the Rust container's user, group-accessible only to `api` (mode 0750 or stricter),
  so no other process can create, replace or remove files in it.

It must pass upstream's `arch:fitness`, `arch:compose-policy` and `arch:request-header-auth`, the compliance review,
and an independent review of the authentication boundary. Upstream tests are not modified; new tests are added and
enter the stored inventory as additions.

**P2 — Shadow in production.** Bun answers as today. After replying, it shadows to Rust under these rules:

- at most 8 shadow calls in flight; when full, the call is **dropped** and counted, never queued;
- 300 ms timeout with an `AbortController`;
- an optional sample rate (default 100 %);
- shadow work starts after the response is sent and cannot delay or fail it.

Exit criterion: ≥ 7 days and ≥ 10,000 compared requests, with:

- 0 `unexplained`;
- `explained:stale-cache` under 0.5 % of compared requests;
- Rust error or timeout rate under 0.1 %;
- dropped shadows under 1 %.

**P3 — Serve.** For this route, Bun returns Rust's validated body.

## Fallback (serve mode)

Bun serves its own handler, and counts `fallback:<reason>`, on any of:

- connection failure;
- timeout (300 ms);
- a status other than 200;
- content type not JSON;
- a body that fails the schema (extra or missing fields, non-string or duplicate keys);
- Rust's assertion rejection.

A fallback rate above 1 % over 10 minutes raises an alert.

## Rollback

There are two levers, and the spec does not claim more than they do:

1. **Instant, no restart of Bun:** `docker compose stop rust`. Every forward fails to connect immediately and Bun serves
   its own handler. AT-M02-09 measures this.
2. **Remove the route:** take it out of `RUST_ROUTES`. This is read at boot, so it needs an `api` container restart
   through the normal deploy. It is **not** dynamic, and M02 does not add a runtime config store for it.

## Acceptance tests

| ID | Test |
| --- | --- |
| AT-M02-01 | Unit: fold rules (disabled, expiry exactly at and 1 ms before `now`, future expiry, duplicates) and `roleConfersKey` (null-org platform role confers; tenant `platform_*`, `ai_safety_owner`, `platform_staff` do not). Cases mirror upstream's RBAC unit tests by name. Reserved-key list equals upstream's export. |
| AT-M02-02 | Live RLS, connected as `chartwarden_app`, never a superuser: (a) multi-org user sees only the active org's keys; (b) suspended/revoked membership → `[]`; (c) GUC unset → 0 rows; (d) GUC `''` on a reused connection → `22P02` → 500, no rows; (e) malformed org id → rejected before SQL; (f) org set to another tenant → no cross-tenant rows; (g) pool of size 1 serving org A then org B returns only B's rows, and a fresh transaction without `set_config` sees nothing; (h) `chartwarden_app` confirmed `NOBYPASSRLS`, not the table owner, and every table in the query FORCE RLS. |
| AT-M02-03 | Read-only: an `INSERT` attempted inside `with_org_context` fails with `25006`. |
| AT-M02-04 | Assertion rejected with 401 for: missing; expired; `exp-iat > 30`; future `iat` beyond skew; wrong `aud`/`iss`; wrong method; wrong path; wrong org/sub format; unknown `kid`; wrong key; tampered payload; `alg: none`; `alg: HS256`; `crit` header; **replayed `jti`**. A Better Auth cookie alone gets 401. A client-supplied header is overwritten by Bun (P1 test) and dropped by nginx (config test). |
| AT-M02-05 | Parity on one seeded database, for every fixture actor: staff with roles, disabled role, expired grant, multi-org, platform role, tenant row with a reserved key, portal session, no membership. Bun's and Rust's sets are equal, and the web client's use of the array is order-insensitive. |
| AT-M02-05b | End to end through Bun (P1): status, headers and body seen by the client are identical with `RUST_ROUTES` empty, in shadow and in serve, modulo set order. The 401 paths (no session, expired, org unselected) are unchanged. |
| AT-M02-06 | Retention: `verify:retention` passes against the approved inventory. No ID may disappear, including through a runner silently skipping collection. Upstream `authz-routes.test.ts` and `m3-role-templates.live.test.ts` pass unchanged after P1. |
| AT-M02-07 | Supply chain: `cargo build --locked`; `cargo deny check` and `cargo audit` pass. **If the advisory database cannot be fetched, the check fails**; it is not skipped. Also `clippy -D warnings` and `fmt --check`. The pinned toolchain matches `rust-toolchain.toml`, and the image digest is recorded. |
| AT-M02-08 | Logging: Rust and Bun log lines for test requests contain no assertion, cookie or permission key. An `unexplained` diff logs counts and hashes only. |
| AT-M02-09 | Rollback and fallback: with Rust stopped, the route answers from Bun within Bun's normal latency plus connection-refused time, and `fallback:connect` increments. Each fallback reason in the list above is triggered once by a fault-injecting stub. |
| AT-M02-10 | Shadow safety: with Rust stalled, 1,000 concurrent requests return Bun's answers with no added p99 latency beyond 5 ms; in-flight shadows never exceed 8; drops are counted. |

## Stop conditions

Stop and return to the owner if any of these happens:

- an unexplained parity diff;
- a cross-tenant row in any test;
- a need to modify or skip an upstream test;
- Rust needs a role other than `chartwarden_app`;
- the assertion must carry more than the claims above;
- a dependency fails `cargo deny`;
- UDS proves unworkable and TCP is proposed.

## Approval gates

| Phase | May start | Accepted when |
| --- | --- | --- |
| P0 | After this spec is approved | Gate 0 met; AT-01–05, 07, 08 pass with live DB evidence; Claude's adversarial verification done |
| P1 | After P0 is accepted | Upstream gates green; AT-04 (header), 05b, 06, 09, 10 pass; independent auth-boundary review |
| P2 | After P1 is merged | Exit criteria above, from production logs |
| P3 | After P2 exit criteria | Owner go-ahead; rollback lever 1 demonstrated in production |

## Out of scope

Rust-side session validation (M04), caching, write endpoints, outbox, audit events, Socket.IO, workers, the X12 sidecar,
multiple Rust instances, and runtime-reloadable routing.

## Roles

ChatGPT implements P0, then the P1 upstream PR. Claude adversarially verifies each phase: re-running the ATs, attacking
the assertion and RLS boundaries, and checking parity evidence. The owner approves each phase and every merge.
