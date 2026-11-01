//! AT-M02-02 (RLS fails closed), AT-M02-03 (read-only) and the endpoint end to end, against a real migrated
//! PostgreSQL, connected as `chartwarden_app`. Never asserts tenant isolation on a superuser connection.
//!
//!   CW_TEST_ADMIN_DATABASE_URL=postgres://postgres@localhost:5433/chartwarden_catalog \
//!     cargo test -p cw-server --features live --test live
#![cfg(feature = "live")]

mod common;

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::*;
use cw_actor::testing::{claims, sign};
use cw_actor::{HEADER_NAME, KeyRing, Verifier};
use cw_server::{AppState, PERMISSIONS_PATH, VersionInfo, now_unix, resolve, router};
use cw_tenancy::{OrgContext, OrgTx, check_app_role};
use ed25519_dalek::SigningKey;
use http_body_util::BodyExt;
use sqlx::{PgPool, Row};
use tower::ServiceExt;
use uuid::Uuid;

const RBAC_TABLES: [&str; 4] = ["membership", "membership_role", "role", "role_permission"];

fn set(keys: &[&str]) -> BTreeSet<String> {
    keys.iter().map(|k| (*k).to_owned()).collect()
}

async fn perms(pool: &PgPool, org: Uuid, user: Uuid) -> BTreeSet<String> {
    resolve(
        pool,
        OrgContext {
            organization_id: org,
            user_id: user,
        },
    )
    .await
    .unwrap_or_else(|e| panic!("resolve: {e}"))
    .into_iter()
    .collect()
}

/// A query that must not return another tenant's rows. Either an error (fail closed with 22P02) or no rows.
async fn rows_or_error(conn: &mut sqlx::PgConnection, sql: &str) -> Result<i64, String> {
    match sqlx::query(sql).fetch_one(&mut *conn).await {
        Ok(r) => Ok(r.try_get::<i64, _>(0).unwrap_or(-1)),
        Err(sqlx::Error::Database(d)) => Err(d.code().map(|c| c.into_owned()).unwrap_or_default()),
        Err(e) => panic!("unexpected error: {e}"),
    }
}

// ---- AT-M02-02 (h): the connection and the tables are what the RLS argument assumes ----

#[tokio::test]
async fn h_app_role_is_nobypassrls_not_superuser_not_owner_and_tables_force_rls() {
    let pool = app_pool(1).await;
    let role = check_app_role(&pool)
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(role.is_acceptable(), "{role:?}");
    for t in RBAC_TABLES {
        let r = sqlx::query(
            "SELECT c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) \
               FROM pg_class c WHERE c.oid = ('public.' || $1)::regclass",
        )
        .bind(t)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("{e}"));
        let (enabled, forced, owner): (bool, bool, String) = (r.get(0), r.get(1), r.get(2));
        assert!(
            enabled && forced,
            "{t}: RLS enabled={enabled} forced={forced}"
        );
        assert_ne!(
            owner, "chartwarden_app",
            "{t} must not be owned by the app role"
        );
    }
}

#[tokio::test]
async fn startup_check_refuses_a_superuser_connection() {
    let admin = admin_pool().await;
    let role = check_app_role(&admin)
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(
        !role.is_acceptable(),
        "a superuser pool must be refused: {role:?}"
    );
}

// ---- AT-M02-02 (a, b) + fixture expectations ----

#[tokio::test]
async fn ab_each_fixture_actor_gets_exactly_its_effective_set() {
    let pool = app_pool(2).await;
    let cases: [(u128, Uuid, &[&str]); 11] = [
        (1, ORG_A, &["encounter.read", "patient.read", "visit.read"]), // union of rn + scheduler
        (1, ORG_B, &["role.read"]), // (a) same user, other org: only B's keys
        (2, ORG_A, &[]),            // disabled role
        (3, ORG_A, &["encounter.read", "visit.read"]), // expired rn dropped, future scheduler kept
        (4, ORG_A, &[]),            // (b) suspended membership
        (5, ORG_A, &[]),            // (b) revoked membership
        (6, ORG_A, &["audit.read"]), // platform-owned role confers
        (7, ORG_A, &["patient.read", "visit.read"]), // reserved tenant rows confer nothing
        (8, ORG_A, &[]),            // no membership
        (9, ORG_A, &[]),            // pending membership
        (2, ORG_B, &[]),            // no membership in B
    ];
    for (u, org, want) in cases {
        assert_eq!(
            perms(&pool, org, user(u)).await,
            set(want),
            "user {u} org {org}"
        );
    }
    // An org that does not exist.
    assert!(
        perms(&pool, Uuid::from_u128(0xdead), user(1))
            .await
            .is_empty()
    );
}

// ---- AT-M02-02 (c): GUC never set → no rows ----

#[tokio::test]
async fn c_unset_org_context_returns_no_rows() {
    let pool = app_pool(1).await;
    // A brand-new connection: app.org_id has never been set in this session.
    let mut conn = pool.acquire().await.unwrap_or_else(|e| panic!("{e}"));
    let guc: Option<String> = sqlx::query_scalar("SELECT current_setting('app.org_id', true)")
        .fetch_one(&mut *conn)
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(
        guc.is_none(),
        "fresh connection must have no org context, got {guc:?}"
    );
    for t in RBAC_TABLES {
        let n = rows_or_error(
            &mut conn,
            &format!("SELECT count(*) FROM {t} WHERE organization_id = '{ORG_A}'"),
        )
        .await;
        assert!(matches!(n, Ok(0) | Err(_)), "{t}: {n:?}");
    }
}

// ---- AT-M02-02 (d): reused pooled connection, GUC reverted to '' → error or nothing ----

#[tokio::test]
async fn d_reused_connection_with_empty_org_context_fails_closed() {
    let pool = app_pool(1).await;
    // Use the single connection for a real org transaction first...
    assert!(!perms(&pool, ORG_A, user(1)).await.is_empty());
    // ...then take the same connection outside any org context.
    let mut conn = pool.acquire().await.unwrap_or_else(|e| panic!("{e}"));
    let guc: Option<String> = sqlx::query_scalar("SELECT current_setting('app.org_id', true)")
        .fetch_one(&mut *conn)
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        guc.as_deref(),
        Some(""),
        "upstream's documented behaviour: a transaction-local GUC reverts to ''"
    );
    let mut saw_error = false;
    for t in RBAC_TABLES {
        match rows_or_error(
            &mut conn,
            &format!("SELECT count(*) FROM {t} WHERE organization_id = '{ORG_A}'"),
        )
        .await
        {
            Ok(n) => assert_eq!(n, 0, "{t} returned rows with an empty org context"),
            Err(code) => {
                assert_eq!(code, "22P02", "{t}");
                saw_error = true;
            }
        }
    }
    assert!(
        saw_error,
        "membership_role/role/role_permission cast '' to uuid and must raise 22P02"
    );
    // The full grant query outside an org transaction: error or nothing.
    let r = cw_authz::load_grants(&mut conn, ORG_A, user(1)).await;
    assert!(r.as_ref().map(Vec::is_empty).unwrap_or(true), "{r:?}");
}

// ---- AT-M02-02 (e): malformed org id ----

#[tokio::test]
async fn e_malformed_org_id_cannot_reach_sql_and_the_database_rejects_it_anyway() {
    // In Rust the type system stops it: OrgContext holds a Uuid, and cw-actor rejects non-canonical ids
    // (cw-actor tests: identities_must_be_canonical_uuids). Belt and braces: the database fails closed too.
    let pool = app_pool(1).await;
    let mut tx = pool.begin().await.unwrap_or_else(|e| panic!("{e}"));
    sqlx::query("SELECT set_config('app.org_id', 'not-a-uuid', true)")
        .execute(&mut *tx)
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    let n = rows_or_error(&mut tx, "SELECT count(*) FROM membership_role").await;
    assert_eq!(n, Err("22P02".to_owned()));
}

// ---- AT-M02-02 (f): org context set to another tenant ----

#[tokio::test]
async fn f_mismatched_org_context_hides_the_other_tenants_rows() {
    let pool = app_pool(1).await;
    // GUC says B, the explicit predicate asks for A: RLS wins, nothing from A is visible.
    let mut tx = OrgTx::begin(
        &pool,
        OrgContext {
            organization_id: ORG_B,
            user_id: user(1),
        },
    )
    .await
    .unwrap_or_else(|e| panic!("{e}"));
    let grants = cw_authz::load_grants(&mut tx, ORG_A, user(1))
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(
        grants.is_empty(),
        "org A grants visible under org B context: {grants:?}"
    );
    let leaked: i64 = sqlx::query_scalar(&format!(
        "SELECT count(*) FROM membership_role WHERE organization_id = '{ORG_A}'"
    ))
    .fetch_one(&mut *tx)
    .await
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(leaked, 0);
}

// ---- AT-M02-02 (g): one pooled connection serving A then B ----

#[tokio::test]
async fn g_a_single_pooled_connection_never_carries_one_tenant_into_the_next() {
    let pool = app_pool(1).await;
    assert_eq!(
        perms(&pool, ORG_A, user(1)).await,
        set(&["encounter.read", "patient.read", "visit.read"])
    );
    assert_eq!(perms(&pool, ORG_B, user(1)).await, set(&["role.read"]));
    assert_eq!(
        perms(&pool, ORG_A, user(1)).await,
        set(&["encounter.read", "patient.read", "visit.read"])
    );
    // And a plain transaction on that same connection, without set_config, sees nothing.
    let mut tx = pool.begin().await.unwrap_or_else(|e| panic!("{e}"));
    for t in RBAC_TABLES {
        let n = rows_or_error(
            &mut tx,
            &format!("SELECT count(*) FROM {t} WHERE organization_id IN ('{ORG_A}', '{ORG_B}')"),
        )
        .await;
        assert!(matches!(n, Ok(0) | Err(_)), "{t}: {n:?}");
    }
}

// ---- AT-M02-03: the database refuses writes ----

#[tokio::test]
async fn at03_writes_inside_an_org_transaction_fail_with_25006() {
    let pool = app_pool(1).await;
    let mut tx = OrgTx::begin(
        &pool,
        OrgContext {
            organization_id: ORG_A,
            user_id: user(1),
        },
    )
    .await
    .unwrap_or_else(|e| panic!("{e}"));
    let err = sqlx::query(
        "INSERT INTO membership_role (organization_id, membership_id, role_id) \
         VALUES ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8003-0000000002a0', 'f0000000-0000-4000-8001-0000000000a1')",
    )
    .execute(&mut *tx)
    .await
    .err();
    let code = match err {
        Some(sqlx::Error::Database(d)) => d.code().map(|c| c.into_owned()),
        other => panic!("expected a database error, got {other:?}"),
    };
    assert_eq!(code.as_deref(), Some("25006"), "read_only_sql_transaction");
    drop(tx);
    // `SET TRANSACTION READ WRITE` cannot undo it once a query has run.
    let mut tx = OrgTx::begin(
        &pool,
        OrgContext {
            organization_id: ORG_A,
            user_id: user(1),
        },
    )
    .await
    .unwrap_or_else(|e| panic!("{e}"));
    let undo = sqlx::query("SET TRANSACTION READ WRITE")
        .execute(&mut *tx)
        .await;
    assert!(
        undo.is_err(),
        "access mode must be fixed after the first query"
    );
}

// ---- The endpoint, end to end over the router with a real database ----

#[tokio::test]
async fn endpoint_returns_the_sorted_set_and_rejects_a_replay() {
    let pool = app_pool(2).await;
    let key = SigningKey::from_bytes(&[5; 32]);
    let app = router(Arc::new(AppState {
        verifier: Verifier::new(KeyRing::from_keys([("k".to_owned(), key.verifying_key())])),
        pool,
        version: VersionInfo {
            version: "t".into(),
            git_sha: "t".into(),
            build_time: "t".into(),
        },
    }));
    let token = sign(
        &claims(user(1), ORG_A, PERMISSIONS_PATH, now_unix()),
        "k",
        &key,
    );
    let req = || {
        Request::get(PERMISSIONS_PATH)
            .header(HEADER_NAME, &token)
            .body(Body::empty())
            .unwrap_or_default()
    };

    let res = app
        .clone()
        .oneshot(req())
        .await
        .unwrap_or_else(|_| unreachable!());
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("application/json")
    );
    let bytes = res
        .into_body()
        .collect()
        .await
        .map(|b| b.to_bytes())
        .unwrap_or_default();
    assert_eq!(
        &bytes[..],
        br#"{"permissions":["encounter.read","patient.read","visit.read"]}"#
    );

    let replay = app.oneshot(req()).await.unwrap_or_else(|_| unreachable!());
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
}
