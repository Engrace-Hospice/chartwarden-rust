#!/usr/bin/env bash
# CW-RUST-M02 P2 prerequisite 5 — run AT-M02-05b, 09, 10, 11 and the uid-1000 socket test on a throwaway local
# Bun + Rust stack, then tear it down. Needs only Docker (Desktop) running; everything else happens in containers.
#
#   verification/local-stack/run.sh            # full run, ~15-25 min the first time (Rust image build)
#   KEEP=1 verification/local-stack/run.sh     # leave the stack up afterwards for debugging
#   UPSTREAM_REF=<sha on upstream main> …      # test another upstream commit (default: the M02 P1 merge)
#
# Isolation: compose project `cw-m02-local` (its own containers, networks and volumes, no published ports), so it
# never touches another stack on this machine, including a shared Postgres. The database is disposable by
# construction (fresh container, marked `cw-ephemeral-test-db`); the signing key is generated for this run and
# destroyed with the stack. Evidence lands in verification/output/m02-local/<UTC timestamp>/ (summary: logs.json).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
# The M02 P1 merge on upstream main (Engrace-Hospice/chartwarden#919).
UPSTREAM_REF=${UPSTREAM_REF:-c5972083f189a4e4c12a565ed085072becdbc3e5}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT=${CW_M02_OUT:-$ROOT/verification/output/m02-local/$STAMP}
mkdir -p "$OUT"
export CW_M02_OUT="$OUT" UPSTREAM_REF CW_ACTOR_PUBLIC_KEYS=""

DC=(docker compose -f "$HERE/compose.yml")
status=0
started=$(date +%s)

say() { printf '\n\033[1m== %s\033[0m  (+%ss)\n' "$*" "$(( $(date +%s) - started ))"; }
tools() { "${DC[@]}" run --rm -T tools "$@"; }
phase() { # phase <name> [extra args]; a failed phase is recorded and the run goes on
  local name=$1; shift
  if ! tools bun run verification/src/m02-local-stack.ts "$name" --source /work/upstream --out /out --state /work/state "$@"; then
    echo "!! phase $name FAILED"; status=1
  fi
}
cleanup() {
  "${DC[@]}" logs --no-color --no-log-prefix rust > "$OUT/rust.log" 2>&1 || true
  "${DC[@]}" unpause rust >/dev/null 2>&1 || true
  if [ "${KEEP:-0}" = 1 ]; then
    echo "KEEP=1: stack left running. Remove it with: docker compose -f $HERE/compose.yml down -v"
  else
    "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}

say "Preflight"
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and run this again."; exit 2; }
docker compose version >/dev/null
echo "upstream ref: $UPSTREAM_REF"
echo "evidence:     $OUT"
# A stale run of THIS project only (never anything else) is removed first.
"${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
trap cleanup EXIT

say "Build images (the Rust release build takes a while the first time)"
"${DC[@]}" build rust tools

say "Start PostgreSQL 18 + pgvector (throwaway)"
"${DC[@]}" up -d --wait pg
"${DC[@]}" exec -T pg psql -q -U postgres -d chartwarden_m02local \
  -c "COMMENT ON DATABASE chartwarden_m02local IS 'cw-ephemeral-test-db'"

say "Workspace: copy this repo, fetch upstream at $UPSTREAM_REF (must be on upstream main), install deps"
tools bash -ec '
  rm -rf /work/rust /work/state && mkdir -p /work/rust
  cd /src && tar --exclude=./node_modules --exclude=./rust/target --exclude=./verification/output -cf - . | tar -C /work/rust -xf -
  git clone -q --filter=blob:none --no-checkout https://github.com/Engrace-Hospice/chartwarden.git /work/upstream
  cd /work/upstream
  git checkout -q --detach "$UPSTREAM_REF"
  git merge-base --is-ancestor HEAD origin/main || { echo "refusing: $UPSTREAM_REF is not on upstream main"; exit 1; }
  echo "upstream at $(git rev-parse HEAD)"
  bun install --frozen-lockfile --ignore-scripts >/dev/null
  cd /work/rust && bun install --frozen-lockfile >/dev/null
'

say "Migrate with upstream's own migrator (same flags as its pre-deploy gate)"
tools bash -ec 'cd /work/upstream && DATABASE_URL="$CW_M02_ADMIN_URL" bun run scripts/db/migrate.ts --strict --schema-only | tail -2'

say "Seed the M02 fixtures, the platform stand-in role and a throwaway key"
phase setup
CW_ACTOR_PUBLIC_KEYS=$(tools cat /work/state/public-keys.env | sed -n 's/^CW_ACTOR_PUBLIC_KEYS=//p' | tr -d '\r')
[ -n "$CW_ACTOR_PUBLIC_KEYS" ] || { echo "no public key produced by setup"; exit 1; }
export CW_ACTOR_PUBLIC_KEYS

say "Start Rust (65532:1000, read-only, internal network, tmpfs socket volume)"
"${DC[@]}" up -d --wait rust

say "Socket: uid 1000 connects; a uid outside gid 1000 cannot"
phase socket
if ! "${DC[@]}" run --rm -T --user 1001:1001 -e HOME=/tmp tools \
    bun run verification/src/m02-local-stack.ts socket-deny --out /out --state /tmp/state; then
  echo "!! phase socket-deny FAILED"; status=1
fi

say "AT-M02-05b + AT-M02-11: client-visible responses off/shadow/serve; the parity sweep end to end"
phase e2e

say "AT-M02-09 (fault injection): upstream's client against misbehaving Unix-socket servers"
if ! tools bash -ec 'bun run verification/src/m02-bridge-runtime.ts --source /work/upstream; cp verification/output/m02/bridge-runtime.json /out/'; then
  echo "!! bridge-runtime FAILED"; status=1
fi

say "AT-M02-09: Rust STOPPED -> serve answers from Bun"
"${DC[@]}" stop rust
phase fallback-stopped
"${DC[@]}" up -d --wait rust
phase fallback-recovered

say "AT-M02-10: Rust PAUSED (accepts, never answers) -> 1,000 concurrent requests, shadow mode"
"${DC[@]}" pause rust
phase shadow-stalled
"${DC[@]}" unpause rust

say "Logs: no permission key or assertion anywhere; summary"
"${DC[@]}" logs --no-color --no-log-prefix rust > "$OUT/rust.log" 2>&1 || true
phase logs

say "Done"
echo "Evidence: $OUT  (summary: $OUT/logs.json)"
[ "$status" = 0 ] && echo "RESULT: all phases passed" || echo "RESULT: at least one phase failed (see above)"
exit "$status"
