# CW-RUST-M02 P1 — plan: the upstream forwarding seam (off by default)

Status: **in progress** (owner accepted D1–D5 as recommended, 2026-10-31) · Spec: `docs/CW-RUST-M02.md` v0.3 · Upstream pin: `Engrace-Hospice/chartwarden@9e0899a`
(upstream `main` has not moved since the pin; re-check before starting).

Same roles as P0: Claude builds, ChatGPT reviews adversarially, the owner approves and merges. P1 is the **first change
to upstream ChartWarden**. Merged with defaults, it changes nothing at runtime: `RUST_ROUTES` is empty and the sweep is
off. P2 (shadow in production) is a separate owner decision after P1 is merged.

## Decisions needed from the owner before work starts

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Where the Rust image is built | **chartwarden-rust** builds and pushes `ghcr.io/engrace-hospice/chartwarden-rust:sha-<commit>` from a manual workflow. Upstream compose references it by digest through `CHARTWARDEN_RUST_IMAGE`, like the other app images, and `deploy.sh` verifies and rolls it. The alternative, vendoring the Rust source into upstream, couples the two repos before M02 is proven |
| D2 | Signing key | The owner generates an Ed25519 key pair on a trusted machine (one command, provided in P1). Only the **public** key goes in config Claude can see; the private key goes straight into `.env.production` as `CW_ACTOR_SIGNING_KEY`. Claude never sees it |
| D3 | Access | This session cannot reach upstream through the GitHub API. Attach `Engrace-Hospice/chartwarden` with push access for the P1 branch and PR. Its own CI follows upstream's rules (batched pushes, `debounce`) |
| D4 | Where the integration tests run | AT-05b, 09, 10 and 11 need Bun and Rust side by side in containers, which this sandbox cannot do (no Docker Hub). Either the owner's machine (a provided compose override and one script) or a manual-only job in chartwarden-rust. Recommendation: both. Local first for speed; the GitHub job is the independent record |
| D5 | Sweep time | A low-traffic hour; proposed 03:17 Pacific |

## Work breakdown

### A. chartwarden-rust (small PR, first)

1. `cw-server --healthcheck`: probe `/health` over the socket and exit 0 or 1, so the compose health check needs no curl.
2. Sweep fence: an assertion with `cls = "parity-sweep"` is accepted only for `GET /api/v1/me/permissions`; tests prove
   it is refused anywhere else.
3. `Dockerfile`: multi-stage, digest-pinned base images, non-root user, read-only root filesystem, the socket directory
   created with owner `cw-rust` and mode 0750.
4. A manual-only image workflow (`packages: write` only for that job) that builds, pushes and prints the digest. The
   digest is recorded in the evidence (AT-M02-07, image half).

### B. Upstream ChartWarden (one PR, everything off by default)

| Area | Change | Where (upstream) |
| --- | --- | --- |
| Signer | Ed25519 compact JWS, the claim set in spec §"Assertion format", 16-byte CSPRNG `jti`, ≤ 30 s lifetime, `kid`. Key loaded once at boot | new `apps/backend/src/bootstrap/rust-bridge/signer.ts` |
| Header hygiene | `onRequest`: delete any client `X-CW-Actor-Assertion` on **every** request; the forwarder sets its own | bridge plugin, registered before routes |
| Forwarder | Wraps a route's handler **after** authenticate and its `preHandler`s. `off`: original handler. `shadow`: send Bun's reply, then compare in the background (8 in flight, drop when full, 300 ms abort; on diff, re-resolve uncached for `explained:stale-cache`). `serve`: call Rust over the socket (`fetch` with `unix:`), validate the body schema, reply through Fastify; fall back to Bun's handler on every reason in spec §Fallback | `rust-bridge/forwarder.ts`, applied to `GET /api/v1/me/permissions` in `modules/03-authorization/routes/authz-routes.ts` |
| Config | `RUST_ROUTES` (default empty), `RUST_ROUTE_MODE=shadow\|serve`, `RUST_SOCKET`, `RUST_TIMEOUT_MS=300`, `RUST_PARITY_SWEEP=off`, `CW_ACTOR_SIGNING_KEY`. Boot fails closed when routes or the sweep are on without a key or socket | `bootstrap/env.ts` |
| Parity sweep | Spec §"Daily parity sweep": new platform job registered with `registerPlatformJob`, cross-tenant list through `withPlatformContext` (audited), fresh uncached resolver per pair, at most 2 in flight, counts-only logs | `rust-bridge/parity-sweep.ts` |
| Compose | `rust` service: `${CHARTWARDEN_RUST_IMAGE}`, `mem_limit`, `cpus`, no `ports`, `read_only`, `user`, the `rust-sock` volume mounted in `rust` and `api` only, health check via `--healthcheck`, `DATABASE_URL` as `chartwarden_app` | `deploy/production/compose.yml` |
| Deploy | Roll and verify `CHARTWARDEN_RUST_IMAGE` like the backend and web images | `deploy/production/deploy.sh` |
| nginx | `proxy_set_header X-CW-Actor-Assertion "";` in every vhost that proxies to `api` | `deploy/production/nginx/chartwarden-{backend,frontend,tenant}.conf` |
| Topology gate | Fails on: more than one Rust replica, `scale`, a second Rust service, any `ports:` on `rust`, `CW_RUST_TCP` in production env, the socket volume mounted anywhere but `api` and `rust` | extend `scripts/check-compose-policy.ts` (+ its test) |
| Header gate | Register `x-cw-actor-assertion` as `verified` | `scripts/check-request-header-auth.ts` registry |
| Controls | New row: Bun→Rust trust boundary (signed assertion, socket isolation, replay control, single replica), evidence = the new gate + tests. **Edits to this file need owner approval** | `compliance/controls.yaml` |
| Live suites | Every new live suite gets a `package.json` script **and** a `ci.yml` job (upstream's `arch:live-suites` rule) | `package.json`, `.github/workflows/ci.yml` |

Upstream rules P1 follows (from its `CLAUDE.md`):

- no upstream test is modified;
- `bun run build`, `typecheck`, `arch:fitness`, non-live tests and `check:boot:platform` all pass centrally;
- a fresh-agent code review and a security scan run before the PR (auth/RLS code), then the compliance reviewer;
- pushes are batched;
- the merge is the owner's.

### C. Integration evidence (local stack, then GitHub)

A compose override runs PostgreSQL (dedicated, marked disposable), Valkey, upstream `api`, and `rust` on a shared
socket. It seeds the M02 fixtures and drives:

| AT | What it proves |
| --- | --- |
| AT-04 (header) | A client-sent `X-CW-Actor-Assertion` is overwritten by Bun, and nginx drops it (config test) |
| AT-05b | With `RUST_ROUTES` empty, in shadow and in serve: identical status, headers and body seen by the client, modulo order; the 401 paths unchanged |
| AT-06 | `verify:retention` passes against the approved inventory, with new tests as additions only; upstream `authz-routes.test.ts` and `m3-role-templates.live.test.ts` pass unchanged |
| AT-07 (image) | Image digest recorded; the topology gate passes |
| AT-09 | Rust stopped → Bun answers within normal latency and `fallback:connect` increments; every fallback reason triggered once by a fault-injecting stub |
| AT-10 | Rust stalled, 1,000 concurrent requests → no added p99 beyond 5 ms, never more than 8 in flight, drops counted |
| AT-11 | The sweep covers every membership (count reconciled), catches a planted diff with counts-only logs, reports a mid-run grant change as `explained:race`, keeps at most 2 in flight, is off by default; Rust refuses `parity-sweep` on another path |

## Order of work

1. Owner decides D1–D5.
2. PR A in chartwarden-rust, then build and record the image digest.
3. Upstream branch: signer, header hygiene, forwarder (off), config, then the sweep (off), then the gates.
4. Local integration stack: AT-04, 05b, 09, 10, 11 on the owner's machine.
5. Upstream compose, deploy, nginx and the controls row (owner approves the controls edit).
6. Pre-PR reviews; open the upstream PR as draft.
7. ChatGPT adversarial review of PR A and the upstream PR; fix rounds.
8. Independent run of the integration job on GitHub.
9. Owner merges. Production behaviour is unchanged until the owner turns on P2.

## Stop conditions (in addition to the spec's)

- Any upstream test would have to change or be skipped.
- The forwarder cannot run strictly after upstream's authenticate hook and the route's `preHandler`s.
- The topology gate cannot express "exactly one Rust instance on the socket".
- `withPlatformContext` cannot list memberships without a broader bypass than one registered, audited job.
- A Rust error could reach a client in serve mode.

## Out of scope for P1

Turning shadow or serve on in production (P2/P3), a second Rust route, Rust-side session validation (M04), and
shared replay state (needed only before running more than one Rust instance).

## Decisions taken while building (deviations from the draft, for review)

| Draft said | Built | Why |
| --- | --- | --- |
| Sweep lists memberships cross-tenant through `withPlatformContext` | Lists active **orgs** through the existing audited enumerator, then each org's members under its own `withOrgContext` | No new cross-tenant read of `membership`; reuses an audited path |
| `deploy.sh` rolls and verifies `CHARTWARDEN_RUST_IMAGE` in P1 | The `rust` compose service sits behind the `rust` **profile**; `deploy.sh` is unchanged and never starts it | `deploy.sh` verifies every image with cosign against upstream's own workflow identity. Signing the Rust image (built in this repo) and teaching `deploy.sh` a second identity touches the production deploy path, so it becomes a **P2 prerequisite**, not something merged while the feature is off |
| Register `x-cw-actor-assertion` as `verified` | Registered as `not-authorization` in upstream's gate | Bun never believes the incoming header: it deletes it on every request. Verification happens in Rust |
| Socket directory from the image | A **tmpfs** named volume with `uid=65532,gid=1000,mode=0750` | Correct ownership whichever container mounts it first; the socket never persists |
| Sweep at 03:17 Pacific | `RUST_PARITY_SWEEP_UTC`, default `10:17` UTC | No time-zone library needed; 10:17 UTC is 03:17 PDT and 02:17 PST |

| Signing key "into `.env.production` for api" | Key read only from `CW_ACTOR_SIGNING_KEY_FILE` (a compose secret on `api`); `assertProductionEnv` refuses the inline variable | `.env.production` is injected into seven containers (independent review H2) |
| `rust` on the default network | `rust` only on an internal `rust-db` network shared with postgres; image default digest-pinned to an unpullable placeholder; both enforced by `arch:compose-policy` | Compliance review: no peers, no egress, never an unverified image |

## P2 prerequisites (gathered from the P1 reviews)

All of these must be done before shadow mode is switched on in production:

1. Cosign-sign the Rust image in this repo's image workflow, and teach `deploy.sh` to verify it against this repo's
   workflow identity and roll `CHARTWARDEN_RUST_IMAGE` by digest.
2. Provision the signing key as a compose secret mounted on `api` only, with `CW_ACTOR_SIGNING_KEY_FILE` pointing to it.
   Never put it in `.env.production`.
3. Set `RUST_*` on `api`'s `environment:` only, never in `.env.production`.
4. Recreate `postgres` once so it joins the internal `rust-db` network. This is a short planned database restart.
5. Pass AT-M02-05b, 09, 10 and 11 on a real Bun + Rust stack. Include a connection test as uid 1000 to confirm the
   socket file mode.
6. Owner go-ahead.
