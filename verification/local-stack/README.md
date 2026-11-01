# M02 local stack (P2 prerequisite 5)

Runs AT-M02-05b, 09, 10, 11 and the uid-1000 socket test on a throwaway Bun + Rust stack on your machine, then
removes it. You need Docker Desktop running and a few GB of free disk, and read access to the (private) upstream
repo: be logged in with `gh auth login`, or set `GH_TOKEN`. The token is handed only to the step that fetches upstream
(through git's environment config, never written to disk); the install and test steps run without it. The script
checks access up front, so a missing credential fails in seconds rather than after the Rust build.

```sh
verification/local-stack/run.sh          # or: bun run verify:m02-local-stack
```

The first run takes 15–25 minutes, most of it the Rust release build. Evidence goes to
`verification/output/m02-local/<UTC timestamp>/`: one JSON and one log file per phase, `rust.log`, and the summary
in `logs.json`. Exit code 0 means every phase passed.

## What it builds

Compose project `cw-m02-local` (`compose.yml`). It has no published ports and its own networks and volumes, so it
can't touch any other stack on the machine, including a shared Postgres.

| Service | What |
| --- | --- |
| `pg` | `pgvector/pgvector:pg18`, same digest as upstream production. Fresh, marked `cw-ephemeral-test-db`. |
| `rust` | Built from `rust/Dockerfile` (pinned bases). Runs as `65532:1000`, read-only, on the internal `rust-db` network only. The socket lives in a tmpfs volume (`uid=65532,gid=1000,mode=0750`). |
| `tools` | Bun 1.4.4 as uid 1000. It plays upstream's `api`: upstream code at `UPSTREAM_REF` (default: the M02 P1 merge `c597208`; it must be on upstream main), installed with `--ignore-scripts`. |

## Phases (`verification/src/m02-local-stack.ts`)

| Phase | Test |
| --- | --- |
| `setup` | Upstream migrations applied, M02 fixtures seeded, a `BYPASSRLS` stand-in for `chartwarden_platform_login`, a throwaway Ed25519 key |
| `socket` / `socket-deny` | uid 1000 reaches `/health` over the socket; uid 1001 gets `EACCES` |
| `e2e` | **AT-M02-05b**: status, headers and body are identical off/shadow/serve for every fixture actor and both 401 paths. Volatile headers and body fields are calibrated from two baseline requests. Shadow matches 100 %; serve is answered by Rust 100 %. **AT-M02-11**: off by default; a clean sweep compares every active membership, counts reconcile, ≤ 2 in flight. A planted Rust defect is reported `unexplained` with ids and counts only. A real grant change committed between Bun's and Rust's reads is reported `explained:race`. Rust refuses a sweep assertion bound elsewhere and serves nothing on other paths. |
| `bridge-runtime` | **AT-M02-09** fault injection: upstream's client against five misbehaving socket servers |
| `fallback-stopped` / `fallback-recovered` | **AT-M02-09**: `rust` stopped means every answer is Bun's, `fallback:connect` then `circuit_open`, p99 within +20 ms. After a restart Rust serves again. |
| `shadow-stalled` | **AT-M02-10**: `rust` is paused, so it accepts connections and never answers. Nine rounds of 1,000 concurrent requests run off / A/A control / shadow, from a separate load process. Every answer is Bun's, shadows in flight never exceed 8, drops are counted, and the pooled p99 adds ≤ 5 ms. If the A/A control itself differs by more than 5 ms, the machine is too noisy and the check reports *inconclusive* rather than passing. |
| `logs` | **AT-M02-08/11**: no permission key and no assertion in any bridge, sweep or Rust log line. Rolls up all phases. |

## What it does not prove

- **Upstream's real `authenticate` hook.** The one substitution is a stub that stamps the same context fields from
  `x-test-*` headers, as upstream's own route test does. M02 doesn't change `authenticate`, and its suites cover it.
  The 401 paths here come from the real `requireSession`.
- **The platform bypass audit row.** The real enumerator and `withPlatformContext` run, but the auditor is a counter;
  `m34PlatformBypassAuditor` has its own upstream suite.
- **Production.** Nothing here touches production. P2 prerequisites 1–4, 6 and 7 still apply.

## Debugging

`KEEP=1 verification/local-stack/run.sh` leaves the stack up. Remove it with
`docker compose -f verification/local-stack/compose.yml down -v`.
