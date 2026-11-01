//! AT-M02-08: logs never carry the assertion or a cookie.
//!
//! Its own test binary on purpose: `tracing` caches per-callsite interest process-wide, so a thread-local
//! capture subscriber in a binary shared with other (unsubscribed) tests silently misses events.

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::http::Request as HttpRequest;
use cw_actor::testing::{claims, sign};
use cw_actor::{HEADER_NAME, KeyRing, Verifier};
use cw_server::{AppState, PERMISSIONS_PATH, VersionInfo, now_unix, router};
use ed25519_dalek::SigningKey;
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;
use uuid::Uuid;

fn key() -> SigningKey {
    SigningKey::from_bytes(&[7; 32])
}

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

impl Capture {
    fn text(&self) -> String {
        String::from_utf8_lossy(
            &self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
        .into_owned()
    }
}

#[tokio::test(flavor = "current_thread")]
async fn logs_never_contain_the_assertion_or_cookie() {
    let cap = Capture::default();
    let sub = tracing_subscriber::fmt()
        .json()
        .with_writer(cap.clone())
        .with_max_level(tracing::Level::TRACE)
        .finish();
    let _guard = tracing::subscriber::set_default(sub);

    let good = sign(
        &claims(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            PERMISSIONS_PATH,
            now_unix(),
        ),
        "k1",
        &key(),
    );
    let bad = sign(
        &claims(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            PERMISSIONS_PATH,
            now_unix(),
        ),
        "k1",
        &SigningKey::from_bytes(&[9; 32]),
    );
    for t in [&good, &bad] {
        let req = HttpRequest::builder()
            .method("GET")
            .uri(PERMISSIONS_PATH)
            .header(HEADER_NAME, t.as_str())
            .header("cookie", "better-auth.session_token=SECRETCOOKIE")
            .body(Body::empty())
            .unwrap_or_default();
        let _ = app().oneshot(req).await;
    }
    let logs = cap.text();
    assert!(
        logs.contains("bad_signature"),
        "rejection reason is logged as a code: {logs}"
    );
    assert!(
        logs.contains("\"route\":\"/api/v1/me/permissions\""),
        "access log present: {logs}"
    );
    for secret in [good.as_str(), bad.as_str(), "SECRETCOOKIE"] {
        assert!(!logs.contains(secret), "log leaked a secret");
    }
    // No fragment of a token either (header, payload or signature segment).
    for part in good.split('.').chain(bad.split('.')) {
        assert!(!logs.contains(part), "log leaked a token segment");
    }
}

fn app() -> axum::Router {
    let pool = PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(300))
        .connect_lazy("postgres://chartwarden_app@127.0.0.1:1/none")
        .unwrap_or_else(|_| unreachable!("lazy pool construction does not connect"));
    router(Arc::new(AppState {
        verifier: Verifier::new(KeyRing::from_keys([(
            "k1".to_owned(),
            key().verifying_key(),
        )])),
        pool,
        version: VersionInfo {
            version: "v".into(),
            git_sha: "g".into(),
            build_time: "b".into(),
        },
    }))
}
