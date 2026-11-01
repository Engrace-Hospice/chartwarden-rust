//! AT-M02-04 (Rust side): every rejection path, plus the accepted path.

use super::testing::*;
use super::*;
use ed25519_dalek::SigningKey;
use serde_json::{Value, json};

const PATH: &str = "/api/v1/me/permissions";
const NOW: i64 = 1_800_000_000;
const KID: &str = "k1";

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn ids() -> (Uuid, Uuid) {
    (
        Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap_or_default(),
        Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap_or_default(),
    )
}

fn verifier() -> Verifier {
    Verifier::new(KeyRing::from_keys([(
        KID.to_owned(),
        key(1).verifying_key(),
    )]))
}

fn good_claims() -> Value {
    let (u, o) = ids();
    claims(u, o, PATH, NOW)
}

fn with(mut c: Value, field: &str, v: Value) -> Value {
    c[field] = v;
    c
}

fn get() -> Binding<'static> {
    Binding {
        method: "GET",
        path: PATH,
    }
}

fn check(token: &str) -> Result<Actor, Rejection> {
    verifier().verify(Some(token), &get(), NOW)
}

#[test]
fn accepts_a_valid_assertion_and_returns_the_actor() {
    let (u, o) = ids();
    let actor = check(&sign(&good_claims(), KID, &key(1))).expect("valid");
    assert_eq!(actor.user_id, u);
    assert_eq!(actor.organization_id, o);
    assert_eq!(actor.session_class, "staff");
}

#[test]
fn missing_or_empty_is_rejected() {
    assert_eq!(
        verifier().verify(None, &get(), NOW),
        Err(Rejection::Missing)
    );
    assert_eq!(check(""), Err(Rejection::Missing));
}

#[test]
fn oversized_is_rejected_before_decoding() {
    assert_eq!(
        check(&"a".repeat(MAX_ASSERTION_LEN + 1)),
        Err(Rejection::TooLong)
    );
}

#[test]
fn wrong_shape_is_malformed() {
    let t = sign(&good_claims(), KID, &key(1));
    assert_eq!(check("a.b"), Err(Rejection::Malformed));
    assert_eq!(check(&format!("{t}.extra")), Err(Rejection::Malformed));
    assert_eq!(check("!!!.b.c"), Err(Rejection::Malformed));
}

#[test]
fn alg_none_is_rejected() {
    let h = URL_SAFE_NO_PAD.encode(json!({"alg":"none","kid":KID}).to_string());
    let p = URL_SAFE_NO_PAD.encode(good_claims().to_string());
    assert_eq!(
        check(&format!("{h}.{p}.")),
        Err(Rejection::UnsupportedHeader)
    );
}

#[test]
fn alg_hs256_is_rejected_even_with_a_valid_ed25519_signature() {
    let t = sign_raw(&json!({"alg":"HS256","kid":KID}), &good_claims(), &key(1));
    assert_eq!(check(&t), Err(Rejection::UnsupportedHeader));
}

#[test]
fn crit_or_any_unknown_header_field_is_rejected() {
    let t = sign_raw(
        &json!({"alg":"EdDSA","kid":KID,"crit":["exp"]}),
        &good_claims(),
        &key(1),
    );
    assert_eq!(check(&t), Err(Rejection::UnsupportedHeader));
    let t = sign_raw(
        &json!({"alg":"EdDSA","kid":KID,"jku":"https://x"}),
        &good_claims(),
        &key(1),
    );
    assert_eq!(check(&t), Err(Rejection::UnsupportedHeader));
    let t = sign_raw(
        &json!({"alg":"EdDSA","kid":KID,"typ":"at+jwt"}),
        &good_claims(),
        &key(1),
    );
    assert_eq!(check(&t), Err(Rejection::UnsupportedHeader));
}

#[test]
fn unknown_kid_is_rejected() {
    assert_eq!(
        check(&sign(&good_claims(), "other", &key(1))),
        Err(Rejection::UnknownKey)
    );
}

#[test]
fn wrong_key_is_a_bad_signature() {
    assert_eq!(
        check(&sign(&good_claims(), KID, &key(2))),
        Err(Rejection::BadSignature)
    );
}

#[test]
fn tampered_payload_is_a_bad_signature() {
    let t = sign(&good_claims(), KID, &key(1));
    let parts: Vec<&str> = t.split('.').collect();
    let (u, _) = ids();
    let evil = claims(u, Uuid::nil(), PATH, NOW);
    let forged = format!(
        "{}.{}.{}",
        parts[0],
        URL_SAFE_NO_PAD.encode(evil.to_string()),
        parts[2]
    );
    assert_eq!(check(&forged), Err(Rejection::BadSignature));
}

#[test]
fn truncated_signature_is_malformed() {
    let t = sign(&good_claims(), KID, &key(1));
    assert_eq!(check(&t[..t.len() - 4]), Err(Rejection::Malformed));
}

#[test]
fn extra_or_missing_claims_are_rejected() {
    let extra = with(good_claims(), "role", json!("admin"));
    assert_eq!(
        check(&sign(&extra, KID, &key(1))),
        Err(Rejection::BadClaims)
    );
    let mut missing = good_claims();
    missing.as_object_mut().map(|m| m.remove("org"));
    assert_eq!(
        check(&sign(&missing, KID, &key(1))),
        Err(Rejection::BadClaims)
    );
}

#[test]
fn wrong_issuer_or_audience_is_rejected() {
    let c = with(good_claims(), "iss", json!("someone"));
    assert_eq!(check(&sign(&c, KID, &key(1))), Err(Rejection::WrongIssuer));
    let c = with(good_claims(), "aud", json!("cw-bun"));
    assert_eq!(
        check(&sign(&c, KID, &key(1))),
        Err(Rejection::WrongAudience)
    );
}

#[test]
fn method_and_path_must_match_the_request() {
    let t = sign(&good_claims(), KID, &key(1));
    let v = verifier();
    assert_eq!(
        v.verify(
            Some(&t),
            &Binding {
                method: "POST",
                path: PATH
            },
            NOW
        ),
        Err(Rejection::WrongMethod)
    );
    let t = sign(&good_claims(), KID, &key(1));
    assert_eq!(
        v.verify(
            Some(&t),
            &Binding {
                method: "GET",
                path: "/api/v1/me/session"
            },
            NOW
        ),
        Err(Rejection::WrongPath)
    );
    let t = sign(&good_claims(), KID, &key(1));
    assert_eq!(
        v.verify(
            Some(&t),
            &Binding {
                method: "GET",
                path: "/api/v1/me/permissions/"
            },
            NOW
        ),
        Err(Rejection::WrongPath)
    );
}

#[test]
fn identities_must_be_canonical_uuids() {
    for bad in [
        "",
        "not-a-uuid",
        "11111111111141118111111111111111",
        "{11111111-1111-4111-8111-111111111111}",
        "11111111-1111-4111-8111-11111111111A",
        "urn:uuid:11111111-1111-4111-8111-111111111111",
    ] {
        let c = with(good_claims(), "org", json!(bad));
        assert_eq!(
            check(&sign(&c, KID, &key(1))),
            Err(Rejection::BadIdentity),
            "org={bad}"
        );
        let c = with(good_claims(), "sub", json!(bad));
        assert_eq!(
            check(&sign(&c, KID, &key(1))),
            Err(Rejection::BadIdentity),
            "sub={bad}"
        );
    }
    let c = with(good_claims(), "org", json!(1));
    assert_eq!(check(&sign(&c, KID, &key(1))), Err(Rejection::BadClaims));
}

#[test]
fn empty_session_fields_are_rejected() {
    for f in ["sid", "cls", "rid"] {
        let c = with(good_claims(), f, json!(""));
        assert_eq!(
            check(&sign(&c, KID, &key(1))),
            Err(Rejection::BadIdentity),
            "{f}"
        );
    }
}

#[test]
fn jti_must_be_16_bytes() {
    for bad in [
        "",
        "short",
        "AAAAAAAAAAAAAAAAAAAAAAAA",
        "!!!!!!!!!!!!!!!!!!!!!!",
    ] {
        let c = with(good_claims(), "jti", json!(bad));
        assert_eq!(
            check(&sign(&c, KID, &key(1))),
            Err(Rejection::BadNonce),
            "jti={bad}"
        );
    }
}

#[test]
fn lifetime_over_30s_or_non_positive_is_rejected() {
    let c = with(good_claims(), "exp", json!(NOW + 31));
    assert_eq!(check(&sign(&c, KID, &key(1))), Err(Rejection::BadLifetime));
    let c = with(good_claims(), "exp", json!(NOW));
    assert_eq!(check(&sign(&c, KID, &key(1))), Err(Rejection::BadLifetime));
    let c = with(good_claims(), "exp", json!(NOW + 30));
    assert!(check(&sign(&c, KID, &key(1))).is_ok());
}

#[test]
fn expired_beyond_skew_is_rejected() {
    let v = verifier();
    let t = sign(&good_claims(), KID, &key(1));
    assert!(v.verify(Some(&t), &get(), NOW + 30 + SKEW_SECS).is_ok());
    let t = sign(&good_claims(), KID, &key(1));
    assert_eq!(
        v.verify(Some(&t), &get(), NOW + 30 + SKEW_SECS + 1),
        Err(Rejection::Expired)
    );
}

#[test]
fn future_iat_beyond_skew_is_rejected() {
    let v = verifier();
    let t = sign(&good_claims(), KID, &key(1));
    assert!(v.verify(Some(&t), &get(), NOW - SKEW_SECS).is_ok());
    let t = sign(&good_claims(), KID, &key(1));
    assert_eq!(
        v.verify(Some(&t), &get(), NOW - SKEW_SECS - 1),
        Err(Rejection::NotYetValid)
    );
}

#[test]
fn a_replayed_jti_is_rejected() {
    let v = verifier();
    let t = sign(&good_claims(), KID, &key(1));
    assert!(v.verify(Some(&t), &get(), NOW).is_ok());
    assert_eq!(
        v.verify(Some(&t), &get(), NOW + 1),
        Err(Rejection::Replayed)
    );
    // A different token with the same jti is also a replay.
    let jti = good_claims_jti(&t);
    let c = with(
        with(good_claims(), "jti", json!(jti)),
        "rid",
        json!("another"),
    );
    assert_eq!(
        v.verify(Some(&sign(&c, KID, &key(1))), &get(), NOW + 2),
        Err(Rejection::Replayed)
    );
}

fn good_claims_jti(token: &str) -> String {
    let p = token.split('.').nth(1).unwrap_or_default();
    let v: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(p).unwrap_or_default()).unwrap_or_default();
    v["jti"].as_str().unwrap_or_default().to_owned()
}

#[test]
fn a_forged_token_does_not_consume_a_replay_slot() {
    let v = verifier();
    let c = good_claims();
    assert_eq!(
        v.verify(Some(&sign(&c, KID, &key(2))), &get(), NOW),
        Err(Rejection::BadSignature)
    );
    assert!(v.verify(Some(&sign(&c, KID, &key(1))), &get(), NOW).is_ok());
}

#[test]
fn a_full_replay_cache_fails_closed_then_recovers_after_expiry() {
    let v = Verifier::with_replay_capacity(
        KeyRing::from_keys([(KID.to_owned(), key(1).verifying_key())]),
        2,
    );
    for _ in 0..2 {
        assert!(
            v.verify(Some(&sign(&good_claims(), KID, &key(1))), &get(), NOW)
                .is_ok()
        );
    }
    assert_eq!(
        v.verify(Some(&sign(&good_claims(), KID, &key(1))), &get(), NOW),
        Err(Rejection::ReplayCacheFull)
    );
    // Entries are forgotten after exp + skew, and the cache accepts again.
    let (u, o) = ids();
    let later = NOW + 30 + SKEW_SECS + 1;
    assert!(
        v.verify(
            Some(&sign(&claims(u, o, PATH, later), KID, &key(1))),
            &get(),
            later
        )
        .is_ok()
    );
}

#[test]
fn key_rotation_accepts_any_configured_kid() {
    let ring = KeyRing::parse(&format!(
        "old={},new={}",
        public_b64(&key(1)),
        public_b64(&key(3))
    ))
    .expect("ring");
    let v = Verifier::new(ring);
    assert!(
        v.verify(Some(&sign(&good_claims(), "old", &key(1))), &get(), NOW)
            .is_ok()
    );
    assert!(
        v.verify(Some(&sign(&good_claims(), "new", &key(3))), &get(), NOW)
            .is_ok()
    );
    assert_eq!(
        v.verify(Some(&sign(&good_claims(), "new", &key(1))), &get(), NOW),
        Err(Rejection::BadSignature)
    );
}

#[test]
fn key_ring_parsing_rejects_bad_config() {
    assert!(matches!(KeyRing::parse(""), Err(KeyConfigError::Empty)));
    assert!(matches!(
        KeyRing::parse("nokey"),
        Err(KeyConfigError::Shape(0))
    ));
    assert!(matches!(
        KeyRing::parse("k=abc"),
        Err(KeyConfigError::Key(0))
    ));
    assert!(matches!(
        KeyRing::parse("bad kid=AAAA"),
        Err(KeyConfigError::Shape(0))
    ));
    let pk = public_b64(&key(1));
    assert!(matches!(
        KeyRing::parse(&format!("a={pk},a={pk}")),
        Err(KeyConfigError::Duplicate(1))
    ));
    // The all-zero point is small-order: refused.
    let zero = URL_SAFE_NO_PAD.encode([0u8; 32]);
    assert!(matches!(
        KeyRing::parse(&format!("z={zero}")),
        Err(KeyConfigError::Key(0))
    ));
}

#[test]
fn a_session_cookie_alone_is_not_an_assertion() {
    // Rust never reads cookies; a Better Auth cookie value placed in the header is just malformed.
    assert_eq!(
        check("better-auth.session_token=abc.def"),
        Err(Rejection::Malformed)
    );
}

#[test]
fn concurrent_presentations_of_one_token_are_accepted_exactly_once() {
    // Review finding 1: the replay check and the insert happen under one lock, so racing threads cannot both win.
    let v = std::sync::Arc::new(verifier());
    let t = std::sync::Arc::new(sign(&good_claims(), KID, &key(1)));
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
    let handles: Vec<_> = (0..16)
        .map(|_| {
            let (v, t, b) = (v.clone(), t.clone(), barrier.clone());
            std::thread::spawn(move || {
                b.wait();
                v.verify(Some(&t), &get(), NOW)
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|h| h.join().expect("thread"))
        .collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert!(
        results
            .iter()
            .filter(|r| r.is_err())
            .all(|r| *r == Err(Rejection::Replayed))
    );
}

#[test]
fn capacity_boundary_is_exact_and_replays_are_still_caught_when_full() {
    let v = Verifier::with_replay_capacity(
        KeyRing::from_keys([(KID.to_owned(), key(1).verifying_key())]),
        3,
    );
    let tokens: Vec<String> = (0..3).map(|_| sign(&good_claims(), KID, &key(1))).collect();
    for t in &tokens {
        assert!(v.verify(Some(t), &get(), NOW).is_ok());
    }
    // Full: a replay is still reported as a replay (checked before capacity), a new token fails closed.
    assert_eq!(
        v.verify(Some(&tokens[0]), &get(), NOW),
        Err(Rejection::Replayed)
    );
    assert_eq!(
        v.verify(Some(&sign(&good_claims(), KID, &key(1))), &get(), NOW),
        Err(Rejection::ReplayCacheFull)
    );
    // One second before the oldest entries are forgotten: still full.
    let edge = NOW + 30 + SKEW_SECS;
    let (u, o) = ids();
    assert_eq!(
        v.verify(
            Some(&sign(&claims(u, o, PATH, edge - 5), KID, &key(1))),
            &get(),
            edge
        ),
        Err(Rejection::ReplayCacheFull)
    );
    // After they expire, space is reclaimed.
    let later = edge + 1;
    assert!(
        v.verify(
            Some(&sign(&claims(u, o, PATH, later), KID, &key(1))),
            &get(),
            later
        )
        .is_ok()
    );
}
