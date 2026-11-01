//! AT-M02-08, success path: a 200 response's logs carry ids and a count, never a permission key, the
//! assertion or a cookie. Own binary for the same reason as tests/logging.rs (tracing callsite interest).
#![cfg(feature = "live")]

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::*;
use cw_actor::testing::{claims, sign};
use cw_actor::{HEADER_NAME, KeyRing, Verifier};
use cw_server::{AppState, PERMISSIONS_PATH, VersionInfo, now_unix, router};
use ed25519_dalek::SigningKey;
use tower::ServiceExt;

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = Capture;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a_successful_request_logs_ids_and_a_count_but_no_permission_key() {
    let pool = app_pool(1).await; // seed before capturing, so fixture SQL is not in the capture
    let cap = Capture::default();
    let sub = tracing_subscriber::fmt()
        .json()
        .with_writer(cap.clone())
        .with_max_level(tracing::Level::TRACE)
        .finish();
    let _guard = tracing::subscriber::set_default(sub);

    let key = SigningKey::from_bytes(&[4; 32]);
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
    let req = Request::get(PERMISSIONS_PATH)
        .header(HEADER_NAME, &token)
        .header("cookie", "better-auth.session_token=SECRETCOOKIE")
        .body(Body::empty())
        .unwrap_or_default();
    let res = app.oneshot(req).await.unwrap_or_else(|_| unreachable!());
    assert_eq!(res.status(), StatusCode::OK);

    let logs = String::from_utf8_lossy(
        &cap.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    )
    .into_owned();
    assert!(
        logs.contains("\"permission_count\":3"),
        "count logged: {logs}"
    );
    assert!(
        logs.contains(&user(1).to_string()) && logs.contains(&ORG_A.to_string()),
        "ids logged: {logs}"
    );
    for leaked in [
        "patient.read",
        "visit.read",
        "encounter.read",
        "SECRETCOOKIE",
        "test-session", // the session id (sid) is not logged; rid correlates instead
        token.as_str(),
    ] {
        assert!(!logs.contains(leaked), "log leaked {leaked:?}");
    }
    for part in token.split('.') {
        assert!(!logs.contains(part), "log leaked a token segment");
    }
}
