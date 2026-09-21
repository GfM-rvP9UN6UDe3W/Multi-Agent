# Release-readiness ledger

Updated 2026-09-21 for SPEC-0012. This ledger distinguishes implemented SDK behavior, real native runtime behavior with scripted responses, and deployment evidence that those tests cannot supply.

## Verified implementation and runtime behavior

- SPEC-0012 implementation source `8ee5078` passed Node 22.18.0 and 24.14.0 **442/442 each** and Python 3.14.6 **49/49**, with no skipped tests. Generated artifacts, strict TypeScript, formatting, diff checks and nine package modes passed locally. [TDD-0012](../tdd/0012-tool-control-and-capacity.md) records the IPC rerun and bounded tool-read evidence.
- The same source passed all six jobs in [CI run 35561652769](https://github.com/masonlee39/Multi-Agent/actions/runs/35561652769). Each of four contract jobs passed 442 Node tests, 49 Python tests and nine package modes; both native jobs passed six Claude and six Codex scripted-gateway groups. [Exact SPEC-0012 CI evidence](../tdd/0012-ci.json) preserves the preceding failures, fixes and final proof without inferring the missing cancelled-job log.
- Immutable MIT candidate `0.1.0-rc.5` (Python `0.1.0rc5`) preserves its precommit source provenance and is not promoted as the clean handoff. The clean committed-source handoff uses new immutable `0.1.0-rc.6` / `0.1.0rc6` artifacts. RC4 and all earlier candidates remain unchanged.
- Claude SDK 0.3.274 / native Claude 2.1.274 with **Zod 4.4.3**, and Codex 0.153.4 run as actual owned binaries. Both TypeScript and Python clients create tasks, observe native output, approve it and read retained history/usage through the engine.
- Both native runtimes expose the four bound orchestration tools. A native `work_read` returns actual engine state, native delegation tools are absent from the observed inventory, completed execution releases resources, fork preserves parent history under a distinct native ID, serial reuse retains identity, and manual compaction emits a native boundary. These tests use a bounded loopback gateway, synthetic credentials and scripted model responses.
- Storage fault, namespace, archive and idempotency regressions remain enabled. Codex executable aliases under `runtime/codex/tmp/arg0/codex-arg0*/` are measured by link bytes without following them and omitted from archive/backup payloads. Other symlinks, including ancestor-directory links and unexpected helper names, remain rejected. Retained native history is still copied and verified.
- Bounded [SPEC-0012 measurements](../tdd/0012-capacity.json) cover 1,000, 10,000 and 50,000 historical tasks, each followed by 100 fixture tasks and 20 bound `work_read` calls. Mean tool-read time was 0.46/0.55/0.64 ms. The [benchmark](../../scripts/capacity-benchmark.ts) sets `limits.maxLogicalSessions: 100000`; the programmatic default is 10,000 persisted sessions, after which a new session fails with `SESSION_CAPACITY_EXHAUSTED`. Routine GC does not remove those sessions. The 50k row is not a default-configuration result or a million-record/10-GiB service guarantee.
- The user-requested Axion CLI 1.2.23 turn returned `ORCH_AXION_CLI_ACCEPTANCE_OK` using its ZT default model. It was one ordinary application conversation; it did not prove this SDK is integrated into the application pipeline. No Axion source was modified and no login credentials were inspected.

## Remaining gates and exact next evidence

| Gate | Current status | Required evidence / action |
| --- | --- | --- |
| Selected production gateway/model | Native transport verified with scripted responses; model quality and real billing unverified | Bind the application's chosen model/gateway and host-owned identity. Run equivalent TS/Python task, tool, cancellation and failure scenarios with a finite request/time/spending limit. Claude/Codex are runtimes; official-vendor models are not required. Preserve missing prices/usage as unknown. |
| Deployment permission profile | Read-only inventory and engine authorization verified; OS/shell adversarial enforcement unverified | On each deployed OS/profile, test allowed workspace reads/writes, outside/private-state access, symlink races, escaped/background subprocesses and forged orchestration requests. Inventory absence alone cannot prove shell isolation. |
| Axion application integration | CLI availability verified; application acceptance outside this repository's mutation scope | A separately scoped Axion task must verify the actual application adapter, admission, permission callbacks, durable host binding, background resource observation and Electron build. Use the [bundled-host contract](bundled-host.md). |
| Economic automation | Estimation/accounting implemented; automatic economic selection deliberately disabled | Compare fresh/reuse/fork/compact/parallel on the same tasks and acceptance criteria. Record all failed/overhead spending, elapsed time, native request usage, cache hits/TTL rebuilds and quality. Enable a policy only after those measurements justify it. Scripted gateway tokens are not savings evidence. |
| Production capacity | Indexed tool-query fix, 50k local measurement and remote 1k/10k CI rows passed; deployment hardware/filesystem limits remain unverified | Repeat the [capacity benchmark](../../scripts/capacity-benchmark.ts), including `work_read`, and storage fault drills on the deployment hardware/filesystem and representative artifact/history sizes. Establish latency/backpressure breakpoints, then choose an explicit logical-session limit or rollover policy. |
| Public publication | Local MIT packages prepared; no registry publication authorized | Review the exact artifact hashes and release scope; publish only after required provider/profile/CI gates pass and publication is authorized. |

## Reproduce native runtime verification without paid models

Install the pinned development dependencies, including Codex 0.153.4 for the second command. Use a new evidence path for every run; existing evidence is never overwritten.

```sh
node scripts/native-gateway-smoke.mjs claude dist/verification/native-claude-new.json
node scripts/native-gateway-smoke.mjs codex dist/verification/native-codex-new.json /absolute/path/to/codex
```

The process replaces its environment with an isolated home, points model requests at its loopback server, uses synthetic tokens, limits gateway requests and turn duration, and removes its owned test workspaces after saving evidence. The script requires local Unix IPC and loopback permissions. Normal `npm test` invokes no native model endpoint; the separate CI native job explicitly runs this script.

Paid/private-gateway experiments remain separate. `npm run native:prepare -- /absolute/new-plan.json` writes a reviewable one-turn plan without inspecting credentials. Record the exact runtime/model/identity-source label and approved limits before running a real endpoint.
