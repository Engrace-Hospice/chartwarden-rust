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
//!
//! `cw-server --healthcheck` probes `/health` over `CW_RUST_SOCKET` and exits 0 (healthy) or 1.

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

/// `cw-server --healthcheck`: GET /health over the Unix socket, exit 0 on a 200 and 1 otherwise. For the compose
/// health check, so the runtime image needs no curl or shell. Reads only `CW_RUST_SOCKET`; touches no database.
fn healthcheck() -> ! {
    use std::io::{Read, Write};
    use std::time::Duration;
    let path = std::env::var("CW_RUST_SOCKET").unwrap_or_else(|_| DEFAULT_SOCKET.to_owned());
    let ok = (|| -> std::io::Result<bool> {
        let mut s = std::os::unix::net::UnixStream::connect(&path)?;
        s.set_read_timeout(Some(Duration::from_secs(2)))?;
        s.set_write_timeout(Some(Duration::from_secs(2)))?;
        s.write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
        let mut buf = [0u8; 64];
        let n = s.read(&mut buf)?;
        Ok(buf[..n].starts_with(b"HTTP/1.1 200"))
    })()
    .unwrap_or(false);
    std::process::exit(if ok { 0 } else { 1 });
}

#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        healthcheck();
    }
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
    // `_lock` is held until the process exits.
    let (listener, _lock) =
        bind_socket(&path).unwrap_or_else(|e| fail(&format!("cannot bind {path}: {e}")));
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
///
/// Single instance per socket path (review finding P1-3/P1-4):
/// 1. take an exclusive `flock` on `<path>.lock`, held for the life of the process; a second instance fails here;
/// 2. if a socket file still exists, probe it: a live listener means something else is serving, so refuse;
///    only a dead (stale) socket is removed;
/// 3. any non-socket file at the path is refused, never deleted.
fn bind_socket(path: &str) -> std::io::Result<(tokio::net::UnixListener, std::fs::File)> {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(format!("{path}.lock"))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "another cw-server instance holds this socket's lock",
            ));
        }
        Err(std::fs::TryLockError::Error(e)) => return Err(e),
    }
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if !meta.file_type().is_socket() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "path exists and is not a socket",
            ));
        }
        if std::os::unix::net::UnixStream::connect(path).is_ok() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "a live listener is already serving this socket",
            ));
        }
        std::fs::remove_file(path)?;
    }
    let listener = tokio::net::UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o660))?;
    Ok((listener, lock))
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
