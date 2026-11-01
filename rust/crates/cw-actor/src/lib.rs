//! Signed actor assertion (CW-RUST-M02 §"Authentication bridge").
//!
//! Bun runs its unchanged authenticate hook, then forwards a Rust-owned route with a short-lived
//! compact JWS in `X-CW-Actor-Assertion`. This crate is the only place Rust decides who the caller
//! is. It never reads a cookie.
//!
//! Verification order matters: length → shape → header (`alg` must be exactly `EdDSA`, unknown
//! header fields such as `crit` rejected) → key by `kid` → **strict** Ed25519 signature check → only
//! then the claims are parsed (unknown claims rejected) → issuer/audience → method/path binding →
//! identity format → time window → single-use `jti`. Nothing derived from an unauthenticated payload
//! is acted on, and a forged token can never consume a replay-cache slot.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use uuid::Uuid;

/// Header Bun sends the assertion in (HTTP header names are case-insensitive).
pub const HEADER_NAME: &str = "x-cw-actor-assertion";
/// Longest accepted `exp - iat`.
pub const MAX_LIFETIME_SECS: i64 = 30;
/// Clock skew tolerated on both ends of the window.
pub const SKEW_SECS: i64 = 5;
/// Anything longer is rejected before decoding.
pub const MAX_ASSERTION_LEN: usize = 4096;
/// Default bound on remembered `jti` values (a full cache fails closed).
pub const DEFAULT_REPLAY_CAPACITY: usize = 100_000;

pub const EXPECTED_ISSUER: &str = "cw-bun";

/// Session class Bun puts on assertions minted by the daily parity sweep (spec v0.3 §"Daily parity sweep").
pub const SWEEP_CLASS: &str = "parity-sweep";
/// The only requests a sweep assertion may authenticate. Minting assertions outside a user request is a new
/// capability; this fence keeps it on one read-only route even when Rust gains more routes.
pub const SWEEP_ALLOWED: &[(&str, &str)] = &[("GET", "/api/v1/me/permissions")];
pub const EXPECTED_AUDIENCE: &str = "cw-rust";

/// Why an assertion was refused. `as_str()` is the only form that is logged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Rejection {
    #[error("assertion missing")]
    Missing,
    #[error("assertion too long")]
    TooLong,
    #[error("assertion malformed")]
    Malformed,
    #[error("unsupported algorithm or header")]
    UnsupportedHeader,
    #[error("unknown key id")]
    UnknownKey,
    #[error("bad signature")]
    BadSignature,
    #[error("unexpected claims")]
    BadClaims,
    #[error("wrong issuer")]
    WrongIssuer,
    #[error("wrong audience")]
    WrongAudience,
    #[error("method mismatch")]
    WrongMethod,
    #[error("path mismatch")]
    WrongPath,
    #[error("invalid identity")]
    BadIdentity,
    #[error("invalid nonce")]
    BadNonce,
    #[error("not yet valid")]
    NotYetValid,
    #[error("expired")]
    Expired,
    #[error("lifetime too long")]
    BadLifetime,
    #[error("replayed")]
    Replayed,
    #[error("replay cache full")]
    ReplayCacheFull,
    #[error("sweep assertion outside its route")]
    SweepNotAllowed,
}

impl Rejection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::TooLong => "too_long",
            Self::Malformed => "malformed",
            Self::UnsupportedHeader => "unsupported_header",
            Self::UnknownKey => "unknown_key",
            Self::BadSignature => "bad_signature",
            Self::BadClaims => "bad_claims",
            Self::WrongIssuer => "wrong_issuer",
            Self::WrongAudience => "wrong_audience",
            Self::WrongMethod => "wrong_method",
            Self::WrongPath => "wrong_path",
            Self::BadIdentity => "bad_identity",
            Self::BadNonce => "bad_nonce",
            Self::NotYetValid => "not_yet_valid",
            Self::Expired => "expired",
            Self::BadLifetime => "bad_lifetime",
            Self::Replayed => "replayed",
            Self::ReplayCacheFull => "replay_cache_full",
            Self::SweepNotAllowed => "sweep_not_allowed",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum KeyConfigError {
    #[error("no public keys configured")]
    Empty,
    #[error("key entry {0} is not `kid=base64url`")]
    Shape(usize),
    #[error("key entry {0} is not a valid Ed25519 public key")]
    Key(usize),
    #[error("duplicate kid in entry {0}")]
    Duplicate(usize),
}

/// Public keys Rust accepts, by `kid`. Several entries allow rotation.
#[derive(Clone)]
pub struct KeyRing {
    keys: HashMap<String, VerifyingKey>,
}

impl KeyRing {
    /// Parses `kid1=<base64url 32-byte key>,kid2=<...>` (the `CW_ACTOR_PUBLIC_KEYS` format).
    pub fn parse(spec: &str) -> Result<Self, KeyConfigError> {
        let mut keys = HashMap::new();
        for (i, entry) in spec
            .split(',')
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .enumerate()
        {
            let (kid, b64) = entry.split_once('=').ok_or(KeyConfigError::Shape(i))?;
            if kid.is_empty()
                || !kid
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err(KeyConfigError::Shape(i));
            }
            let raw = URL_SAFE_NO_PAD
                .decode(b64)
                .map_err(|_| KeyConfigError::Key(i))?;
            let bytes: [u8; 32] = raw.try_into().map_err(|_| KeyConfigError::Key(i))?;
            // `from_bytes` rejects non-canonical and small-order encodings.
            let key = VerifyingKey::from_bytes(&bytes).map_err(|_| KeyConfigError::Key(i))?;
            if key.is_weak() {
                return Err(KeyConfigError::Key(i));
            }
            if keys.insert(kid.to_owned(), key).is_some() {
                return Err(KeyConfigError::Duplicate(i));
            }
        }
        if keys.is_empty() {
            return Err(KeyConfigError::Empty);
        }
        Ok(Self { keys })
    }

    pub fn from_keys(entries: impl IntoIterator<Item = (String, VerifyingKey)>) -> Self {
        Self {
            keys: entries.into_iter().collect(),
        }
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    alg: String,
    kid: String,
    #[serde(default)]
    typ: Option<String>,
}

/// The claim set. Unknown claims are rejected: the assertion must not carry more than the spec lists.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub org: String,
    pub sid: String,
    pub cls: String,
    pub mth: String,
    pub pth: String,
    pub rid: String,
    pub jti: String,
    pub iat: i64,
    pub exp: i64,
}

/// The verified caller. Constructed only by [`Verifier::verify`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    pub user_id: Uuid,
    pub organization_id: Uuid,
    pub session_id: String,
    pub session_class: String,
    pub request_id: String,
}

/// What the assertion must be bound to: the request Rust actually received.
pub struct Binding<'a> {
    pub method: &'a str,
    pub path: &'a str,
}

struct ReplayCache {
    seen: HashMap<[u8; 16], i64>,
    capacity: usize,
    inserts: u64,
}

impl ReplayCache {
    fn prune(&mut self, now: i64) {
        self.seen.retain(|_, forget_after| *forget_after >= now);
    }

    fn check_and_insert(
        &mut self,
        jti: [u8; 16],
        forget_after: i64,
        now: i64,
    ) -> Result<(), Rejection> {
        if self.seen.get(&jti).is_some_and(|prev| *prev >= now) {
            return Err(Rejection::Replayed);
        }
        self.inserts += 1;
        if self.seen.len() >= self.capacity || self.inserts.is_multiple_of(1024) {
            self.prune(now);
        }
        if self.seen.len() >= self.capacity {
            return Err(Rejection::ReplayCacheFull);
        }
        self.seen.insert(jti, forget_after);
        Ok(())
    }
}

pub struct Verifier {
    keys: KeyRing,
    replay: Mutex<ReplayCache>,
}

impl Verifier {
    pub fn new(keys: KeyRing) -> Self {
        Self::with_replay_capacity(keys, DEFAULT_REPLAY_CAPACITY)
    }

    pub fn with_replay_capacity(keys: KeyRing, capacity: usize) -> Self {
        Self {
            keys,
            replay: Mutex::new(ReplayCache {
                seen: HashMap::new(),
                capacity,
                inserts: 0,
            }),
        }
    }

    /// Verifies `token` for the request described by `binding` at `now` (Unix seconds).
    pub fn verify(
        &self,
        token: Option<&str>,
        binding: &Binding<'_>,
        now: i64,
    ) -> Result<Actor, Rejection> {
        let token = token.ok_or(Rejection::Missing)?;
        if token.is_empty() {
            return Err(Rejection::Missing);
        }
        if token.len() > MAX_ASSERTION_LEN {
            return Err(Rejection::TooLong);
        }
        let mut parts = token.split('.');
        let (Some(h64), Some(p64), Some(s64), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(Rejection::Malformed);
        };

        let header_raw = URL_SAFE_NO_PAD
            .decode(h64)
            .map_err(|_| Rejection::Malformed)?;
        let header: Header =
            serde_json::from_slice(&header_raw).map_err(|_| Rejection::UnsupportedHeader)?;
        if header.alg != "EdDSA" || header.typ.as_deref().is_some_and(|t| t != "JWT") {
            return Err(Rejection::UnsupportedHeader);
        }
        let key = self
            .keys
            .keys
            .get(&header.kid)
            .ok_or(Rejection::UnknownKey)?;

        let sig_raw = URL_SAFE_NO_PAD
            .decode(s64)
            .map_err(|_| Rejection::Malformed)?;
        let sig_bytes: [u8; 64] = sig_raw.try_into().map_err(|_| Rejection::Malformed)?;
        let signature = Signature::from_bytes(&sig_bytes);
        let signing_input = &token[..h64.len() + 1 + p64.len()];
        key.verify_strict(signing_input.as_bytes(), &signature)
            .map_err(|_| Rejection::BadSignature)?;

        let payload_raw = URL_SAFE_NO_PAD
            .decode(p64)
            .map_err(|_| Rejection::Malformed)?;
        let claims: Claims =
            serde_json::from_slice(&payload_raw).map_err(|_| Rejection::BadClaims)?;

        if claims.iss != EXPECTED_ISSUER {
            return Err(Rejection::WrongIssuer);
        }
        if claims.aud != EXPECTED_AUDIENCE {
            return Err(Rejection::WrongAudience);
        }
        if claims.mth != binding.method {
            return Err(Rejection::WrongMethod);
        }
        if claims.pth != binding.path {
            return Err(Rejection::WrongPath);
        }
        let user_id = canonical_uuid(&claims.sub).ok_or(Rejection::BadIdentity)?;
        let organization_id = canonical_uuid(&claims.org).ok_or(Rejection::BadIdentity)?;
        if claims.cls == SWEEP_CLASS
            && !SWEEP_ALLOWED
                .iter()
                .any(|(m, p)| *m == binding.method && *p == binding.path)
        {
            return Err(Rejection::SweepNotAllowed);
        }
        if claims.sid.is_empty() || claims.cls.is_empty() || claims.rid.is_empty() {
            return Err(Rejection::BadIdentity);
        }
        let jti = decode_jti(&claims.jti).ok_or(Rejection::BadNonce)?;

        if claims.exp <= claims.iat || claims.exp - claims.iat > MAX_LIFETIME_SECS {
            return Err(Rejection::BadLifetime);
        }
        if claims.iat > now + SKEW_SECS {
            return Err(Rejection::NotYetValid);
        }
        if now > claims.exp + SKEW_SECS {
            return Err(Rejection::Expired);
        }

        self.replay
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .check_and_insert(jti, claims.exp + SKEW_SECS, now)?;

        Ok(Actor {
            user_id,
            organization_id,
            session_id: claims.sid,
            session_class: claims.cls,
            request_id: claims.rid,
        })
    }
}

/// Accepts only the canonical lowercase hyphenated form (what PostgreSQL's `uuid` output produces).
fn canonical_uuid(s: &str) -> Option<Uuid> {
    let u = Uuid::try_parse(s).ok()?;
    (u.hyphenated().to_string() == s).then_some(u)
}

/// A `jti` is exactly 16 random bytes, base64url without padding (22 characters).
fn decode_jti(s: &str) -> Option<[u8; 16]> {
    if s.len() != 22 {
        return None;
    }
    URL_SAFE_NO_PAD.decode(s).ok()?.try_into().ok()
}

/// Test helpers: signing is Bun's job in production, so this is compiled only for tests.
#[cfg(any(test, feature = "testing"))]
pub mod testing {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    pub fn encode_header(alg: &str, kid: &str) -> String {
        URL_SAFE_NO_PAD
            .encode(serde_json::json!({ "alg": alg, "kid": kid, "typ": "JWT" }).to_string())
    }

    pub fn sign_raw(
        header_json: &serde_json::Value,
        claims_json: &serde_json::Value,
        key: &SigningKey,
    ) -> String {
        let h = URL_SAFE_NO_PAD.encode(header_json.to_string());
        let p = URL_SAFE_NO_PAD.encode(claims_json.to_string());
        let input = format!("{h}.{p}");
        let sig = key.sign(input.as_bytes());
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }

    pub fn sign(claims_json: &serde_json::Value, kid: &str, key: &SigningKey) -> String {
        sign_raw(
            &serde_json::json!({ "alg": "EdDSA", "kid": kid, "typ": "JWT" }),
            claims_json,
            key,
        )
    }

    /// A unique (not cryptographically random) 16-byte nonce; production `jti`s come from Bun's CSPRNG.
    pub fn random_jti() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let mut b = [0u8; 16];
        b[..8].copy_from_slice(&t.to_le_bytes());
        b[8..].copy_from_slice(&n.to_le_bytes());
        URL_SAFE_NO_PAD.encode(b)
    }

    /// A valid claim set for `GET path` issued at `now`.
    pub fn claims(user: Uuid, org: Uuid, path: &str, now: i64) -> serde_json::Value {
        serde_json::json!({
            "iss": EXPECTED_ISSUER, "aud": EXPECTED_AUDIENCE,
            "sub": user.to_string(), "org": org.to_string(),
            "sid": "test-session", "cls": "staff",
            "mth": "GET", "pth": path, "rid": "req-test",
            "jti": random_jti(), "iat": now, "exp": now + 30,
        })
    }

    pub fn public_b64(key: &SigningKey) -> String {
        URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes())
    }
}

#[cfg(test)]
mod tests;
