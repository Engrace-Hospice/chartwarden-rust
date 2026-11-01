#!/usr/bin/env bash
# CW-RUST-M02 P0 — run every check on your own machine, against a throwaway PostgreSQL in Docker.
#
#   ./scripts/m02-local-check.sh
#
# What it does:
#   1. checks prerequisites (git, docker, rustup/cargo, bun);
#   2. clones upstream chartwarden at the SHA pinned in verification/config.json into a temp folder, proves the SHA is
#      on upstream main, installs its dependencies without lifecycle scripts;
#   3. starts a throwaway pgvector/pgvector:pg18 container (upstream's pinned digest) on 127.0.0.1:${PG_PORT:-55432}:
#      a dedicated cluster, marked disposable;
#   4. migrates it with upstream's migrator and checks the catalog (M00);
#   5. runs: reserved-role sync, supply-chain gate, all Rust unit + live tests, parity with upstream's resolver;
#   6. writes verification/output/m02/local-report.txt and removes the container and temp folder, pass or fail.
#
# It never touches any other database: the only one it connects to is the container it started.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PG_PORT="${PG_PORT:-55432}"
PG_IMAGE="pgvector/pgvector:pg18@sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11"
NAME="cw-m02-check-$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cw-m02.XXXXXX")"
OUT="$ROOT/verification/output/m02"
mkdir -p "$OUT"
LOG="$OUT/local-check.log"
REPORT="$OUT/local-report.txt"
: > "$LOG"
ADMIN_URL="postgres://postgres:postgres@127.0.0.1:${PG_PORT}/chartwarden_catalog"
RESULTS=()

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1" | tee -a "$LOG"; }
record() { RESULTS+=("$1"); }
run() { # run "<label>" cmd...  (output to terminal and log; failure stops the script after recording)
  local label="$1"; shift
  step "$label"
  if "$@" 2>&1 | tee -a "$LOG"; then record "PASS  $label"; else record "FAIL  $label"; finish 1; fi
}
finish() {
  {
    echo "CW-RUST-M02 P0 local check — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "machine: $(uname -sm); branch: $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)$( [ -n "$(git status --porcelain)" ] && echo ' (DIRTY)')"
    echo "upstream: $(jq -r .upstream.ref verification/config.json 2>/dev/null || echo '?')"
    echo "tools: $(rustc --version 2>/dev/null) | bun $(bun --version 2>/dev/null) | docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
    echo
    printf '%s\n' "${RESULTS[@]}"
    [ -f "$OUT/parity.json" ] && echo && grep -E '"(actors|diffs)"' "$OUT/parity.json" | tr -d ' ,'
  } | tee "$REPORT"
  echo; echo "Full log: $LOG"; echo "Report:   $REPORT"
  exit "$1"
}

step "Prerequisites"
missing=()
for t in git docker cargo rustup bun jq; do command -v "$t" >/dev/null || missing+=("$t"); done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing: ${missing[*]}"
  echo "Install: Docker Desktop · rustup (https://rustup.rs) · bun (https://bun.sh) · jq (brew install jq)"
  exit 1
fi
docker info >/dev/null 2>&1 || { echo "Docker is installed but not running. Start Docker Desktop and retry."; exit 1; }
if lsof -nP -iTCP:"$PG_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PG_PORT is in use. Re-run with another: PG_PORT=55433 ./scripts/m02-local-check.sh"; exit 1
fi
record "PASS  Prerequisites"

run "Install this repo's dependencies" bun install --frozen-lockfile

SHA="$(jq -r .upstream.ref verification/config.json)"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "verification/config.json upstream.ref is not a full SHA"; exit 1; }
# NB: `set -e` does not apply inside functions called from `if` (as `run` does), so every step returns explicitly.
fetch_upstream() {
  local u="$WORK/upstream"
  git init -q "$u" || return 1
  git -C "$u" remote add origin https://github.com/Engrace-Hospice/chartwarden.git || return 1
  git -C "$u" fetch -q --depth 1 origin "$SHA" || return 1
  git -C "$u" checkout -q FETCH_HEAD || return 1
  [ "$(git -C "$u" rev-parse HEAD)" = "$SHA" ] || { echo "checked-out commit is not the pinned SHA"; return 1; }
  git -C "$u" fetch -q --filter=blob:none --no-tags origin main || return 1
  git -C "$u" merge-base --is-ancestor "$SHA" FETCH_HEAD || { echo "pinned SHA is not on upstream main; refusing"; return 1; }
  (cd "$u" && bun install --ignore-scripts --frozen-lockfile)
}
run "Upstream at pinned ${SHA:0:7} (proved on main), deps without scripts" fetch_upstream
UP="$WORK/upstream"

rust_toolchain() { (cd rust && rustup toolchain install && rustc --version); }
run "Rust toolchain from rust/rust-toolchain.toml" rust_toolchain

supply_tools() {
  command -v cargo-deny >/dev/null || cargo install --locked cargo-deny@0.20.2 || return 1
  command -v cargo-audit >/dev/null || cargo install --locked cargo-audit@0.22.2 || return 1
  cargo deny --version && cargo audit --version
}
run "cargo-deny / cargo-audit (installs once, a few minutes)" supply_tools

start_pg() {
  docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=chartwarden_catalog \
    -p "127.0.0.1:${PG_PORT}:5432" "$PG_IMAGE" -c max_locks_per_transaction=4096 >/dev/null || return 1
  for _ in $(seq 1 60); do
    docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres -d chartwarden_catalog >/dev/null 2>&1 && return 0
    sleep 1
  done
  docker logs "$NAME"; return 1
}
run "Throwaway PostgreSQL 18 + pgvector on 127.0.0.1:${PG_PORT}" start_pg

run "Migrate with upstream's migrator and check the catalog" \
  bun run verify:catalog --source "$UP" --database-url "$ADMIN_URL" --migrate

run "Mark the database disposable" \
  docker exec "$NAME" psql -q -U postgres -d chartwarden_catalog -c "COMMENT ON DATABASE chartwarden_catalog IS 'cw-ephemeral-test-db'"

run "Reserved-role data matches upstream" bun run verify:m02-reserved --source "$UP"

run "Supply-chain gate (pin, build, fmt, clippy, cargo deny, cargo audit)" rust/scripts/supply-chain.sh

rust_tests() { (cd rust && CW_TEST_ADMIN_DATABASE_URL="$ADMIN_URL" cargo test --locked --workspace --all-features); }
run "Rust unit + live tests (as chartwarden_app)" rust_tests

parity() {
  cargo build --locked --manifest-path rust/Cargo.toml -p cw-server || return 1
  bun run verify:m02-parity --source "$UP" --admin-url "$ADMIN_URL" --rust-bin rust/target/debug/cw-server
}
run "Parity with upstream's resolver" parity

finish 0
