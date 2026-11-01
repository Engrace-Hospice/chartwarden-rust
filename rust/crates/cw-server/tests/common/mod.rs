//! Shared setup for the live database tests. Compiled only with `--features live`.
#![allow(dead_code)]

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{ConnectOptions, PgPool};
use uuid::Uuid;

pub const ORG_A: Uuid = Uuid::from_u128(0xf0000000_0000_4000_8000_00000000000a);
pub const ORG_B: Uuid = Uuid::from_u128(0xf0000000_0000_4000_8000_00000000000b);

/// Fixture user `n` is `f0000000-0000-4000-8002-` followed by `n` in **decimal**, zero-padded to 12 digits
/// (matching m02.sql and the parity script), e.g. user(10) = …-000000000010.
pub fn user(n: u128) -> Uuid {
    Uuid::parse_str(&format!("f0000000-0000-4000-8002-{n:012}"))
        .unwrap_or_else(|_| panic!("bad fixture user {n}"))
}

/// Same password upstream's live suites use (`apps/backend/__tests__/_live-app-role.ts`).
pub const APP_ROLE_PASSWORD: &str = "chartwarden_app_live_test";
const FIXTURES: &str = include_str!("../fixtures/m02.sql");
static SEEDED: tokio::sync::Mutex<bool> = tokio::sync::Mutex::const_new(false);

/// Admin options from `CW_TEST_ADMIN_DATABASE_URL`. Refuses anything that is not loopback: these tests
/// grant LOGIN to `chartwarden_app` and rewrite fixture rows, so they must never reach a shared database.
pub fn admin_options() -> PgConnectOptions {
    let url = std::env::var("CW_TEST_ADMIN_DATABASE_URL").unwrap_or_else(|_| {
        panic!(
            "live tests need CW_TEST_ADMIN_DATABASE_URL (a migrated, ephemeral, loopback database)"
        )
    });
    let opts: PgConnectOptions = url
        .parse()
        .unwrap_or_else(|_| panic!("CW_TEST_ADMIN_DATABASE_URL is not a valid URL"));
    let host = opts.get_host();
    assert!(
        matches!(host, "localhost" | "127.0.0.1" | "::1") || host.starts_with('/'),
        "refusing non-loopback database host {host:?} for live tests"
    );
    opts
}

pub async fn admin_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(2)
        .connect_with(admin_options())
        .await
        .unwrap_or_else(|e| panic!("admin connect: {e}"))
}

/// The database must be explicitly designated disposable, and its cluster dedicated to it (review rounds 1 and 2):
/// loopback alone does not prove either.
/// Designate one with `COMMENT ON DATABASE <name> IS 'cw-ephemeral-test-db';` and destroy it after use.
pub const EPHEMERAL_MARKER: &str = "cw-ephemeral-test-db";

pub async fn assert_ephemeral(admin: &PgPool) {
    let (name, comment): (String, Option<String>) = sqlx::query_as(
        "SELECT d.datname::text, shobj_description(d.oid, 'pg_database') \
           FROM pg_database d WHERE d.datname = current_database()",
    )
    .fetch_one(admin)
    .await
    .unwrap_or_else(|e| panic!("read database comment: {e}"));
    let lower = name.to_lowercase();
    assert!(
        !["prod", "production", "live", "primary"]
            .iter()
            .any(|w| lower.contains(w)),
        "refusing database {name:?}: its name looks like a real environment"
    );
    assert_eq!(
        comment.as_deref(),
        Some(EPHEMERAL_MARKER),
        "refusing database {name:?}: not designated disposable. Run: COMMENT ON DATABASE {name} IS '{EPHEMERAL_MARKER}';"
    );
    // Roles are cluster-wide: `ALTER ROLE chartwarden_app LOGIN PASSWORD …` (and upstream's migrations) affect every
    // database in the cluster. So the cluster itself must be dedicated: no database besides this one and the
    // built-in postgres/template0/template1 (review round 2).
    let others: Vec<String> = sqlx::query_scalar(
        "SELECT datname::text FROM pg_database \
          WHERE datname NOT IN (current_database(), 'postgres', 'template0', 'template1') ORDER BY 1",
    )
    .fetch_all(admin)
    .await
    .unwrap_or_else(|e| panic!("list databases: {e}"));
    assert!(
        others.is_empty(),
        "refusing: this PostgreSQL cluster also holds {others:?}. Live tests change cluster-wide roles, so they need a dedicated, disposable cluster"
    );
}

/// Seeds fixtures and grants `chartwarden_app` LOGIN, once per test binary.
pub async fn seed() {
    let mut done = SEEDED.lock().await;
    if *done {
        return;
    }
    let admin = admin_pool().await;
    assert_ephemeral(&admin).await;
    let mut tx = admin.begin().await.unwrap_or_else(|e| panic!("begin: {e}"));
    sqlx::raw_sql(FIXTURES)
        .execute(&mut *tx)
        .await
        .unwrap_or_else(|e| panic!("fixtures: {e}"));
    sqlx::raw_sql(&format!(
        "ALTER ROLE chartwarden_app LOGIN PASSWORD '{APP_ROLE_PASSWORD}'"
    ))
    .execute(&mut *tx)
    .await
    .unwrap_or_else(|e| panic!("grant login: {e}"));
    tx.commit().await.unwrap_or_else(|e| panic!("commit: {e}"));
    admin.close().await;
    *done = true;
}

pub fn app_options() -> PgConnectOptions {
    admin_options()
        .username("chartwarden_app")
        .password(APP_ROLE_PASSWORD)
        .disable_statement_logging()
}

/// A pool connected as `chartwarden_app` (never a superuser) with `max` connections.
pub async fn app_pool(max: u32) -> PgPool {
    seed().await;
    PgPoolOptions::new()
        .max_connections(max)
        .connect_with(app_options())
        .await
        .unwrap_or_else(|e| panic!("app connect: {e}"))
}
