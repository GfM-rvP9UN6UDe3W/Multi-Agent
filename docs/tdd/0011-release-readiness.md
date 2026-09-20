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

The user selected the existing Axion CLI and clarified that Claude/Codex identify SDK runtimes, not required model vendors. Read-only source inspection and CLI `/model` confirm Axion CLI 1.2.23 uses the GUI bridge and the ZT model catalog: `hqu-deepseek-v4.1-flash` (current default), `hqu-glm-5.3-flash`. No Axion source/configuration was modified, and no login credential was read. The CLI rejected `/private/tmp` as a system workspace; the separate accepted workspace is `dist/acceptance/axion-cli`.

Ordinary Axion CLI prompts use its existing conversation pipeline; they do not invoke this repository's orchestration engine. A CLI success must therefore be recorded separately from engine task/approval/tool-bridge acceptance. Full engine tests can use SDK runtimes with compatible private gateways; official-vendor models are not a requirement.

The user-requested minimal CLI turn returned exactly `ORCH_AXION_CLI_ACCEPTANCE_OK` with no displayed tool calls. CLI displayed 13.1 seconds and 66K tokens; `/cost` reported 66K context/cumulative tokens, not a verified invoice amount. The runtime provider is not exposed by that CLI output, so this is not separate proof of both Claude and Codex runtime paths. Only one real turn was submitted; no Axion source was modified.

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

R01–R03 and R08 are implemented with reproducible failure/behavior evidence. R04 workflow corrections are implemented; current-source remote execution remains pending. R05 documentation and the [remaining-gate ledger](../acceptance/readiness.md) separate local implementation from deployment claims. R06 adds bounded real-binary and 50k-history experiments; automatic economic routing remains disabled without real quality/cost evidence. R07 produces local MIT artifacts; publication is not authorized. The user-selected model may be behind Axion's private gateway; Claude/Codex denote runtime adapters, not a mandatory model vendor.

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

R01–R09 are complete within this repository's scope. The [readiness ledger](../acceptance/readiness.md) retains selected production gateway quality/billing, deployment sandbox, Axion integration, measured economic policy, production-scale capacity and publication gates; this CI result does not supply those deployment-specific observations.
