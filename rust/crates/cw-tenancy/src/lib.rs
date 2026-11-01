//! Org-scoped, **read-only** transactions (CW-RUST-M02 §"Database access and RLS").
//!
//! Port of upstream `withOrgContext` (`packages/tenancy/src/context.ts`) with one deliberate
//! tightening: every M02 transaction is `READ ONLY`, so the database, not just this code, refuses writes.
//!
//! - `app.org_id` / `app.user_id` are set with `set_config(name, $value, true)`: bound parameters
//!   (never interpolated) and transaction-local, so they reset at COMMIT/ROLLBACK and never leak to the
//!   next checkout of a pooled connection.
//! - Ids are typed [`Uuid`]s, so a malformed id cannot reach SQL.
//! - The transaction rolls back on drop; read-only work never needs to commit, but [`OrgTx::finish`]
//!   commits explicitly so a failure to end the transaction surfaces as an error.

use std::ops::{Deref, DerefMut};
use std::time::Duration;

use sqlx::{PgConnection, PgPool, Postgres, Transaction};
use uuid::Uuid;

/// The tenant scope of one request (upstream `OrgContext`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrgContext {
    pub organization_id: Uuid,
    pub user_id: Uuid,
}

#[derive(Debug, thiserror::Error)]
pub enum TenancyError {
    #[error("database error")]
    Db(#[from] sqlx::Error),
}

/// Statement timeout applied inside every org transaction.
pub const STATEMENT_TIMEOUT: Duration = Duration::from_secs(2);

/// An open `READ ONLY` transaction with the tenant GUCs set.
pub struct OrgTx {
    tx: Transaction<'static, Postgres>,
}

impl OrgTx {
    /// `BEGIN; SET TRANSACTION READ ONLY; set_config(...)`. The first statement after BEGIN fixes the
    /// transaction's access mode, so nothing in this transaction can write.
    pub async fn begin(pool: &PgPool, ctx: OrgContext) -> Result<Self, TenancyError> {
        let mut tx = pool.begin().await?;
        sqlx::query("SET TRANSACTION READ ONLY")
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), \
                    set_config('statement_timeout', $3, true)",
        )
        .bind(ctx.organization_id.to_string())
        .bind(ctx.user_id.to_string())
        .bind(STATEMENT_TIMEOUT.as_millis().to_string())
        .execute(&mut *tx)
        .await?;
        Ok(Self { tx })
    }

    /// Ends the transaction. (COMMIT of a read-only transaction changes nothing.)
    pub async fn finish(self) -> Result<(), TenancyError> {
        self.tx.commit().await?;
        Ok(())
    }
}

impl Deref for OrgTx {
    type Target = PgConnection;
    fn deref(&self) -> &PgConnection {
        &self.tx
    }
}

impl DerefMut for OrgTx {
    fn deref_mut(&mut self) -> &mut PgConnection {
        &mut self.tx
    }
}

/// The identity a pool is connected as, checked at startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleCheck {
    pub current_user: String,
    pub superuser: bool,
    pub bypass_rls: bool,
}

/// Rust must connect as `chartwarden_app`: not a superuser, `NOBYPASSRLS`. Anything else refuses to start,
/// because every tenant guarantee in M02 rests on RLS applying to this connection.
pub async fn check_app_role(pool: &PgPool) -> Result<RoleCheck, TenancyError> {
    let (current_user, superuser, bypass_rls): (String, bool, bool) = sqlx::query_as(
        "SELECT current_user::text, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user",
    )
    .fetch_one(pool)
    .await?;
    Ok(RoleCheck {
        current_user,
        superuser,
        bypass_rls,
    })
}

impl RoleCheck {
    pub const REQUIRED_ROLE: &'static str = "chartwarden_app";

    pub fn is_acceptable(&self) -> bool {
        self.current_user == Self::REQUIRED_ROLE && !self.superuser && !self.bypass_rls
    }
}
