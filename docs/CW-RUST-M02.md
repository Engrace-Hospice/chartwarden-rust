# CW-RUST-M02 — First Rust endpoint (shadow, then serve)

Status: **proposed** · Upstream pin: `Engrace-Hospice/chartwarden@9e0899a` · Depends on: M00 (harness), ADR-0060

## Goal

Put the first piece of Rust in the request path, safely enough to prove the whole pipeline: build, database
access under RLS, deployment next to Bun, parity against Bun, and rollback. M02 is about **trusting the
pipeline**, not about speed. Every M02 request still passes through Bun, so no latency gain is claimed.

## The endpoint: `GET /api/v1/me/permissions`

Upstream: `apps/backend/src/modules/03-authorization/routes/authz-routes.ts:400`. It returns
`{ "permissions": string[] }`, the caller's effective permission keys in the active organization.

Why this one:

| Property | Why it matters for a first endpoint |
| --- | --- |
| Read-only, no audit event, no outbox emit | Nothing to reconcile if Rust misbehaves |
| No PHI | Parity diffs can be logged in full |
| Tenant-scoped, three-table join under RLS | Exercises the hard part: `app.org_id`, the `chartwarden_app` role, FORCE RLS |
| Real security rules | Disabled roles, expired grants, inactive memberships, reserved platform roles |
| Called by the web app (`apps/web/src/modules/03-authorization/*`) | Real traffic for shadow comparison |

`/health` and `/version` are also served by the Rust binary (container health checks, build identity). They're
trivial and not counted as the M02 endpoint.

### Behaviour to reproduce exactly

The upstream route calls the RBAC handle's resolver with only `{organizationId, userId}`
(`modules/03-authorization/index.ts:219`). The session-class wrapper (`session-class-permissions.ts`) is **not**
applied on this route. Rust reproduces that: portal and funeral sessions get only what membership grants, normally
`[]`.

Resolution (`packages/auth/src/rbac/drizzle-store.ts` `loadGrants` and `resolve.ts`
`resolveEffectivePermissions`). Inside one transaction with `app.org_id` and `app.user_id` set:

1. `memberships ⋈ membership_roles ⋈ roles` where `memberships.user_id = $user`,
   `memberships.organization_id = $org`, `memberships.status = 'active'`.
2. Drop roles that do not confer: a role confers when `roles.organization_id IS NULL`, **or** it is not reserved.
   Reserved means the key starts with `platform_`, or is in `RESERVED_PLATFORM_ROLE_KEYS` (today `ai_safety_owner`),
   or `category = 'platform_staff'` (`packages/auth/src/roles/platform-reserved.ts`).
3. `role_permissions` for the remaining role ids.
4. Fold: skip `enabled = false`; skip grants with `expires_at <= now`; union the keys.

The reserved-key list is copied into Rust from a single generated file. A test compares it with upstream's TS
export, so a new reserved key upstream fails the Rust build instead of silently conferring.

Known, accepted difference: Bun caches the set in-process for up to 5 minutes (capped by the soonest grant
expiry). Rust in M02 has **no cache** and always reads the database. Right after a role change, Rust can be fresher
than Bun. The parity comparator treats a diff as explained only when a `membership_role`/`role`/`role_permission`
change for that actor or org happened within the TTL. All other diffs are failures.

Ordering: upstream returns keys in DB row order (no `ORDER BY`), which isn't stable. Parity compares as **sets**,
and Rust returns keys sorted. The web client uses the array as a set; this is checked in AT-05.

## Authentication decision: Bun authenticates, Rust verifies a signed actor assertion

Upstream authentication (`apps/backend/src/bootstrap/plugins/authenticate.ts`, 375 lines) does far more than read a
cookie: session classes, membership revocation, MFA enrolment, idle and absolute timeouts (which **write** activity),
credential state, and auditor stages. Porting it is a milestone of its own (proposed M04). For M02:

- **A (chosen):** Bun runs its unchanged authenticate hook. For a Rust-owned route, it then calls Rust with a
  short-lived **signed actor assertion**. Rust never sees or accepts the Better Auth cookie.
- B (deferred): Rust validates Better Auth sessions itself. This needs the whole hook above.
- C (rejected for M02): nginx `auth_request`. It adds a hop for every request and changes production nginx config.

Assertion format: compact JWS, `alg: EdDSA` (Ed25519), header `kid`. Claims:

| Claim | Value |
| --- | --- |
| `iss` / `aud` | `cw-bun` / `cw-rust` |
| `sub` | user id |
| `org` | active organization id (required; Bun has already rejected org-unbound sessions) |
| `sid`, `cls` | session id, session class (logged as ids, not used for decisions in M02) |
| `mth`, `pth` | HTTP method and path; must match the request Rust receives |
| `rid` | request id (correlates logs across Bun and Rust) |
| `iat`, `exp` | `exp - iat ≤ 30 s`; clock skew allowance 5 s |

Rules:

- Bun holds the private key, Rust only the public key(s). Rust accepts a key list for rotation.
- The assertion travels in `X-CW-Actor-Assertion` on the internal compose network only. Rust's port is not
  published on the host. When forwarding, Bun always replaces any client-supplied header of that name, and nginx
  also drops it from public requests.
- Register the header in upstream's `arch:request-header-auth` as `verified`.
- Rust rejects missing, expired, wrong-audience, wrong-method/path or bad-signature assertions with `401` and the
  upstream envelope `{ "error": { "code": "UNAUTHORIZED", "message": … } }`. In practice users never see this,
  because Bun falls back (below).

## Rust layout (in this repo)

```
rust/
  Cargo.toml              workspace; Cargo.lock committed; rust-toolchain.toml pinned
  crates/
    cw-server/            Axum binary: router, /health, /version, /api/v1/me/permissions, graceful shutdown
    cw-actor/             assertion verification (ed25519-dalek; no general JWT library)
    cw-tenancy/           with_org_context(): READ ONLY tx + set_config('app.org_id'|'app.user_id', $n, true)
    cw-authz/             grant query + roleConfersKey + fold, pure core unit-tested
```

- Axum, Tokio, SQLx (Postgres, `runtime-tokio`, `tls-rustls`), Serde, `tracing` (JSON).
- `#![forbid(unsafe_code)]` in every crate. `cargo deny` (licenses, advisories, sources) and `cargo audit` must pass.
  This is a proprietary codebase, so no copyleft dependencies.
- Database: Rust connects as **`chartwarden_app` (NOBYPASSRLS)** with its own small pool. Each request runs in
  `BEGIN READ ONLY`, sets both GUCs with bound parameters (never interpolated), then queries. The DB enforces M02's
  read-only nature, not just the code.
- Logging: request id, route, status, latency, user/org ids. Never the assertion, cookies or the permission list.

## Rollout phases

Each phase ends with the owner's go-ahead. No phase changes production until P2.

**P0 — Rust alone (this repo only, no upstream change).** Build the crates. Run unit tests and live tests against a
migrated ephemeral PostgreSQL (the M00 catalog setup), plus parity against a local Bun stack with test-signed
assertions.

**P1 — Upstream: forwarding seam, off by default.** One upstream PR adds:
- an assertion signer and a forwarder in the backend;
- `RUST_ROUTES` env (empty by default) and `RUST_ROUTE_MODE=shadow|serve`;
- a `rust` service in `deploy/production/compose.yml` with a digest-pinned image, `mem_limit`, `cpus`, internal
  network only, and its own health check;
- the `controls.yaml` row for the new trust boundary.

It follows upstream's own gates (`arch:fitness`, `arch:compose-policy`, `arch:request-header-auth`, compliance
review). Upstream tests are not modified; new tests are added.

**P2 — Shadow in production.** Bun answers as today. After replying, it sends the same request to Rust in the
background and logs `match | explained | diff` with ids. Exit criterion: ≥ 7 days, ≥ 10,000 requests, 0
unexplained diffs, Rust 5xx rate < 0.1 %.

**P3 — Serve.** For this route, Bun returns Rust's response. On a Rust timeout (default 300 ms), 5xx or
assertion rejection, Bun serves its own handler and counts a fallback. Rollback is to remove the route from
`RUST_ROUTES`; no deploy is needed.

## Acceptance tests

| ID | Test |
| --- | --- |
| AT-M02-01 | Unit: fold rules (disabled, expired at/just before `now`, future expiry, duplicates) and `roleConfersKey` (null-org platform role confers; tenant `platform_*`, `ai_safety_owner`, `platform_staff` category do not). Cases mirror upstream's RBAC unit tests by name. |
| AT-M02-02 | Live, as `chartwarden_app`: a user with memberships in org A and B sees only A's keys under A; suspended/revoked membership → `[]`; no rows leak with `app.org_id` set to another org; a superuser connection is **not** used for any assertion. |
| AT-M02-03 | Read-only: an `INSERT` attempted inside `with_org_context` fails with `25006`. |
| AT-M02-04 | Assertion: missing, expired, `exp-iat > 30`, wrong `aud`, wrong method, wrong path, wrong key, tampered payload, `alg: none` → 401 envelope; Better Auth cookie alone → 401. |
| AT-M02-05 | Parity: on one seeded database, for every fixture actor (staff with roles, disabled role, expired grant, multi-org, platform role, portal session, no membership), Bun's and Rust's status and permission sets are equal. The web client's use of the array is confirmed order-insensitive. |
| AT-M02-06 | Retention: `verify:retention` passes against the stored inventory; upstream `authz-routes.test.ts` and `m3-role-templates.live.test.ts` pass unchanged after P1. |
| AT-M02-07 | Supply chain: `cargo deny check`, `cargo audit`, `cargo clippy -D warnings`, `cargo fmt --check`; reproducible image build digest recorded. |
| AT-M02-08 | Logs: a test request's Rust log lines contain no assertion, cookie or permission key. |
| AT-M02-09 | Rollback (P3): with Rust stopped, the route still returns Bun's answer within the timeout plus Bun's normal latency; fallback counter increments. |

## Stop conditions

Stop and return to the owner if any of these happens:

- an unexplained parity diff;
- a cross-tenant row in any live test;
- a need to modify or skip an upstream test;
- Rust needs a role other than `chartwarden_app`;
- the assertion must carry more than the claims above;
- a dependency fails `cargo deny`.

## Out of scope

Rust-side session validation (M04), caching, write endpoints, outbox, audit events, Socket.IO, workers, and the
X12 sidecar.

## Roles

ChatGPT implements P0, then the P1 upstream PR. Claude adversarially verifies each phase: it re-runs the ATs,
attacks the assertion and RLS boundaries, and checks parity evidence. The owner approves each phase and every merge.
