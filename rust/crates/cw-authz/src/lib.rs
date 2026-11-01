//! Effective-permission resolution for `GET /api/v1/me/permissions` (CW-RUST-M02).
//!
//! A line-for-line port of upstream `@chartwarden/auth`:
//! - `roleConfersKey` / `isTenantRoleReserved` / `isReservedPlatformRoleKey`
//!   (`packages/auth/src/roles/platform-reserved.ts`), with the data in `reserved_platform_roles.json`,
//!   generated from upstream and checked by `verify:m02-reserved`;
//! - `loadGrants` (`packages/auth/src/rbac/drizzle-store.ts`): the same two queries, same predicates;
//! - `resolveEffectivePermissions` (`packages/auth/src/rbac/resolve.ts`): the fold.
//!
//! Not ported, on purpose: the 5-minute cache (M02 has none) and the session-class wrapper (upstream's
//! `/me/permissions` route does not apply it either).

use std::collections::{BTreeSet, HashMap};
use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use serde::Deserialize;
use sqlx::PgConnection;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct ReservedRoles {
    #[serde(rename = "reservedPrefix")]
    pub reserved_prefix: String,
    #[serde(rename = "reservedKeys")]
    pub reserved_keys: Vec<String>,
    #[serde(rename = "reservedCategory")]
    pub reserved_category: String,
    #[serde(rename = "platformOpsRoleKeys")]
    pub platform_ops_role_keys: Vec<String>,
}

const RESERVED_JSON: &str = include_str!("../reserved_platform_roles.json");

/// Parsed once. The JSON is compiled into the binary; a malformed file is caught by the unit tests,
/// and at runtime an unparseable file reserves *everything* (fail closed: tenant roles confer nothing).
pub static RESERVED: LazyLock<Option<ReservedRoles>> =
    LazyLock::new(|| serde_json::from_str(RESERVED_JSON).ok());

/// `isReservedPlatformRoleKey`: `platform_*`, or an exact reserved key (not a prefix).
pub fn is_reserved_platform_role_key(key: &str) -> bool {
    match RESERVED.as_ref() {
        Some(r) => key.starts_with(&r.reserved_prefix) || r.reserved_keys.iter().any(|k| k == key),
        None => true,
    }
}

/// `isTenantRoleReserved`: the key is reserved, or the category is `platform_staff`.
pub fn is_tenant_role_reserved(key: &str, category: &str) -> bool {
    is_reserved_platform_role_key(key)
        || match RESERVED.as_ref() {
            Some(r) => category == r.reserved_category,
            None => true,
        }
}

/// `roleConfersKey`: a platform-owned role (organization NULL) always confers; a tenant-owned role
/// confers only when it is not reserved (GAP-003 / GAP-096).
pub fn role_confers_key(organization_id: Option<Uuid>, key: &str, category: &str) -> bool {
    organization_id.is_none() || !is_tenant_role_reserved(key, category)
}

/// One `membership_role` grant, as the fold needs it (upstream `RoleGrant`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleGrant {
    pub role_key: String,
    pub enabled: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub permission_keys: Vec<String>,
}

/// Upstream reads `expires_at` through node-postgres as a JS `Date`, which keeps **milliseconds**. Comparing at
/// microsecond precision would let a grant expiring within the same millisecond as `now` differ from Bun.
fn epoch_ms(t: DateTime<Utc>) -> i64 {
    t.timestamp_millis()
}

/// `resolveEffectivePermissions`: drop disabled roles and grants with `expires_at <= now` (ms precision);
/// union the rest. Returns keys sorted (upstream order is DB row order, not stable; parity compares sets).
pub fn resolve_effective_permissions(grants: &[RoleGrant], now: DateTime<Utc>) -> BTreeSet<String> {
    let now_ms = epoch_ms(now);
    let mut out = BTreeSet::new();
    for g in grants {
        if !g.enabled {
            continue;
        }
        // A time-bound grant whose window has closed (§7.2) contributes nothing.
        if g.expires_at.is_some_and(|exp| epoch_ms(exp) <= now_ms) {
            continue;
        }
        out.extend(g.permission_keys.iter().cloned());
    }
    out
}

#[derive(sqlx::FromRow)]
struct GrantRow {
    role_id: Uuid,
    role_key: String,
    role_organization_id: Option<Uuid>,
    role_category: String,
    enabled: bool,
    expires_at: Option<DateTime<Utc>>,
}

#[derive(sqlx::FromRow)]
struct PermRow {
    role_id: Uuid,
    permission_key: String,
}

/// `loadGrants(orgId, userId)`. Must run on a connection inside an org-scoped transaction
/// (`cw_tenancy::OrgTx`), so RLS scopes every row to `app.org_id` beneath the explicit predicates.
pub async fn load_grants(
    conn: &mut PgConnection,
    org: Uuid,
    user: Uuid,
) -> Result<Vec<RoleGrant>, sqlx::Error> {
    let raw: Vec<GrantRow> = sqlx::query_as(
        "SELECT r.id AS role_id, r.key AS role_key, r.organization_id AS role_organization_id, \
                r.category::text AS role_category, r.enabled, mr.expires_at \
           FROM membership m \
           JOIN membership_role mr ON mr.membership_id = m.id \
           JOIN role r ON r.id = mr.role_id \
          WHERE m.user_id = $1 AND m.organization_id = $2 AND m.status = 'active'",
    )
    .bind(user)
    .bind(org)
    .fetch_all(&mut *conn)
    .await?;

    let grants: Vec<GrantRow> = raw
        .into_iter()
        .filter(|g| role_confers_key(g.role_organization_id, &g.role_key, &g.role_category))
        .collect();
    if grants.is_empty() {
        return Ok(Vec::new());
    }

    let mut role_ids: Vec<Uuid> = grants.iter().map(|g| g.role_id).collect();
    role_ids.sort_unstable();
    role_ids.dedup();
    let perms: Vec<PermRow> = sqlx::query_as(
        "SELECT role_id, permission_key FROM role_permission WHERE role_id = ANY($1)",
    )
    .bind(&role_ids)
    .fetch_all(&mut *conn)
    .await?;
    let mut by_role: HashMap<Uuid, Vec<String>> = HashMap::new();
    for p in perms {
        by_role.entry(p.role_id).or_default().push(p.permission_key);
    }

    Ok(grants
        .into_iter()
        .map(|g| RoleGrant {
            permission_keys: by_role.get(&g.role_id).cloned().unwrap_or_default(),
            role_key: g.role_key,
            enabled: g.enabled,
            expires_at: g.expires_at,
        })
        .collect())
}

#[cfg(test)]
mod tests;
