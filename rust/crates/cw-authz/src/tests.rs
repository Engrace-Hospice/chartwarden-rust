//! AT-M02-01. Test names mirror upstream `packages/auth/__tests__/rbac-resolve.test.ts` and
//! `platform-reserved-roles.test.ts` where a case exists there.

use super::*;
use chrono::TimeZone;

fn at_ms(ms: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms).single().unwrap_or_default()
}

fn grant(
    role_key: &str,
    enabled: bool,
    expires_at: Option<DateTime<Utc>>,
    keys: &[&str],
) -> RoleGrant {
    RoleGrant {
        role_key: role_key.into(),
        enabled,
        expires_at,
        permission_keys: keys.iter().map(|k| (*k).to_owned()).collect(),
    }
}

fn org_a() -> Option<Uuid> {
    Some(Uuid::from_u128(0xa))
}

// ---- rbac-resolve.test.ts: "resolveEffectivePermissions (the §2.2 fold)" ----

#[test]
fn unions_the_permission_keys_of_every_active_grant() {
    let p = resolve_effective_permissions(
        &[
            grant("seed", true, None, &["patient.read", "encounter.read"]),
            grant(
                "scheduler",
                true,
                None,
                &["schedule.manage", "patient.read"],
            ),
        ],
        at_ms(0),
    );
    assert_eq!(
        p.into_iter().collect::<Vec<_>>(),
        ["encounter.read", "patient.read", "schedule.manage"]
    );
}

#[test]
fn a_disabled_role_contributes_nothing() {
    let p =
        resolve_effective_permissions(&[grant("seed", false, None, &["role.manage"])], at_ms(0));
    assert!(p.is_empty());
}

// ---- rbac-resolve.test.ts: "§7.2 — on-call elevation is time-bound" ----

#[test]
fn grants_during_the_window_and_denies_one_minute_after_it_closes() {
    let shift_end = 60 * 60 * 1000;
    let oncall = [grant(
        "triage_oncall",
        true,
        Some(at_ms(shift_end)),
        &["patient.read"],
    )];
    assert!(
        resolve_effective_permissions(&oncall, at_ms(shift_end - 60_000)).contains("patient.read")
    );
    assert!(
        !resolve_effective_permissions(&oncall, at_ms(shift_end + 60_000)).contains("patient.read")
    );
}

// ---- M02 edge cases (upstream has no direct test; behaviour follows resolve.ts) ----

#[test]
fn expiry_exactly_at_now_is_excluded_and_one_ms_before_expiry_is_included() {
    let g = [grant("x", true, Some(at_ms(10_000)), &["k"])];
    assert!(
        resolve_effective_permissions(&g, at_ms(10_000)).is_empty(),
        "expires_at <= now drops"
    );
    assert!(resolve_effective_permissions(&g, at_ms(9_999)).contains("k"));
}

#[test]
fn expiry_compares_at_millisecond_precision_like_a_js_date() {
    // expires_at = 10.000900 s, now = 10.000100 s: same millisecond, so upstream's Date math excludes it.
    let exp = Utc.timestamp_opt(10, 900_000).single().unwrap_or_default();
    let now = Utc.timestamp_opt(10, 100_000).single().unwrap_or_default();
    assert!(resolve_effective_permissions(&[grant("x", true, Some(exp), &["k"])], now).is_empty());
}

#[test]
fn a_disabled_role_with_a_future_expiry_still_contributes_nothing() {
    let p =
        resolve_effective_permissions(&[grant("x", false, Some(at_ms(99_999)), &["k"])], at_ms(0));
    assert!(p.is_empty());
}

#[test]
fn duplicate_keys_across_grants_appear_once() {
    let p = resolve_effective_permissions(
        &[
            grant("a", true, None, &["k", "k"]),
            grant("b", true, None, &["k"]),
        ],
        at_ms(0),
    );
    assert_eq!(p.len(), 1);
}

#[test]
fn no_grants_means_no_permissions() {
    assert!(resolve_effective_permissions(&[], at_ms(0)).is_empty());
}

// ---- platform-reserved-roles.test.ts ----

#[test]
fn the_generated_reserved_role_data_parses() {
    let r = RESERVED
        .as_ref()
        .expect("reserved_platform_roles.json must parse");
    assert_eq!(r.reserved_prefix, "platform_");
    assert_eq!(r.reserved_category, "platform_staff");
    assert!(!r.platform_ops_role_keys.is_empty());
}

#[test]
fn reserves_every_platform_ops_key_and_every_platform_key_used_by_a_predicate() {
    let r = RESERVED.as_ref().expect("parses");
    for key in r
        .platform_ops_role_keys
        .iter()
        .map(String::as_str)
        .chain(["platform_security_owner"])
    {
        assert!(is_reserved_platform_role_key(key), "{key}");
    }
}

#[test]
fn does_not_reserve_ordinary_tenant_keys() {
    for key in ["org_admin", "rn", "weekend_float_rn", "platformer"] {
        assert!(!is_reserved_platform_role_key(key), "{key}");
    }
}

#[test]
fn a_tenant_role_is_reserved_when_its_key_is_platform_or_its_category_is_platform_staff() {
    assert!(is_tenant_role_reserved("platform_admin", "operations"));
    assert!(is_tenant_role_reserved("helpdesk", "platform_staff"));
    assert!(!is_tenant_role_reserved("helpdesk", "operations"));
}

#[test]
fn a_tenant_owned_row_never_confers_a_reserved_key_a_platform_owned_row_does() {
    assert!(!role_confers_key(org_a(), "platform_admin", "operations"));
    assert!(role_confers_key(None, "platform_admin", "platform_staff"));
    assert!(role_confers_key(org_a(), "rn", "clinical_staff"));
}

#[test]
fn reserves_ai_safety_owner_by_exact_key_not_as_a_prefix() {
    assert!(is_reserved_platform_role_key("ai_safety_owner"));
    assert!(!is_reserved_platform_role_key("ai_safety_owner_deputy"));
    assert!(!is_reserved_platform_role_key("clinical_safety_lead"));
}

#[test]
fn a_tenant_owned_ai_safety_owner_row_confers_nothing() {
    assert!(is_tenant_role_reserved("ai_safety_owner", "clinical_staff"));
    assert!(!role_confers_key(org_a(), "ai_safety_owner", "operations"));
}

#[test]
fn a_tenant_owned_platform_staff_category_row_confers_nothing() {
    assert!(!role_confers_key(org_a(), "helpdesk", "platform_staff"));
}
