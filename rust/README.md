# ChartWarden Rust workspace

CW-RUST-M02 P0: the first Rust endpoint, `GET /api/v1/me/permissions`. The spec is `docs/CW-RUST-M02.md`, and the
evidence for this phase is `verification/M02-P0-EVIDENCE.md`.

| Crate | Role |
| --- | --- |
| `cw-actor` | Verifies the signed actor assertion Bun attaches (strict EdDSA JWS, method/path binding, single-use `jti`) |
| `cw-authz` | Port of upstream `roleConfersKey`, `loadGrants` and `resolveEffectivePermissions` |
| `cw-tenancy` | `READ ONLY` org-scoped transactions with bound `set_config`; startup role check |
| `cw-server` | Axum binary: `/health`, `/version`, `/api/v1/me/permissions`, on a Unix socket |

`unsafe` is forbidden in every crate. `unwrap()` is denied outside tests.

## Commands

```sh
cd rust
cargo build --locked
cargo test --locked --workspace                      # unit tests, no database
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo fmt --all --check
scripts/supply-chain.sh                              # toolchain pin, build, fmt, clippy, cargo deny, cargo audit

# Live tests: a migrated database on a DEDICATED, disposable, loopback PostgreSQL cluster, marked with
#   COMMENT ON DATABASE <name> IS 'cw-ephemeral-test-db';
# They change cluster-wide roles and rewrite fixture rows, so they refuse non-loopback hosts, unmarked databases,
# and clusters holding any other database. Destroy the cluster afterwards.
CW_TEST_ADMIN_DATABASE_URL=postgres://postgres@localhost:5433/chartwarden_catalog \
  cargo test --locked -p cw-server --features live

# Parity with upstream's real resolver (from the repo root)
bun run verify:m02-reserved --source <upstream checkout>
bun run verify:m02-parity --source <upstream checkout with node_modules> \
  --admin-url postgres://postgres@localhost:5433/chartwarden_catalog --rust-bin rust/target/debug/cw-server
```

The toolchain is pinned in `rust-toolchain.toml` (1.97.0). Where rustup cannot download it (as in the build sandbox),
`RUSTUP_TOOLCHAIN=stable` works only if `rustc --version` reports exactly 1.97.0.

## Running the server

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | `chartwarden_app` connection. Startup refuses any other role, a superuser, or BYPASSRLS |
| `CW_ACTOR_PUBLIC_KEYS` | `kid=<base64url Ed25519 public key>[,kid=...]` |
| `CW_RUST_SOCKET` | Unix socket (default `/run/cw-rust/cw-rust.sock`, mode 0660) |
| `CW_RUST_TCP` | Development only: loopback TCP address instead of the socket |
| `CW_DB_MAX_CONNECTIONS` | Pool size (default 5) |
| `APP_VERSION`, `GIT_SHA`, `BUILD_TIME` | Reported by `/version` |

There is no container image yet. It belongs to P1 with the compose service, where it can be built and its digest
recorded.
