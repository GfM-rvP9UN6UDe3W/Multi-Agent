# SPEC-0011 verification evidence

Date: 2026-09-21. Local implementation, native-gateway verification, immutable MIT packaging and all six remote CI jobs complete for source `cf574c4`. Earlier pending/failing results below remain as historical evidence; the final result is recorded at the end.

## Baseline and RED

Source baseline: main `eaf38f799806050177f99aa588085403077adb57`, initially clean. The fresh local audit passed 435 Node tests, 48 Python tests, typecheck, formatting and all five generated artifacts.

The authenticated GitHub connector retrieved actual logs from [run 35525915849](https://github.com/masonlee39/Multi-Agent/actions/runs/35525915849). Both pinned-native-protocol jobs passed. All four contract jobs failed:

- macOS / Node 22: setup-python cannot find Python 3.11.13 arm64. The official actions/python-versions manifest lists 3.11.9 as the last 3.11 macOS arm64 installer. Linux 3.11.13 remains available.
- macOS / Node 24: adapter test expected post-submission unknown but the 50ms total deadline could expire during startup; the 40ms Claude usage test could time out before native initialization.
- Linux / Node 22: the same adapter/usage timing assumptions, a two-second CLI initialize deadline, and an actual `121 !== 120` control lifecycle duration failure.
- Linux / Node 24: two CLI initialization timeouts. Packaging/capacity steps were skipped after the failing test step.

New deterministic RED command:

```sh
node --test --test-name-pattern='0011-R0[13]' \
  tests/engine/lifecycle.test.ts tests/contract/cli-shutdown.test.ts
```

Result: 0/2 passed. The clock advancing between reads produces `51 !== 50`; a deliberate 2200ms startup delay triggers `Fixture RPC timed out: initialize`. Raw log: `/private/tmp/agent-orch-0011-red.log`.

## Initial GREEN

The exact same two tests pass after using one captured wall time and separating the bounded initialization wait from business shutdown deadlines. Native timeout fixtures now advance a controlled host execution budget only after observing initialize/turn submission/acceptance. They intentionally delay native startup beyond the old 50ms cap. CLI fixtures use a 4 KiB emergency reserve, matching other fixtures, instead of allocating the 256 MiB production reserve for every signal case. Storage-capacity behavior remains covered separately.

Focused regression: adapters, host usage, CLI shutdown, engine lifecycle and lifecycle wire tests passed **59/59**, zero skips. Production timeouts, unknown outcomes, stop evidence and existing assertions remain intact. Raw log: `/private/tmp/agent-orch-0011-focused.log`.

## Application CLI inspection

The user selected an existing downstream application's CLI and clarified that Claude/Codex identify SDK runtimes, not required model vendors. Read-only source inspection and CLI `/model` confirm that CLI 1.2.23 uses the application's own bridge and private model catalog. No source or configuration of that application was modified, and no login credential was read. The CLI rejected `/private/tmp` as a system workspace; the separate accepted workspace is an ignored directory under `dist/acceptance`.

Ordinary prompts to that CLI use its existing conversation pipeline; they do not invoke this repository's orchestration engine. A CLI success must therefore be recorded separately from engine task/approval/tool-bridge acceptance. Full engine tests can use SDK runtimes with compatible private gateways; official-vendor models are not a requirement.

The user-requested minimal CLI turn returned exactly the expected acceptance token with no displayed tool calls. CLI displayed 13.1 seconds and 66K tokens; `/cost` reported 66K context/cumulative tokens, not a verified invoice amount. The runtime provider is not exposed by that CLI output, so this is not separate proof of both Claude and Codex runtime paths. Only one real turn was submitted; no source of that application was modified.

## Real native binary findings and corrections

The new `scripts/native-gateway-smoke.mjs` executes the actual binaries through the engine and both SDK languages. It replaces its environment with an isolated home and synthetic credentials, serves scripted model responses on loopback, bounds requests/deadlines, and cleans up only its own temporary data. Initial real-binary runs found two defects that protocol peers had missed:

1. **Claude tool enumeration:** SDK 0.3.274 with workspace Zod 4.6.5 connects its MCP server but fails `tools/list`: `Cannot read properties of undefined (reading 'push')`, in Zod's record JSON-schema processor called by the SDK's bundled converter. Consequently the real native model request contains only Glob/Grep/Read. Prior fixtures invoked tools directly and did not reject an enumeration error. The fixture now asserts successful tools/list and all four exact names in both standalone and engine modes. The corrected assertion fails against 4.6.5 (`/private/tmp/agent-orch-0011-zod-red.log`) and passes with **4.4.3** (`/private/tmp/agent-orch-0011-zod-green.log`). Workspace lockfile and optional peer now pin 4.4.3. Attempts to change tool allowlists/preloading did not fix the schema error and are not part of the final implementation.
2. **Codex helper aliases:** Native 0.153.4 creates executable symlinks under its managed home `tmp/arg0/codex-arg0*/`. The original quota scan rejected them and blocked approval after a successful native tool call. The [pinned upstream implementation](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/arg0/src/lib.rs) confirms these are runtime helper aliases. The storage regression fails with `UNTRUSTED_PATH` before the fix. Only the four exact helper leaf names under that exact path pattern are treated as ephemeral: quota uses lstat link bytes, archives/backups omit the links, and the engine never follows or copies targets. Unexpected links and linked ancestor directories still reject. The test preserves real retained history and verifies archive integrity and unchanged outside-file content. The first GREEN attempt exposed a noncanonical fixture archive path; using its real path makes the focused regression pass.

Final native evidence is in `dist/verification/0011/native-claude.json` and `native-codex.json`. Each provider passes six groups:

- Native MCP discovery, actual engine-bound work_read, task approval and local resource release.
- Retained native history inspection, retaining `execution: unknown` rather than inferring execution from history.
- Native fork with a different upstream identity and inherited parent history.
- Serial reuse preserving upstream identity.
- Manual compaction with an observed native boundary and released resources.
- An actual Python socket client creating/approving a native task and reading native history/usage.

Versions: Claude SDK **0.3.274**, native Claude **2.1.274**, Zod **4.4.3**, Codex **0.153.4**, Node **24.14.0**, Python **3.14.6**, Darwin **25.6.0 arm64**. The gateway supplies all responses; no paid model calls or login credentials are used. Saved-history/native protocol behavior is verified, but model reasoning quality, compaction semantics, real billing, arbitrary shell containment and application integration are not inferred from these results.

## Full current-source verification

| Command / environment | Result |
| --- | --- |
| `npm test`, Node 24.14.0 | **438/438**, zero failures/skips; 30.51 s |
| `npm test`, exact Node 22.18.0 | **438/438**, zero failures/skips; 31.12 s |
| `npm run test:python`, Python 3.14.6 | **48/48**, zero skips; 11.62 s |
| `npm run typecheck` | Pass |
| `npm run check:generated` | Pass; 5 artifacts, 57 definitions |
| `npm run format:check`, `git diff --check` | Pass |
| Real binary loopback script, each provider | Six groups pass, including both SDK languages |

Logs: `/private/tmp/agent-orch-0011-final-node.log`, `-final-node22.log`, `-final-python.log`. Node 22.18.0 was downloaded from nodejs.org into an owned temporary directory and verified against the official SHA-256 manifest before execution; no global runtime was replaced.

The CI matrix now uses the available macOS arm64 Python 3.11.9 installer while retaining Linux 3.11.13, both Node versions and both OSes. Separate Node/Python steps preserve failure logs. Native jobs additionally exercise both real binaries and both clients with the scripted gateway. These changed jobs have not yet run remotely; a pass requires an actual run of the resulting committed SHA.

## Capacity experiment

`node scripts/capacity-benchmark.ts 1000,10000,50000 100` passed on the same Apple M5 Pro / Node 24.14.0 machine. Admission p95 was **6.13 / 8.68 / 16.77 ms**; observed peak process RSS was **133.4 / 151.1 / 261.5 MB**. Each sample ran 100 actual fixture tasks after seeding historical state. Full rates, SQLite timing, snapshots, GC and storage sizes are in [0011-capacity.json](0011-capacity.json). Native verification was also running on this machine during the measurement; these are bounded local observations, not an isolated production throughput benchmark. No million-record, 10-GiB or multi-writer claim is made.

## Local MIT candidate

Five npm `0.1.0-rc.3` archives and Python **0.1.0rc3** wheel/sdist are built from this source into `dist/release/0.1.0-rc.3`. Existing rc.1/rc.2 bytes remain untouched. `scripts/build-python.py` builds from an isolated staging copy, changes both Python metadata and module version there, emits hashes, and refuses an existing candidate. Package smoke checks one coherent npm/Python release identity and both manifests before clean offline installation.

The first package run detected an obsolete missing-peer assertion still expecting `zod ^4.0.0`; the correct package already reports `zod 4.4.3`. Only that assertion was updated, then the same immutable archives were retested. Final clean offline smoke passed **nine reported modes**, covering installed embedded TS, installed Claude MCP, separate CJS/ESM bundles, each provider alone, installed Codex MCP, installed Python and a Python wheel rebuilt from the sdist. Raw output: `/private/tmp/agent-orch-0011-package-smoke-final.log`. All seven archives separately passed MIT license-file and coherent version-metadata checks. The final handoff is `dist/release/agent-orch-0.1.0-rc.3.zip`, with adjacent SHA-256; its inner manifests retain individual archive checksums.

## Scope of completion

R01–R03 and R08 are implemented with reproducible failure/behavior evidence. R04 workflow corrections are implemented; current-source remote execution remains pending. R05 documentation and the [remaining-gate ledger](../acceptance/readiness.md) separate local implementation from deployment claims. R06 adds bounded real-binary and 50k-history experiments; automatic economic routing remains disabled without real quality/cost evidence. R07 produces local MIT artifacts; publication is not authorized. The user-selected model may be behind the application's private gateway; Claude/Codex denote runtime adapters, not a mandatory model vendor.

## First current-source CI and R09 follow-up

The user authorized commit/push and continued CI verification. Source `05bd2daae94e6c9ad62944b14ce7a9bb01fbd508` ran in [35529014428](https://github.com/masonlee39/Multi-Agent/actions/runs/35529014428). Both native jobs passed, including actual Claude/Codex binaries, both SDK languages and six behavior groups per provider. macOS / Node 24 passed all contract, Python, packaging and capacity steps. Three contract jobs exposed additional fixture portability/timing defects:

- Both Linux Python runs failed 11 fixtures before execution because `/private/tmp` does not exist. These fixtures now canonicalize the existing short `/tmp` root, preserving Unix socket length and symlink/path validation.
- macOS / Node 22 returned unknown instead of failed for a Claude terminal-classification test because its unrelated 40 ms child-cleanup allowance expired. Classification uses the adapter's normal 1 s cleanup allowance; the intentionally held-child case retains 40 ms and still asserts unknown plus retained resources.
- Linux / Node 24 found four races: a shutdown RPC transport watchdog expired, a 180 ms native turn window expired before startup reached turn/start, a negative contract subprocess timed out while allocating a production-size emergency reserve, and a drain fixture finished its 100 ms fake turn before the incomplete-shutdown assertion. Transport waits now leave room for the unchanged shutdown budget; rollback timing starts at the observed boundary; the optional conformance harness uses a 4 KiB fixture reserve; terminal delivery is explicitly gated until after the incomplete-drain assertion.

For a reproducible RED, the Codex fixture delays initialization by 300 ms. The original 180 ms setup fails to reach turn/start: **0/1**, `/private/tmp/agent-orch-0011-remote-red.log`. With the controlled monotonic budget started after native acceptance, the same delayed fixture preserves the wall-clock rollback, unknown-outcome, bounded cleanup and child-release assertions. Focused regression passes **68/68**, and Python passes **48/48**, no skips (`-remote-focused.log`, `-remote-python.log`). Production runtime deadlines and success/unknown rules are unchanged. No failed test is silently retried.

Full local follow-up: **438/438** Node tests, zero skips, 27.62 s (`/private/tmp/agent-orch-0011-remote-node.log`); **48/48** Python tests, 7.79 s; typecheck, five generated artifacts, formatting and diff checks pass. Remote revalidation remains required for this follow-up revision.

## Final remote GREEN and immutable rc.4

Source **cf574c470077fdeb5974f3889d88854e88b48819** passed all **6/6** jobs in [run 35529393933](https://github.com/masonlee39/Multi-Agent/actions/runs/35529393933). The four contract environments (macOS 14 / Ubuntu 24.04 × Node 22.18.0 / 24.14.0 with the declared Python versions) each passed **438/438 Node**, **48/48 Python**, generated/type/format checks, package builds, all **nine** clean-install/bundle modes and the 1k/10k capacity experiment. Both native jobs passed the pinned protocol check and all six real-binary scripted-gateway groups for each provider. [0011-ci.json](0011-ci.json) preserves exact job IDs, step results and log evidence. There were no skipped tests or retried failed steps in this run.

The follow-up changes include the optional packaged conformance harness, so new immutable npm **0.1.0-rc.4** and Python **0.1.0rc4** archives were built from this clean committed source. All seven archives pass SHA-256, exact MIT license-file and version-metadata checks; local clean offline installation/bundle smoke again passes nine modes (`/private/tmp/agent-orch-0011-rc4-package.log`). Earlier rc.1–rc.3 artifacts are unchanged. The handoff is `dist/release/agent-orch-0.1.0-rc.4.zip` with an adjacent SHA-256 and inner source/release manifests.

R01–R09 are complete within this repository's scope. The [readiness ledger](../acceptance/readiness.md) retains selected production gateway quality/billing, deployment sandbox, application integration, measured economic policy, production-scale capacity and publication gates; this CI result does not supply those deployment-specific observations.

## Subsequent clean-source rerun

Documentation-only commit `292c692` left packaged code, tests and workflow identical to `cf574c4`, but [run 35529718426](https://github.com/masonlee39/Multi-Agent/actions/runs/35529718426) exposed an intermittent Linux / Node 22 failure in the Python-driven Claude pause/resume/cancel fixture. Its final cancel operation was not completed; the original assertion omitted the operation details, so that log alone does not identify whether native observation or durable settlement consumed the one-second fixture window. Other jobs retained their results; the earlier six-job pass is not substituted for this run.

The functional fixture now allows three seconds for native interruption and engine settlement and five seconds for the client's wait, with operation/task diagnostics on failure and an explicit assertion that resume reached running. Production timeout defaults are unchanged. The separate late-terminal scenario retains its 35 ms engine deadline, one-second adapter allowance and outcome_unknown/resource-release assertions. These test-only files are not present in the rc.4 package payloads; the immutable package source remains `cf574c4`.

Local validation after the adjustment: all three actual subprocess lifecycle cases pass, including TypeScript, Python and the deliberately expired pause; exact Node 22.18.0 full regression passes **438/438**, zero skips, 28.43 s (`/private/tmp/agent-orch-0011-interrupt-node22.log`). Strict TypeScript and diff checks pass. The next remote run must validate this committed fixture change; its result is linked with the final delivery rather than rewriting earlier run evidence.

## CI flake in 0011-R03 (push run 35832001307)

The push run of the documentation-only commit `6315492` failed one job: contracts on Ubuntu 24.04 with Node 24.14.0 ([run 35832001307](https://github.com/masonlee39/orchvia/actions/runs/35832001307), job 107086545009). `0011-R03 delayed stdio startup does not consume the configured shutdown deadline` threw `Fixture condition did not become true before its deadline` from `waitForExit`: the stdio host had not exited 3,000 ms after SIGTERM. The test took 6,421 ms. The pull-request run of the same commit passed 7 of 7, and so did the rerun. The log cannot show the host's stderr, because the fixture's timeout error did not include it.

Where the exit time goes, measured in the host child with a preload that times each fsync and SQLite COMMIT after SIGTERM (macOS arm64, Node 24.14.0, `702a3d7`, which has the same engine, CLI and test as `6315492`):

- Between SIGTERM and exit the host makes 7 SQLite commits (one with nothing to write) and 8 fsyncs, then closes both databases; closing the store checkpoints its WAL. The 8 fsyncs write two durable artifacts, the runtime-terminal evidence and the lease-release certificate. Each artifact writes a commit journal and the artifact file, and fsyncs each file and its directory.
- Everything else on the path takes a few milliseconds. SIGTERM to exit:

| Condition | Exit after SIGTERM | Slowest fsync |
| --- | --- | --- |
| R03 alone | 36 ms | 3.8 ms |
| Whole suite | 38 ms | 3.8 ms |
| Whole suite, 36 CPU-bound processes (2 per core), 2 runs | 100 / 84 ms | 29 ms |
| Whole suite, 4 processes each writing and fsyncing 256 MiB files, 2 runs | 399 / 300 ms | 100 ms |
| Whole suite, both loads, 2 runs | 281 / 363 ms | 45 ms |

Cause: the fixture assumed the exit takes less than 3 s, but the exit time is the sum of those 17 durable calls, which the shutdown budget does not bound.

- `close()` checks its deadline only while a flight remains, between event-loop turns. The aborted fake turn records its terminal, releases its lease and leaves `flights` in one chain of microtasks. So slow durable writes delay the exit but never make the shutdown incomplete. With 80 ms added to each fsync after SIGTERM, the host exited 682 ms after SIGTERM, with code 0 and a 500 ms budget. This matches SPEC-0001 AC07 and SPEC-0004 AC-R02: the budget bounds the wait for owned work.
- A 3 s exit holds only while the 17 calls average under about 175 ms. Under load, one committed call has taken 85–384 ms before ([TDD-0014](0014-host-workflow-controls.md#remote-ci), 24 parallel local runs). Ubuntu runners are slower than macOS here: the Ubuntu Node 24 test step took 79–97 s in the last four runs, against 38–54 s on macOS with the same Node. The macOS disk above never came close to 175 ms, and no Linux machine was available locally.
- The suite loads the disk itself. One whole-suite run wrote and fsynced 48 emergency reserves of the default 256 MiB, 12 GiB in total: 10 from `engine/routing-layer`, 9 from `engine/routing-corrections`, 6 from `engine/context-check`, 4 from `engine/runtime-approval`, 3 each from `contract/sdk` and `contract/store-namespaces`, 9 from CLI hosts whose configuration sets no `storage`, and 4 from other tests and examples. The CLI shutdown fixtures and `tests/fixtures/engine.ts` use a 4 KiB reserve.

RED: `tests/fixtures/slow-durable-sync.ts` makes each durable sync point take 250 ms once the host receives SIGTERM: each fsync, each SQLite COMMIT and each database close. It changes no data and no order. The new test `0011-R09 slow durable writes after SIGTERM do not fail a successful stdio shutdown` uses it with the R03 shutdown configuration. With the original harness it failed in 3,534 ms with the CI message, from `until` in `waitForExit`.

Fix, in the test harness only:

- `waitForExit` waits up to 30 s. That is a watchdog: the behavior under test is the exit code, the persisted wait and the task state, not how fast the disk is. Its error now includes the host's stderr, so a hang or a `SHUTDOWN_INCOMPLETE` would be visible in the CI log.
- R03 keeps all its assertions, including the persisted wait of 500 ms. No engine, CLI or production timeout changed.
- The 14 other signal tests in the file no longer have a 6 s per-test limit. Like R03 and R09, each of their waits has its own bound: 10 s for each RPC, 3 s for state polls and 30 s for the exit. The suite's 120 s timeout remains the outer bound. A 6 s limit counts from startup, so it would expire before the exit watchdog and report no stderr.
- Every fixture RPC now waits up to 10 s, as `initialize` and `host.shutdown*` already did; ordinary requests had 2 s. A host answers only between its synchronous writes. After an incomplete drain it stays up while the fake turn finishes and persists its result, and `operations.get` waits behind that work.

Timing invariant: the host exits with code 0 before the watchdog whenever those 17 calls average under about 1.7 s.

GREEN:

- R09 passes. On an idle machine the host exited 4.36–4.38 s after SIGTERM in three runs, 17 × 250 ms of injected latency plus about 0.1 s. It exited with code 0, the task paused with `runtime_interrupted`, one persisted wait of 500 ms and no `SHUTDOWN_INCOMPLETE`.
- The 6 s limits, with the slow-sync preload loaded twice into every host of the file through `NODE_OPTIONS` (500 ms per durable call after SIGTERM): before their removal, 6 SIGTERM tests failed with `test timed out after 6000ms`; after it, they pass in 8.8–10.9 s. At 250 ms per call the drain tests had already taken 5.73 and 5.86 s against their 6 s limit.
- The whole file passes 16/16 on Node 24.14.0 and Node 22.18.0. 12 parallel runs of the whole file under 36 CPU-bound processes passed 192/192.
- The RPC limit, under the same preload: with 2 s, both `incomplete drain keeps the host` tests failed with `Fixture RPC timed out: operations.get` at 250 and at 500 ms per call. With 10 s, the whole file passes 16/16 at both; those two tests take about 6 s and 11.9 s.
- Whole suite with the final change: **565/565**, zero skips, on Node 24.14.0 (47.7 s) and Node 22.18.0 (51.5 s). The three loaded whole-suite runs in the table that included the exit watchdog also passed 565/565.
- 24 parallel runs of R03 and R09 under 36 CPU-bound processes: 0 failures of 48; R03 took up to 3.7 s and R09 up to 5.3 s.
- Mutation: when `close()` reports `SHUTDOWN_INCOMPLETE` once persistence has passed the budget, R03 still passes and R09 fails at the watchdog after 30.1 s. The failure message shows the host's stderr, with its `SHUTDOWN_INCOMPLETE` line.

Not verified: the Ubuntu disk latency during the failed run is inferred, not measured. The fix covers any cause that only delays a successful exit. A cause that keeps the host alive would still fail, now with the host's stderr in the message.

## Production-size reserves in the test suite

Date: 2026-09-23. Found while investigating the 0011-R03 failure in [run 35832001307](https://github.com/masonlee39/orchvia/actions/runs/35832001307) (Ubuntu 24.04, Node 24.14.0). Source `702a3d7`; no engine, CLI, SDK or example code changes.

Fixtures use a 4 KiB emergency reserve (Initial GREEN above): `tests/fixtures/engine.ts`, the CLI shutdown fixtures and the optional conformance harness. Tests added since then that call `createOrchestrator` or the engine directly, or write their own CLI configuration, set no `storage`. Each engine they start writes and fsyncs the 256 MiB production reserve (`reserveEmergency` in `packages/engine/src/storage.ts`, skipped only when free space is below the reserve plus 1 GiB).

Measurement: one whole-suite run of the `npm test` command with a preload in `NODE_OPTIONS="--import …"`. The preload wraps `fs.openSync`, `writeSync`, `fsyncSync` and `closeSync` and calls `syncBuiltinESMExports()`, so the engine's named imports use the wrappers. It logs every `emergency.reserve` with its size and open-to-close time, and every process's pid, parent pid and argv. An allocation belongs to the nearest ancestor process that runs a test file. The preload also adds itself to children spawned with their own environment; those 125 spawns were runtime stubs, and none allocated a reserve. It changes nothing a test does. Machine: Apple M5 Pro, Darwin 25.6.0 arm64, Node 24.14.0.

Before: **564/564** pass. 404 reserves: **48 of 256 MiB**, 12 GiB written and fsynced, and 356 of 4 KiB. Each 256 MiB reserve took 132–525 ms from open to close (median 304 ms), 14.7 s in total.

| Test file | Engine started by | 256 MiB reserves |
| --- | --- | --- |
| `engine/routing-layer` | in-process `createOrchestrator` | 10 |
| `engine/routing-corrections` | in-process `createOrchestrator` | 9 |
| `engine/context-check` | in-process `createOrchestrator` | 6 |
| `contract/lifecycle-wire` | CLI hosts, 4 stdio and 1 socket | 5 |
| `engine/runtime-approval` | in-process `createOrchestrator` | 4 |
| `contract/sdk` | in-process `createOrchestrator` | 3 |
| `contract/store-namespaces` | in-process, 1 engine and 2 `createOrchestrator` | 3 |
| `contract/host-cli` | CLI hosts, socket | 2 |
| `contract/cross-language` | CLI host, socket | 1 |
| `contract/execution-isolation-wire` | CLI host, socket | 1 |
| `contract/claude-cleanup-recovery` | in-process `createOrchestrator` | 1 |
| `contract/docs` | `examples/typescript/quickstart.ts` | 1 |
| `contract/host-runtime-process` | `examples/typescript/hosted.ts` | 1 |
| `contract/usage-recovery` | `examples/typescript/usage-forwarding.ts` | 1 |

Decisions:

- The first eleven files now pass `storage: { emergencyBytes: 4096 }` in their own helper or CLI configuration, as `tests/fixtures/engine.ts` does; `minFreeBytes` keeps its default. None of them asserts the storage policy, the reserve or free space. `routing-corrections` and `context-check` collect old records and compare record counts, which the reserve does not affect. The reserve and the storage policy stay covered by `storage-governance`, `storage-faults`, `store-rollover` and `rollover-crashes`, which already use 4 KiB.
- The three examples keep the production default, and their source is unchanged. These tests run each example as a reader does: 0021-R01 is the README quickstart, AC-H09 and AC-P08 the offline host and usage forwarding examples. They are now the only tests in `npm test` that write the 256 MiB default in 1 MiB chunks. Cost: 768 MiB per run, one reserve in each of three files. AC-H09 and AC-P08 give their example 5 s; the two tests took 0.33–0.82 s, reserve included.
- No production default, engine, CLI or example changed.

After, on the same machine with the same command:

- Preload run: **564/564**. 404 reserves: 401 of 4 KiB and **3 of 256 MiB**, the examples. **770 MiB** instead of **12,289 MiB**.
- Whole suite, 7 runs each, all 564/564 with zero skips: before 47.3–50.9 s (mean **49.2 s**), after 43.9–48.2 s (mean **45.8 s**). Four of the pairs were interleaved, reverting and reapplying the change between runs; the change was faster in each of those pairs.
- Bytes written by all disks during a run, including other activity on the machine: before 14.6–16.2 GiB, after 3.3–4.7 GiB.
- `npm test` **564/564** (46.3 s), exact Node 22.18.0 **564/564** (51.5 s), `npm run test:python` **79/79**, zero skips; typecheck, format and diff checks pass.

Python suite, measured the same way with its own command: 39 reserves, **11 of 256 MiB** (2,816 MiB), from the CLI hosts started by `test_node_e2e` (4), `test_node_execution_isolation` (3), `test_node_reconcile` (3) and `test_fork_model` (1). The owner chose to fix these in the same change. Their configurations now set `"storage": {"emergencyBytes": 4096}`, as `test_store_namespaces` already did; none of the four checks storage. After: 39 reserves of 4 KiB, 156 KiB in total. Four interleaved pairs, each **79/79**: before 18.9–20.7 s (mean **19.6 s**), after 17.4–18.9 s (mean **18.0 s**), faster in each pair. Bytes written by all disks during a run: before 3.0–3.1 GiB, after 0.3–0.6 GiB.

Not verified: the time saved on the Ubuntu runner, where the Node 24 test step took 79–97 s against 38–54 s on macOS; that needs a CI run.

### R10: the reserve guard

Three new test files brought back 25 of the 48 reserves within a week, so the owner chose a check that runs in both test commands, locally and in CI. [SPEC-0011](../specs/0011-release-readiness.md) R10 states it.

`tests/fixtures/reserve-guard.mjs` wraps `fs.openSync`, `writeSync` and `closeSync` and calls `syncBuiltinESMExports()`. When a write would take a file named `emergency.reserve` past 4,096 bytes, it throws `TEST_RESERVE_GUARD` before writing, unless the process's entry script is under `examples/`. It adds its absolute, quoted path to `NODE_OPTIONS`, so the CLI hosts, fixtures and examples that tests start load it too. A child started with its own environment and no `NODE_OPTIONS` is not checked; today those are only runtime stubs. `npm test` loads the guard with `node --import`, and `npm run test:python` sets `NODE_OPTIONS` for Python, which passes it to the hosts it starts. The chain through npm, sh, Python and Node works on Node 22.18.0 and 24.14.0, including a path with a space.

RED: `tests/contract/reserve-guard.test.ts` starts a Node process that loads only the guard, as a test file does, and that process starts a stdio CLI host. With an empty guard module, `0011-R10 a CLI host started by a test cannot write the 256 MiB default reserve` failed: the host exited 0 after writing a 268,435,456-byte reserve. `0011-R10 a 4 KiB test reserve passes the guard` passed, which is regression coverage.

GREEN:

- Both R10 tests pass on Node 24.14.0 and 22.18.0. The host exits 1 with `{"code":"TEST_RESERVE_GUARD","message":"<stateDir>/emergency.reserve would grow past 4096 bytes in …/main.ts host --config … --stdio. Test engines use storage: { emergencyBytes: 4096 }; …"}` on stderr, and its reserve file has 0 bytes. An in-process `createOrchestrator` rejects with the same code.
- With this change's fixture edits reverted and the guard on, `npm test` failed 43 tests, all in the eleven files above, and `npm run test:python` failed 11, all in the four Python files. With the edits, both pass.
- With the examples exception removed from the guard, exactly the three example tests failed with `TEST_RESERVE_GUARD`. The examples run under the guard and keep their default only through that exception.
- Guarded `npm test`: **566/566** on Node 24.14.0 in three runs (43.5, 64.2 and 45.4 s; during the 64.2 s run other work on the machine held the load average near 8–11, and the same tests were slower across the board) and on Node 22.18.0 (44.7 s). Guarded `npm run test:python`: **79/79** on both.
- Cost: starting Node with the guard took 22.0 ms against 18.9 ms without it (means of 30 interleaved runs), about 3 ms for each of the roughly 300 Node processes in a suite run.

Limits: a Python stdio test reports only `Engine connection ended before the next complete response`. The guard's message is in the host's stderr, which the Python client keeps in `stderr_tail` but does not add to that error. A single-file `node --test` run is checked only when it adds `--import ./tests/fixtures/reserve-guard.mjs`. The remote CI run is pending.
