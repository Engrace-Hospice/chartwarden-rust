//! ChartWarden Rust API (CW-RUST-M02 P0).
//!
//! Routes:
//! - `GET /health`: liveness, `{"status":"ok"}` (same body as upstream `bootstrap/routes/health.ts`).
//! - `GET /version`: build identity from `APP_VERSION`, `GIT_SHA`, `BUILD_TIME`.
//! - `GET /api/v1/me/permissions`: the caller's effective permission keys in the active org.
//!
//! Clients never talk to this server. Bun authenticates, forwards with a signed actor assertion, validates
//! the body and sends it through its own reply (spec §"HTTP behaviour"). Error bodies here use upstream's
//! envelope so logs and tests read the same, but they are fallback signals for Bun, not client responses.

use std::sync::Arc;
use std::time::Instant;

use axum::extract::{MatchedPath, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use cw_actor::{Binding, HEADER_NAME, Verifier};
use cw_tenancy::{OrgContext, OrgTx};
use serde::Serialize;
use sqlx::PgPool;

pub const PERMISSIONS_PATH: &str = "/api/v1/me/permissions";

pub struct AppState {
    pub verifier: Verifier,
    pub pool: PgPool,
    pub version: VersionInfo,
}

#[derive(Clone, Serialize)]
pub struct VersionInfo {
    pub version: String,
    #[serde(rename = "gitSha")]
    pub git_sha: String,
    #[serde(rename = "buildTime")]
    pub build_time: String,
}

impl VersionInfo {
    pub fn from_env() -> Self {
        let var = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_owned());
        Self {
            version: var("APP_VERSION", "dev"),
            git_sha: var("GIT_SHA", "unknown"),
            build_time: var("BUILD_TIME", "unknown"),
        }
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/version", get(version))
        .route(PERMISSIONS_PATH, get(me_permissions))
        .fallback(not_found)
        .layer(middleware::from_fn(access_log))
        .with_state(state)
}

/// What the access log may say about a request. Set by handlers as a response extension.
/// Deliberately has no field for the assertion, cookies or permission keys (AT-M02-08).
#[derive(Clone, Default)]
struct LogFields {
    request_id: Option<String>,
    user_id: Option<String>,
    organization_id: Option<String>,
    outcome: &'static str,
    permission_count: Option<usize>,
}

async fn access_log(req: Request, next: Next) -> Response {
    let started = Instant::now();
    let method = req.method().clone();
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map_or_else(|| "unmatched".to_owned(), |p| p.as_str().to_owned());
    let res = next.run(req).await;
    let f = res
        .extensions()
        .get::<LogFields>()
        .cloned()
        .unwrap_or_default();
    tracing::info!(
        target: "cw_server::access",
        method = %method,
        route = %route,
        status = res.status().as_u16(),
        latency_ms = started.elapsed().as_secs_f64() * 1000.0,
        rid = f.request_id.as_deref().unwrap_or(""),
        user_id = f.user_id.as_deref().unwrap_or(""),
        org_id = f.organization_id.as_deref().unwrap_or(""),
        outcome = f.outcome,
        permission_count = f.permission_count,
        "request"
    );
    res
}

#[derive(Serialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Serialize)]
struct ErrorDetail {
    code: &'static str,
    message: &'static str,
}

fn error(
    status: StatusCode,
    code: &'static str,
    message: &'static str,
    fields: LogFields,
) -> Response {
    let mut res = (
        status,
        Json(ErrorBody {
            error: ErrorDetail { code, message },
        }),
    )
        .into_response();
    res.extensions_mut().insert(fields);
    res
}

async fn health() -> Response {
    let mut res = Json(serde_json::json!({ "status": "ok" })).into_response();
    res.extensions_mut().insert(LogFields {
        outcome: "ok",
        ..Default::default()
    });
    res
}

async fn version(State(state): State<Arc<AppState>>) -> Response {
    let mut res = Json(state.version.clone()).into_response();
    res.extensions_mut().insert(LogFields {
        outcome: "ok",
        ..Default::default()
    });
    res
}

async fn not_found() -> Response {
    error(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        "Route not found",
        LogFields {
            outcome: "not_found",
            ..Default::default()
        },
    )
}

#[derive(Serialize)]
pub struct PermissionsBody {
    pub permissions: Vec<String>,
}

pub fn now_unix() -> i64 {
    chrono::Utc::now().timestamp()
}

async fn me_permissions(State(state): State<Arc<AppState>>, req: Request) -> Response {
    // Exactly one assertion header; duplicates are ambiguous and refused.
    let mut values = req.headers().get_all(HEADER_NAME).iter();
    let token = match (values.next(), values.next()) {
        (Some(v), None) => v.to_str().ok(),
        (None, _) => None,
        (Some(_), Some(_)) => Some(""),
    };
    let binding = Binding {
        method: req.method().as_str(),
        path: req.uri().path(),
    };
    let actor = match state.verifier.verify(token, &binding, now_unix()) {
        Ok(a) => a,
        Err(rejection) => {
            tracing::warn!(target: "cw_server::auth", reason = rejection.as_str(), "assertion rejected");
            return error(
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "Authentication required",
                LogFields {
                    outcome: "rejected",
                    ..Default::default()
                },
            );
        }
    };

    let fields = LogFields {
        request_id: Some(actor.request_id.clone()),
        user_id: Some(actor.user_id.to_string()),
        organization_id: Some(actor.organization_id.to_string()),
        outcome: "ok",
        permission_count: None,
    };
    let ctx = OrgContext {
        organization_id: actor.organization_id,
        user_id: actor.user_id,
    };

    match resolve(&state.pool, ctx).await {
        Ok(permissions) => {
            let mut res = Json(PermissionsBody {
                permissions: permissions.clone(),
            })
            .into_response();
            res.extensions_mut().insert(LogFields {
                permission_count: Some(permissions.len()),
                ..fields
            });
            res
        }
        Err(e) => {
            // SQLSTATE only: driver messages can echo values.
            let sqlstate = match &e {
                sqlx::Error::Database(d) => d.code().map(|c| c.into_owned()),
                _ => None,
            };
            tracing::error!(target: "cw_server::db", sqlstate = sqlstate.as_deref().unwrap_or(""), kind = db_error_kind(&e), "permission resolution failed");
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                "An unexpected error occurred",
                LogFields {
                    outcome: "db_error",
                    ..fields
                },
            )
        }
    }
}

fn db_error_kind(e: &sqlx::Error) -> &'static str {
    match e {
        sqlx::Error::Database(_) => "database",
        sqlx::Error::PoolTimedOut => "pool_timeout",
        sqlx::Error::Io(_) => "io",
        sqlx::Error::Tls(_) => "tls",
        _ => "other",
    }
}

/// One org-scoped, read-only transaction: load grants under RLS, fold, end the transaction.
pub async fn resolve(pool: &PgPool, ctx: OrgContext) -> Result<Vec<String>, sqlx::Error> {
    let mut tx = OrgTx::begin(pool, ctx)
        .await
        .map_err(|cw_tenancy::TenancyError::Db(e)| e)?;
    let grants = cw_authz::load_grants(&mut tx, ctx.organization_id, ctx.user_id).await?;
    let now = chrono::Utc::now();
    tx.finish()
        .await
        .map_err(|cw_tenancy::TenancyError::Db(e)| e)?;
    Ok(cw_authz::resolve_effective_permissions(&grants, now)
        .into_iter()
        .collect())
}

#[cfg(test)]
mod tests;
