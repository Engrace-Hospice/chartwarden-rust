# M00-006 runner-native test discovery (draft)

This branch starts at `fix/m00-routes-and-deps` (`c4a0046`). It does **not** execute upstream tests and is **not** an approved M00 baseline.

## Run

```sh
bun install --frozen-lockfile
bun run verify:selftest
bun run verify:discover --source ../chartwarden
```

The upstream checkout must be pinned to SHA `9e0899a77cf78928d9965c35bc6bd3bafe8471d7`. The source checkout is not modified by this command, but the runner's listing can execute configuration code and load modules. Run in a restricted, disposable environment with no production secrets or network access to production systems.

## Behavior

- Invokes the locally installed `vitest list --json=<file>` and `playwright test --list --reporter=json -c <config>` (config searched at the repo root and under `e2e/`). A configured runner that cannot be listed is `ERROR`, never `NOT_APPLICABLE`.
- Lists with placeholder `CHARTWARDEN_TEST_DATABASE_URL` / `CHARTWARDEN_TEST_REDIS_URL` on unresolvable `.invalid` hosts. Upstream guards ~500 live suites with `describe.skipIf(!DB_URL)`, and `vitest list` omits skipped tests; listing never runs the hooks that connect.
- A static TypeScript scan of every `*.test.ts(x)` records `.skip` / `.todo` / `xit` tests as `SKIPPED` (vitest's list mode omits them) and reports `GUARDED_BLOCK_NOT_LISTED` and `TEST_FILE_WITHOUT_DISCOVERED_TESTS` so nothing disappears silently.
- Duplicate full names get `#2`, `#3` ordinals and a `DUPLICATE_TEST_ID` finding instead of aborting the inventory (upstream has at least one).
- Timeout: `--timeout-ms` or `discovery.timeoutMs` in config.json; default 2 h. `--vitest-project <name>` shards the Vitest listing (reconciliation and `discoveryComplete` require an unsharded run).
- Converts runner-discovered cases to `runner::[project::]file::suite › test` identities.
- Emits `verification/output/<sha>/test-results.json` and `test-discovery-manifest.json`.
- Reports missing runner output, malformed JSON, duplicate IDs and runner errors instead of inventing test counts.
- Classifies discovered `*.live.test.*` cases as `BLOCKED` while PostgreSQL is absent; other discovered cases are `NOT_RUN`. These are **discovery classifications**, not execution outcomes.
- The existing `verify:inventory` command is unchanged.

## Mandatory independent verification before merge

1. Confirm actual Vitest 3/4 `list --json` output structure; adapt the parser to the installed upstream version, including parameterized and dynamically generated cases.
2. Confirm Playwright CLI reporter output for the installed version and whether Playwright exists in upstream at all.
3. Run self-tests and plant missing/duplicate test cases to demonstrate failure.
4. Compare discovered stable IDs to upstream's runner-native listing, not an AST-derived estimate.
5. Implement actual isolated test execution, architecture-gate retention and per-test outcome reconciliation as a separate change.
6. Provision disposable PostgreSQL and Valkey in a later phase; do not convert `BLOCKED` into `SKIPPED` or `PASS`.

## Validation at the pinned SHA (2026-10-31)

- Parsers are tested against captured Vitest 4.1.12 and Playwright 1.62 output (`verification/__tests__/fixtures/`).
- `--vitest-project dom`: 5,233 tests in 350 s; Playwright: 119 tests across 9 projects, repo-relative IDs; 1 real `DUPLICATE_TEST_ID`.
- Full unsharded Vitest listing takes well over 30 min on a 2-CPU machine; full-run totals are pending.

## Known limitations

Static scan gives stable IDs only to skipped tests with literal titles; others are reported as findings. A clean pinned source is required for approval, but a dirty development checkout is recorded. The run-manifest format is provisional. No CI workflow is included yet.

## Security and baseline correction

Discovery now uses the installed local Vitest/Playwright entrypoints, not `bun x` (which can download packages). The subprocess receives a restricted environment allowlist rather than inherited application secrets. Runner listing still executes upstream configuration and can run arbitrary code; enforce network isolation and an unprivileged disposable worker at CI level. The discovery-only payload always has `approvedBaselineEligible: false`; a successful listing cannot certify an M00 baseline.

The pinned checkout must have its dependencies installed before discovery. The test runner's JSON format still needs live validation, and the CLI path for Playwright must be verified against the actual installed version.
