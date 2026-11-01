//! `cw-server` binary. Configuration (environment):
//!
//! | Variable | Meaning |
//! | --- | --- |
//! | `DATABASE_URL` | PostgreSQL URL for the `chartwarden_app` role (startup refuses any other role, a superuser or BYPASSRLS) |
//! | `CW_ACTOR_PUBLIC_KEYS` | `kid=<base64url Ed25519 public key>[,kid=...]`: keys Bun signs assertions with |
//! | `CW_RUST_SOCKET` | Unix socket path to listen on (default `/run/cw-rust/cw-rust.sock`) |
//! | `CW_RUST_TCP` | Local development only: listen on this TCP address instead; must be loopback |
//! | `CW_DB_MAX_CONNECTIONS` | Pool size (default 5) |
//! | `APP_VERSION`, `GIT_SHA`, `BUILD_TIME` | Reported by `/version` |
//! | `RUST_LOG` | Log filter (default `info`) |

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use cw_actor::{KeyRing, Verifier};
use cw_server::{AppState, VersionInfo, router};
use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::EnvFilter;

const DEFAULT_SOCKET: &str = "/run/cw-rust/cw-rust.sock";

fn fail(msg: &str) -> ! {
    tracing::error!(target: "cw_server::startup", "{msg}");
    eprintln!("cw-server: {msg}");
    std::process::exit(2);
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .json()
        .flatten_event(true)
        .with_current_span(false)
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let keys = std::env::var("CW_ACTOR_PUBLIC_KEYS").unwrap_or_default();
    let ring =
        KeyRing::parse(&keys).unwrap_or_else(|e| fail(&format!("CW_ACTOR_PUBLIC_KEYS: {e}")));

    let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| fail("DATABASE_URL is required"));
    let max = std::env::var("CW_DB_MAX_CONNECTIONS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5);
    let pool = PgPoolOptions::new()
        .max_connections(max)
        .acquire_timeout(Duration::from_secs(2))
        .connect(&url)
        .await
        .unwrap_or_else(|_| fail("cannot connect to DATABASE_URL"));

    let role = cw_tenancy::check_app_role(&pool)
        .await
        .unwrap_or_else(|_| fail("cannot read the connected role"));
    if !role.is_acceptable() {
        fail(&format!(
            "refusing to start: connected as {:?} (superuser={}, bypassrls={}); must be chartwarden_app without either",
            role.current_user, role.superuser, role.bypass_rls
        ));
    }

    let state = Arc::new(AppState {
        verifier: Verifier::new(ring),
        pool,
        version: VersionInfo::from_env(),
    });
    let app = router(state);

    if let Ok(tcp) = std::env::var("CW_RUST_TCP") {
        let addr: SocketAddr = tcp
            .parse()
            .unwrap_or_else(|_| fail("CW_RUST_TCP is not host:port"));
        if !addr.ip().is_loopback() {
            fail("CW_RUST_TCP must be a loopback address (production uses CW_RUST_SOCKET)");
        }
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .unwrap_or_else(|_| fail("cannot bind CW_RUST_TCP"));
        tracing::info!(target: "cw_server::startup", listen = %addr, keys = keys.split(',').count(), "listening (tcp, development)");
        if axum::serve(listener, app)
            .with_graceful_shutdown(shutdown())
            .await
            .is_err()
        {
            fail("server error");
        }
        return;
    }

    let path = std::env::var("CW_RUST_SOCKET").unwrap_or_else(|_| DEFAULT_SOCKET.to_owned());
    let listener = bind_socket(&path).unwrap_or_else(|e| fail(&format!("cannot bind {path}: {e}")));
    tracing::info!(target: "cw_server::startup", socket = %path, "listening (unix socket)");
    let served = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await;
    let _ = std::fs::remove_file(&path);
    if served.is_err() {
        fail("server error");
    }
}

/// Binds the Unix socket with mode 0660 (owner and group: the `api` container shares the group).
/// A stale socket from a previous run is replaced; any other file at the path is left alone and refused.
fn bind_socket(path: &str) -> std::io::Result<tokio::net::UnixListener> {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if meta.file_type().is_socket() {
            std::fs::remove_file(path)?;
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "path exists and is not a socket",
            ));
        }
    }
    let listener = tokio::net::UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o660))?;
    Ok(listener)
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! { () = ctrl_c => {}, () = term => {} }
}
