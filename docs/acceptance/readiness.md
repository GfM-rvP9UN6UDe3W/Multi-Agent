# Release-readiness ledger

Updated 2026-09-21 for SPEC-0011. This ledger distinguishes implemented SDK behavior, real native runtime behavior with scripted responses, and deployment evidence that those tests cannot supply.

## Verified locally

- Current Node 24.14.0 regression: 438/438; Python 3.14.6: 48/48; no skipped tests. Generated artifacts, strict TypeScript, formatting and diff checks pass. Node 22.18.0 is also tested explicitly; exact results are recorded in [TDD evidence](../tdd/0011-release-readiness.md).
- Claude SDK 0.3.274 / native Claude 2.1.274 with **Zod 4.4.3**, and Codex 0.153.4 run as actual owned binaries. Both TypeScript and Python clients create tasks, observe native output, approve it and read retained history/usage through the engine.
- Both native runtimes expose the four bound orchestration tools. A native `work_read` returns actual engine state, native delegation tools are absent from the observed inventory, completed execution releases resources, fork preserves parent history under a distinct native ID, serial reuse retains identity, and manual compaction emits a native boundary. These tests use a bounded loopback gateway, synthetic credentials and scripted model responses.
- Storage fault, namespace, archive and idempotency regressions remain enabled. Codex executable aliases under `runtime/codex/tmp/arg0/codex-arg0*/` are measured by link bytes without following them and omitted from archive/backup payloads. Other symlinks, including ancestor-directory links and unexpected helper names, remain rejected. Retained native history is still copied and verified.
- Bounded capacity measurements cover 1,000, 10,000 and 50,000 historical tasks, each followed by 100 fixture tasks. This is local measurement, not a million-record/10-GiB service guarantee.
- The user-requested Axion CLI 1.2.23 turn returned `ORCH_AXION_CLI_ACCEPTANCE_OK` using its ZT default model. It was one ordinary application conversation; it did not prove this SDK is integrated into the application pipeline. No Axion source was modified and no login credentials were inspected.

## Remaining gates and exact next evidence

| Gate | Current status | Required evidence / action |
| --- | --- | --- |
| Current-source macOS/Linux CI | Local fixes complete; remote verification pending | Commit/push the reviewed change, then inspect all four contract jobs and both native jobs for that exact SHA. The last published revision's [run 35525915849](https://github.com/masonlee39/Multi-Agent/actions/runs/35525915849) failed four contract jobs; its two protocol jobs passed. A workflow edit is not a new CI result. |
| Selected production gateway/model | Native transport verified with scripted responses; model quality and real billing unverified | Bind the application's chosen model/gateway and host-owned identity. Run equivalent TS/Python task, tool, cancellation and failure scenarios with a finite request/time/spending limit. Claude/Codex are runtimes; official-vendor models are not required. Preserve missing prices/usage as unknown. |
| Deployment permission profile | Read-only inventory and engine authorization verified; OS/shell adversarial enforcement unverified | On each deployed OS/profile, test allowed workspace reads/writes, outside/private-state access, symlink races, escaped/background subprocesses and forged orchestration requests. Inventory absence alone cannot prove shell isolation. |
| Axion application integration | CLI availability verified; application acceptance outside this repository's mutation scope | A separately scoped Axion task must verify the actual application adapter, admission, permission callbacks, durable host binding, background resource observation and Electron build. Use the [bundled-host contract](bundled-host.md). |
| Economic automation | Estimation/accounting implemented; automatic economic selection deliberately disabled | Compare fresh/reuse/fork/compact/parallel on the same tasks and acceptance criteria. Record all failed/overhead spending, elapsed time, native request usage, cache hits/TTL rebuilds and quality. Enable a policy only after those measurements justify it. Scripted gateway tokens are not savings evidence. |
| Production capacity | Bounded 50k local history measured | Repeat the [capacity benchmark](../../scripts/capacity-benchmark.ts) and storage fault drills on the deployment hardware/filesystem and representative artifact/history sizes, establish latency/backpressure breakpoints, then choose operational limits. |
| Public publication | Local MIT packages prepared; no registry publication authorized | Review the exact artifact hashes and release scope; publish only after required provider/profile/CI gates pass and publication is authorized. |

## Reproduce native runtime verification without paid models

Install the pinned development dependencies, including Codex 0.153.4 for the second command. Use a new evidence path for every run; existing evidence is never overwritten.

```sh
node scripts/native-gateway-smoke.mjs claude dist/verification/native-claude-new.json
node scripts/native-gateway-smoke.mjs codex dist/verification/native-codex-new.json /absolute/path/to/codex
```

The process replaces its environment with an isolated home, points model requests at its loopback server, uses synthetic tokens, limits gateway requests and turn duration, and removes its owned test workspaces after saving evidence. The script requires local Unix IPC and loopback permissions. Normal `npm test` invokes no native model endpoint; the separate CI native job explicitly runs this script.

Paid/private-gateway experiments remain separate. `npm run native:prepare -- /absolute/new-plan.json` writes a reviewable one-turn plan without inspecting credentials. Record the exact runtime/model/identity-source label and approved limits before running a real endpoint.
