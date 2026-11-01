# CW-RUST-M02 P0 — evidence

Built by Claude, reviewed by ChatGPT, accepted by the owner. Spec: `docs/CW-RUST-M02.md` v0.2. Upstream pin:
`Engrace-Hospice/chartwarden@9e0899a`. Recorded 2026-10-31.

## Gate 0

Met before P0 started: PR #1 and PR #2 merged, M00 inventory approved (`verification/baselines/M00-APPROVAL.md`),
catalog clean at the pinned SHA.

## What P0 delivers

- `rust/` workspace with four crates (`cw-actor`, `cw-authz`, `cw-tenancy`, `cw-server`). See `rust/README.md`.
- `verify:m02-reserved`: keeps Rust's reserved-role data identical to upstream and pins a SHA-256 of
  `platform-reserved.ts`, so any upstream edit forces a re-review.
- `verify:m02-parity`: runs upstream's own resolver and the Rust binary on one seeded database.
- Shared fixtures: `rust/crates/cw-server/tests/fixtures/m02.sql`.

No upstream file was changed. No container image yet (P1).

## Acceptance tests run for P0

Environment: PostgreSQL 18.6 + pgvector 0.8.7 (built from source), database migrated with upstream's migrator at
`9e0899a` (615 migrations, the M00 catalog database), Rust 1.97.0, Bun 1.4.4.

| AT | Result | How |
| --- | --- | --- |
| AT-M02-01 | **pass**, 16 tests | `cargo test -p cw-authz`. Names mirror upstream `rbac-resolve.test.ts` and `platform-reserved-roles.test.ts`. Adds expiry at/1 ms before `now`, JS-`Date` millisecond precision, disabled-with-future-expiry, duplicates. `verify:m02-reserved` passes. |
| AT-M02-02 | **pass**, 8 of the 10 live tests | `cargo test -p cw-server --features live --test live`, connected as `chartwarden_app`: (a) multi-org; (b) suspended/revoked/pending; (c) unset GUC → 0 rows; (d) reused connection, GUC `''` → `22P02` on `membership_role`/`role`/`role_permission`, 0 rows on `membership`; (e) malformed id → `22P02`; (f) GUC org B, predicate org A → nothing; (g) one pooled connection A→B→A; (h) role `NOBYPASSRLS`, not superuser, not owner; all four tables FORCE RLS. A superuser pool is refused at startup. |
| AT-M02-03 | **pass** | Same suite: `INSERT` inside an org transaction → `25006`; `SET TRANSACTION READ WRITE` afterwards is refused. |
| (end to end) | **pass** | Same suite, 10th test: signed request through the router on the real database returns exactly `{"permissions":["encounter.read","patient.read","visit.read"]}`; the same token again → 401. |
| AT-M02-04 (Rust side) | **pass**, 26 + 4 tests | `cargo test -p cw-actor`: missing, oversized, malformed, `alg: none`, `alg: HS256`, `crit`/`jku`/wrong `typ`, unknown `kid`, wrong key, tampered payload, truncated signature, extra/missing claims, wrong `iss`/`aud`/method/path (incl. trailing slash), non-canonical UUIDs, empty `sid`/`cls`/`rid`, bad `jti`, lifetime > 30 s or ≤ 0, expiry and future `iat` at the skew boundary, **replay** (same token and same `jti` in a new token), forged token not consuming a replay slot, full replay cache fails closed and recovers, key rotation, key-config errors incl. small-order key. Server: duplicate header, cookie-only, other-path assertion. The header-overwrite and nginx parts are P1. |
| AT-M02-05 | **pass**: 14 actors, 0 diffs | `verify:m02-parity`; output in `verification/output/m02/parity.json`. Actors cover staff, multi-org, disabled role, expired + future grants, suspended/revoked/pending, platform-owned role, reserved tenant rows, no membership, unknown org, and two portal session classes. Every Rust body is exactly `{permissions: unique strings}`, sorted, `application/json`. A planted defect (active-membership predicate removed) produced 3 diffs and exit 1. The web client's only consumer is `.includes("role.manage")` (`apps/web/src/modules/03-authorization/roles-permissions.tsx:60`), which is order-insensitive. |
| AT-M02-07 | **pass** (image part → P1) | `rust/scripts/supply-chain.sh`, fail-closed. It checks the toolchain equals the pin (1.97.0), then runs `cargo build --locked`, `fmt --check`, `clippy -D warnings` (all targets and features), `cargo deny --locked check` (advisories, bans, licences, sources: all ok; 1,395-advisory database fetched) and `cargo audit --deny warnings`. One reasoned ignore, RUSTSEC-2023-0071 (`rsa`): it is in `Cargo.lock` only through `sqlx-mysql`, which is never compiled. The script fails if `rsa` ever enters `cargo tree`. |
| AT-M02-08 | **pass**, 2 tests | `tests/logging.rs` (rejected and DB-error paths) and `tests/live_logging.rs` (200 path). No assertion, token segment, cookie or permission key in any log line. Ids, outcome and `permission_count` are logged. |

### Mutation check

Each of these deliberate breakages was applied, the relevant suite run, and the source restored. **All 14 were caught:**

- dropping the `status = 'active'` predicate;
- dropping the `roleConfersKey` filter;
- expiry `<=` changed to `<`;
- ignoring `enabled`;
- microsecond instead of millisecond expiry;
- dropping `READ ONLY`;
- dropping `app.org_id`;
- ignoring replay;
- skipping path binding;
- skipping the signature check;
- accepting any `alg`;
- skipping expiry;
- accepting duplicate headers;
- accepting any database role at startup.

### Binary smoke test

- A superuser `DATABASE_URL` → exit 2 with a clear message.
- A non-loopback `CW_RUST_TCP` → refused.
- Garbage `CW_ACTOR_PUBLIC_KEYS` → refused.
- On the Unix socket: mode `srw-rw----`, `/health` → `{"status":"ok"}`, permissions without an assertion → 401
  envelope, and the socket is removed on SIGTERM.

## Deviations and findings the owner should know

1. **Shadow traffic will be thin.** The only caller of `GET /api/v1/me/permissions` in upstream's web apps is the
   Roles & Permissions admin screen. The spec assumed "real traffic". P2's exit criterion (≥ 10,000 compared requests
   in ≥ 7 days) may never be reached. **Owner decision needed before P2:** lengthen the window, lower the count, or
   choose a busier second endpoint for shadow evidence.
2. **AT-M02-02(d) is subtler than the spec said.** Upstream's `membership` policy wraps the GUC in
   `NULLIF(…, '')`, so `''` gives no rows. The other three tables cast directly, so `''` raises `22P02`. Both fail
   closed. The test asserts "error or zero rows, never a row" and that the `22P02` path is actually hit.
3. **Toolchain download blocked.** `static.rust-lang.org` is unreachable from the build sandbox, so rustup cannot
   install the pinned `1.97.0` by name. The installed stable toolchain is exactly 1.97.0 and was used via
   `RUSTUP_TOOLCHAIN=stable`. CI or another machine will use the pin directly.
4. **Container image deferred to P1.** Docker Hub is unreachable here, so an image could be written but not built or
   verified. The image-digest half of AT-M02-07 moves to P1 with the compose service.
5. **Parity is resolver-level.** AT-M02-05 compares upstream's real resolver (the function the route calls) with the
   Rust HTTP endpoint. It does not go through Bun's authentication or Fastify reply; that is AT-M02-05b in P1.
6. **One advisory ignored, with a guard.** `cargo audit` reads `Cargo.lock`, which lists sqlx's unused MySQL driver
   and its `rsa` dependency (RUSTSEC-2023-0071, no fix available). It is not compiled: `cargo tree -i rsa` is empty,
   and feature-aware `cargo deny` reports nothing. The ignore lives in `rust/.cargo/audit.toml` with the proof, and
   `supply-chain.sh` fails if `rsa` ever becomes part of the build.
7. **Test database.** Live tests and parity used the M00 catalog database (migrated at the pinned SHA), with
   `chartwarden_app` granted LOGIN exactly as upstream's live suites do. Fixture organizations and users stay after a
   run, because `audit_event` references them and is append-only; grants, memberships and roles are replaced on
   every run.

## How to reproduce

See `rust/README.md` § Commands. The live tests and parity need `CW_TEST_ADMIN_DATABASE_URL` / `--admin-url` pointing
at a migrated, ephemeral, loopback database. Both refuse other hosts.
