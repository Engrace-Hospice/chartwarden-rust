//! Server behaviour that needs no database (the database paths are in `tests/live.rs`).

use super::*;
use axum::body::Body;
use axum::http::Request as HttpRequest;
use cw_actor::KeyRing;
use cw_actor::testing::{claims, sign};
use ed25519_dalek::SigningKey;
use http_body_util::BodyExt;
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;
use tower::ServiceExt;
use uuid::Uuid;

fn key() -> SigningKey {
    SigningKey::from_bytes(&[7; 32])
}

/// A pool that can never connect: proves a path did not need the database, or exercises the DB-error path.
fn dead_pool() -> PgPool {
    PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(300))
        .connect_lazy("postgres://chartwarden_app@127.0.0.1:1/none")
        .unwrap_or_else(|_| unreachable!("lazy pool construction does not connect"))
}

fn app() -> Router {
    router(Arc::new(AppState {
        verifier: Verifier::new(KeyRing::from_keys([(
            "k1".to_owned(),
            key().verifying_key(),
        )])),
        pool: dead_pool(),
        version: VersionInfo {
            version: "v".into(),
            git_sha: "g".into(),
            build_time: "b".into(),
        },
    }))
}

async fn call(req: HttpRequest<Body>) -> (StatusCode, serde_json::Value) {
    let res = app()
        .oneshot(req)
        .await
        .unwrap_or_else(|_| unreachable!("router is infallible"));
    let status = res.status();
    let bytes = res
        .into_body()
        .collect()
        .await
        .map(|b| b.to_bytes())
        .unwrap_or_default();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

fn get(path: &str) -> axum::http::request::Builder {
    HttpRequest::builder().method("GET").uri(path)
}

fn valid_token() -> String {
    sign(
        &claims(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            PERMISSIONS_PATH,
            now_unix(),
        ),
        "k1",
        &key(),
    )
}

fn body() -> Body {
    Body::empty()
}

#[tokio::test]
async fn health_matches_upstream_body() {
    let (s, b) = call(get("/health").body(body()).unwrap_or_default()).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(b, serde_json::json!({ "status": "ok" }));
}

#[tokio::test]
async fn version_reports_build_identity() {
    let (s, b) = call(get("/version").body(body()).unwrap_or_default()).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        b,
        serde_json::json!({ "version": "v", "gitSha": "g", "buildTime": "b" })
    );
}

#[tokio::test]
async fn unknown_routes_get_the_error_envelope() {
    let (s, b) = call(get("/api/v1/patients").body(body()).unwrap_or_default()).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(b["error"]["code"], "NOT_FOUND");
}

#[tokio::test]
async fn permissions_without_an_assertion_is_401_and_never_touches_the_database() {
    let (s, b) = call(get(PERMISSIONS_PATH).body(body()).unwrap_or_default()).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(
        b,
        serde_json::json!({ "error": { "code": "UNAUTHORIZED", "message": "Authentication required" } })
    );
}

#[tokio::test]
async fn a_better_auth_cookie_alone_is_401() {
    let req = get(PERMISSIONS_PATH)
        .header("cookie", "better-auth.session_token=abc.def")
        .body(body())
        .unwrap_or_default();
    assert_eq!(call(req).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn two_assertion_headers_are_refused() {
    let t = valid_token();
    let req = get(PERMISSIONS_PATH)
        .header(HEADER_NAME, &t)
        .header(HEADER_NAME, &t)
        .body(body())
        .unwrap_or_default();
    assert_eq!(call(req).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn an_assertion_for_another_path_is_401() {
    let t = sign(
        &claims(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            "/api/v1/me/session",
            now_unix(),
        ),
        "k1",
        &key(),
    );
    let req = get(PERMISSIONS_PATH)
        .header(HEADER_NAME, t)
        .body(body())
        .unwrap_or_default();
    assert_eq!(call(req).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_query_string_does_not_change_the_bound_path() {
    // The assertion binds the path only; the query never reaches the resolver.
    let req = get(&format!("{PERMISSIONS_PATH}?x=1"))
        .header(HEADER_NAME, valid_token())
        .body(body())
        .unwrap_or_default();
    // Valid assertion → reaches the (dead) database → 500, not 401.
    assert_eq!(call(req).await.0, StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn a_database_failure_is_a_500_envelope_bun_will_fall_back_on() {
    let req = get(PERMISSIONS_PATH)
        .header(HEADER_NAME, valid_token())
        .body(body())
        .unwrap_or_default();
    let (s, b) = call(req).await;
    assert_eq!(s, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(b["error"]["code"], "INTERNAL_ERROR");
}

#[tokio::test]
async fn post_is_not_allowed() {
    let req = HttpRequest::builder()
        .method("POST")
        .uri(PERMISSIONS_PATH)
        .body(body())
        .unwrap_or_default();
    assert_eq!(call(req).await.0, StatusCode::METHOD_NOT_ALLOWED);
}
