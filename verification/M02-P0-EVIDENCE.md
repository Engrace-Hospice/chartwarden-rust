# CW-RUST-M02 P0 — evidence

**Status: ACCEPTED by the owner on 2026-10-31** (PR #5 merged as `5866f9e`; parity path fix PR #7 as `846fff3`).
Built by Claude. Reviewed twice by ChatGPT (static; verdict ACCEPT WITH FIXES both times, all fixes applied; tables
below). **Independently executed** on a GitHub-hosted runner, with results produced by neither author (see
"Independent execution"). Spec: `docs/CW-RUST-M02.md` (v0.2 at acceptance, now v0.3). Upstream pin:
`Engrace-Hospice/chartwarden@9e0899a`.

## Independent execution

Workflow `.github/workflows/m02-rust.yml` (manual only), on a fresh `ubuntu-24.04` runner with upstream's
digest-pinned `pgvector/pgvector:pg18` image as a dedicated cluster:

| Run | Commit | Result |
| --- | --- | --- |
| [41261759270](https://github.com/Engrace-Hospice/chartwarden-rust/actions/runs/41261759270) | `5866f9e` (main) | **failed at parity only**: `--source upstream` was relative, so the dynamic imports resolved as package names. Every earlier step passed. Fixed by the owner in PR #7 (`resolve(sourceArg)`) |
| [41262292598](https://github.com/Engrace-Hospice/chartwarden-rust/actions/runs/41262292598) | `6c7770d` (PR #7 branch) | **passed every step** |
| [41263074320](https://github.com/Engrace-Hospice/chartwarden-rust/actions/runs/41263074320) | `846fff3` (main) | attempt 1 failed before any project step: Docker Hub timed out pulling the image (pull now retried). **Attempt 2 passed every step** on `main`: 66 tests, parity 19/0, supply chain ok |

Results of run 41262292598, from its log:

- rustc 1.97.0, matching the pin;
- upstream's migrator plus the M00 catalog check: 571 tenant tables, 645 with RLS forced;
- `reserved_platform_roles.json` matches upstream;
- `supply-chain.sh` ok (fmt, clippy `-D warnings`, cargo deny, cargo audit);
- tests: 28 + 16 + 10 unit, 10 live, 1 + 1 logging = **66 passed, 0 failed**;
- parity: **19 actors, 0 diffs**, identical to the local run line for line.

Not reproduced independently: the 15 mutations and the Unix-socket behaviour (both by hand, by Claude).

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
| AT-M02-04 (Rust side) | **pass**, 28 + 4 tests | `cargo test -p cw-actor`: missing, oversized, malformed, `alg: none`, `alg: HS256`, `crit`/`jku`/wrong `typ`, unknown `kid`, wrong key, tampered payload, truncated signature, extra/missing claims, wrong `iss`/`aud`/method/path (incl. trailing slash), non-canonical UUIDs, empty `sid`/`cls`/`rid`, bad `jti`, lifetime > 30 s or ≤ 0, expiry and future `iat` at the skew boundary, **replay** (same token and same `jti` in a new token), 16 threads racing one token (exactly one accepted), forged token not consuming a replay slot, exact capacity boundary (a replay is still reported as a replay when full; a new token fails closed until entries expire), key rotation, key-config errors incl. small-order key. Server: duplicate header, cookie-only, other-path assertion. The header-overwrite and nginx parts are P1. |
| AT-M02-05 | **pass**: 19 actors, 0 diffs | `verify:m02-parity`; output in `verification/output/m02/parity.json`. Actors cover staff, multi-org, disabled role, expired + future grants, suspended/revoked/pending, platform-owned role, reserved tenant rows, no membership, unknown org, two portal session classes, a key reachable through an expired and a permanent grant, a disabled and an enabled role sharing a key, a tenant role with an `organization_id NULL` `role_permission` row, and a grant row stamped with another org. Every Rust body is exactly `{permissions: unique strings}`, sorted, `application/json`. A planted defect (active-membership predicate removed) produced 3 diffs and exit 1. The web client's only consumer is `.includes("role.manage")` (`apps/web/src/modules/03-authorization/roles-permissions.tsx:60`), which is order-insensitive. |
| AT-M02-07 | **pass** (image part → P1) | `rust/scripts/supply-chain.sh`, fail-closed. It checks the toolchain equals the pin (1.97.0), then runs `cargo build --locked`, `fmt --check`, `clippy -D warnings` (all targets and features), `cargo deny --locked check` (advisories, bans, licences, sources: all ok; 1,395-advisory database fetched) and `cargo audit --deny warnings`. One reasoned ignore, RUSTSEC-2023-0071 (`rsa`): it is in `Cargo.lock` only through `sqlx-mysql`, which is never compiled. The script fails if `rsa` ever enters `cargo tree`. |
| AT-M02-08 | **pass**, 2 tests | `tests/logging.rs` (rejected and DB-error paths) and `tests/live_logging.rs` (200 path). No assertion, token segment, cookie or permission key in any log line. Request id, user and org ids, outcome and `permission_count` are logged; the session id is no longer logged (review round 1). |

### Mutation check

Each of these deliberate breakages was applied, the relevant suite run, and the source restored. Re-run after review round 1. **All 15 were caught:**

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
- accepting any database role at startup;
- logging the session id.

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

## Review round 1 (ChatGPT, static review)

| # | Finding | Assessment | Change |
| --- | --- | --- | --- |
| 1 | Replay cache: full cache denies valid requests (availability) | Real. Not a blocker: only Bun can mint assertions, and a 401 from Rust makes Bun serve its own answer, so users see no failure | Added a 16-thread race test (exactly one acceptance) and an exact capacity-boundary test. Capacity math: 100,000 entries over a 35 s window holds ≈ 2,857 assertions/s sustained, orders of magnitude above this endpoint's traffic. Every full-cache refusal logs `reason=replay_cache_full`, which is the metric to alert on in P2 |
| 2 | Parity/live tests mutate a database that is only proven loopback | Real | Both now refuse any database without `COMMENT ON DATABASE … IS 'cw-ephemeral-test-db'`, and any name containing prod/production/live/primary. Refusal verified on both. Destroy the database (or cluster) after use: `ALTER ROLE chartwarden_app LOGIN` is cluster-wide |
| 3 | Stale-socket replacement could remove a live instance's socket | Real | Exclusive `flock` on `<socket>.lock` held for the process lifetime. A socket that still answers is refused; only a dead socket is removed; a non-socket file is refused. All four cases exercised by hand (second instance, stale, foreign live listener, regular file) |
| 4 | Replay cache is per process | Known, accepted in the spec for one instance | The lock in #3 enforces one instance per socket on a host. **P1 requirement:** the compose service runs exactly one replica (no `scale`, no `deploy.replicas > 1`) until replay state is shared |
| 5 | Session id in logs | Valid hardening | Removed from the access log; the request id correlates. Both logging tests now assert the session id never appears. Spec Logging section updated |
| 6 | Parity coverage | Fair | Five actors added (now 19), all matching. A duplicate grant of the same role is impossible by schema (`membership_role_idx` is unique). An expiry crossing mid-request is not deterministic to fixture; both sides read `now` after loading grants and compare at millisecond precision (unit-tested) |
| 7 | Supply-chain guard could fail open if `cargo tree` errors | Real | `cargo tree` output is captured, a non-zero exit fails the gate, and anything other than a clean "nothing to print" fails it too |
| 8 | Evidence claimed owner acceptance | Real | Status line corrected above |

## Review round 2 (ChatGPT, static review; it could not reach GitHub or run Rust)

Verdict ACCEPT WITH FIXES; replay-cache downgrade accepted; no authorization bypass found.

| Finding | Change |
| --- | --- |
| `ALTER ROLE chartwarden_app …` is cluster-wide, so a marked database inside a shared cluster is not enough | Both harnesses now also refuse a cluster that holds any database other than the marked one and the built-in `postgres`/`template0`/`template1`. Verified: with an extra database present both refuse; on the dedicated cluster all 66 tests pass and parity is 19/0 |
| Single replica specified but not enforced | Spec P1 list: a deployment-policy test must fail on more than one replica, a second Rust service, or any non-socket listener |
| Socket-path race by an uncooperative process in a shared directory | Spec P1 list: socket directory owned by the Rust user, group-accessible only to `api`, mode 0750 or stricter |
| Spec still logged a plain SHA-256 of permission sets (reversible by enumeration) | Removed from the spec: production logs carry set sizes and diff counts only |
| Independent execution | Done: GitHub-hosted run 41262292598 (top of this document) |

**Independent execution: done after round 2.** See "Independent execution" at the top: the GitHub-hosted run
reproduced the tests, live RLS tests, parity and supply-chain gate.

Found while fixing: the live tests' `user(n)` helper built ids by hex addition, which only matched the fixtures for
users 1–9. It now formats the decimal id like the fixtures and the parity script do.

## How to reproduce

See `rust/README.md` § Commands. The live tests and parity need `CW_TEST_ADMIN_DATABASE_URL` / `--admin-url` pointing
at a migrated database on a **dedicated, disposable, loopback** PostgreSQL cluster, marked with
`COMMENT ON DATABASE <name> IS 'cw-ephemeral-test-db'`. Both refuse anything else. Destroy the cluster afterwards.
