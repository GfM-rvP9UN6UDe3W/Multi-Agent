# Status

Orchvia is alpha software. This page records what has been verified and what has not, with the date and source commit of each check. Links are relative to this directory.

## Summary

Last recorded on 2026-09-23 at source `7af317c`, the merge of pull request #9.

- **Implemented:** SPEC-0001 to SPEC-0020, listed below.
- **Local checks at that source:** 557 Node tests and 79 Python tests passed, none skipped. Typecheck, formatting and the generated-contract check (69 definitions) passed, and so did nine offline package installation and bundle modes.
- **CI:** [run 35815390103](https://github.com/masonlee39/orchvia/actions/runs/35815390103) passed all seven jobs:
  - contract tests on Ubuntu and macOS, with Node 22.18 and 24.14;
  - the real Claude and Codex binaries against a scripted loopback gateway, on Ubuntu, Apple silicon and Intel macOS. The gateway uses synthetic credentials and calls no model.
- **Not verified:**
  - acceptance with real models;
  - actual OS sandbox enforcement;
  - integration inside an external application;
  - economic benefit: speed and cost compared with other ways of running agents;
  - Windows.
- **Published:** 0.1.3 on 2026-09-25, from the tag `v0.1.3` at `2eaf9a2`, by the [release workflow](https://github.com/masonlee39/orchvia/actions/runs/36094084619) after the owner approved it, in the same way as 0.1.2: the five npm packages, `orchvia` on PyPI and a [GitHub release](https://github.com/masonlee39/orchvia/releases/tag/v0.1.3), then the same installation from npm and PyPI on Ubuntu and macOS (SPEC-0021 P04). 0.1.2 on 2026-09-24, from the tag `v0.1.2` at `fc6ad55`, by the [release workflow](https://github.com/masonlee39/orchvia/actions/runs/35962234095) after the owner approved it: the five npm packages through trusted publishing, the Python package `orchvia` on PyPI, and a [GitHub release](https://github.com/masonlee39/orchvia/releases/tag/v0.1.2) with the same archives and their SHA-256 sums. The workflow then installed the packages from npm and PyPI into empty directories on Ubuntu with Node 22.18 and on macOS 14 with Node 24.14, checked that each npm archive has the bytes it built, and ran a quickstart and a Python host (SPEC-0021 P04). Before that, 0.1.0 of the five npm packages on 2026-09-23 (`@orchvia/engine`, `sdk`, `adapter-claude`, `adapter-codex`, `cli`): the owner published archives built at `f331930`; each registry archive is byte-identical to that build, and a Linux CI build of the same source produces the same bytes. 0.1.1 was tagged but not published.

The [remaining-gate ledger](acceptance/readiness.md) lists every open gate and what would close it.

## Candidate builds

Before public packages, local release candidates were built for a downstream integrator. A candidate directory is never changed; changed bytes got a new version. All candidates were local builds; rc.14 was also published as a [GitHub pre-release](https://github.com/masonlee39/orchvia/releases/tag/v0.1.0-rc.14).

| Candidate | Date | Source | Adds |
| --- | --- | --- | --- |
| rc.14 | 2026-09-23 | `7af317c` | SPEC-0020: checking context references before submitting |
| rc.13 | 2026-09-23 | `e6bb1c6` | SPEC-0019: routing layer corrections |
| rc.12 | 2026-09-22 | `370085f` | SPEC-0018: optional routing layer |
| rc.11 | 2026-09-22 | `4ba551c` | SPEC-0017: audit corrections |
| rc.10 | 2026-09-22 | `fbf9bdf` | SPEC-0016: sessions after their task ends |
| rc.9 | 2026-09-21 | `7c9e922` | SPEC-0015: queue waits; corrections from a review of rc.8 |
| rc.8 | 2026-09-21 | `58db94f` | SPEC-0013: model-changing forks; SPEC-0014: host workflow controls |
| rc.7 | | `2d50e3e` | SPEC-0012 and earlier; the first candidate with complete evidence from committed source |
| rc.1 to rc.6 | | | Earlier local candidates, recorded in [TDD-0010](tdd/0010-bundled-host-delivery.md) and [TDD-0011](tdd/0011-release-readiness.md). rc.1 predates the MIT decision and keeps `UNLICENSED` metadata. |

## Earlier CI samples

- SPEC-0012 source `4ff806c` passed the selected Ubuntu Node 24 contract, package and capacity job ten consecutive times, from [run 35572905203](https://github.com/masonlee39/orchvia/actions/runs/35572905203) to [run 35575180837](https://github.com/masonlee39/orchvia/actions/runs/35575180837), and every six-job workflow passed. See the [record](tdd/0012-ci.json).

## Specifications and evidence

Each specification has a matching TDD record of observed failures before the change and passes after it, under [docs/tdd](tdd/0001-evidence.md).

| Specification | Scope |
| --- | --- |
| [SPEC-0001](specs/0001-foundation.md) | Foundation: wire methods, acceptance criteria, snapshot fields |
| [SPEC-0002](specs/0002-runtime-adapters.md) | Claude and Codex adapter boundaries |
| [SPEC-0003-A](specs/0003-a-lifecycle.md) | Durable deadlines and owner reconciliation |
| [SPEC-0003-A2](specs/0003-a2-execution-isolation.md) | Execution capacity, outcome quarantine and shared deadlines |
| [SPEC-0003](specs/0003-policy-retention-deadlines.md) | Lifecycle, retention and declared routing |
| [SPEC-0003-B](specs/0003-b-archive.md) | Archives and namespace transitions |
| [SPEC-0004](specs/0004-runtime-reliability.md) | Scheduling, shutdown, request deadlines and Claude cleanup |
| [SPEC-0005](specs/0005-wire-contract.md) | Client recovery and wire snapshots |
| [SPEC-0006](specs/0006-host-runtime-contract.md) | Host runtime contract and offline conformance |
| [SPEC-0007](specs/0007-host-policy-and-usage.md) | Embedded host policy and durable usage |
| [SPEC-0008](specs/0008-claude-interruption.md) | Claude interruption |
| [SPEC-0009](specs/0009-complete-design.md) | Design completion and the completion matrix |
| [SPEC-0010](specs/0010-bundled-host-delivery.md) | Bundled-host delivery |
| [SPEC-0011](specs/0011-release-readiness.md) | Release readiness and native verification |
| [SPEC-0012](specs/0012-tool-control-and-capacity.md) | Client-pause precedence and scoped capacity |
| [SPEC-0013](specs/0013-fork-model-change.md) | Forks that change the model |
| [SPEC-0014](specs/0014-host-workflow-controls.md) | Host workflow controls |
| [SPEC-0015](specs/0015-queue-waits.md) | Queue waits |
| [SPEC-0016](specs/0016-session-after-task-end.md) | Sessions after their task ends |
| [SPEC-0017](specs/0017-audit-corrections.md) | Audit corrections |
| [SPEC-0018](specs/0018-routing-layer.md) | Optional routing layer with pluggable judges |
| [SPEC-0019](specs/0019-routing-corrections.md) | Routing layer corrections |
| [SPEC-0020](specs/0020-context-check.md) | Checking context references before submitting |
| [SPEC-0021](specs/0021-open-source-readiness.md) | Open-source readiness |
| [SPEC-0022](specs/0022-close-interrupt-and-verification-feedback.md) | Interrupting close and verification feedback |
| [SPEC-0023](specs/0023-corrections-before-0.1.2.md) | Corrections before 0.1.2 |
| [SPEC-0024](specs/0024-read-path-performance.md) | Read-path performance |
| [SPEC-0025](specs/0025-operability-and-sdk-errors.md) | A crashed host's socket, in-process errors and a failed scheduler |
| [SPEC-0026](specs/0026-claude-mcp-without-zod.md) | A Claude MCP server without Zod |
| [SPEC-0027](specs/0027-read-only-access-and-host-corrections.md) | Read-only access, host labels and host-facing corrections (not yet released) |

## Claude and Codex baselines

| Runtime | Integration used by this repository | Version baseline | Verified boundary |
| --- | --- | --- | --- |
| Claude | Optional `@anthropic-ai/claude-agent-sdk` peer dependency; `query()` and native session resume | **0.3.241 is the declared minimum**, with peer range **`>=0.3.241 <1`**. **0.3.274** is the exact offline-tested candidate and pinned protocol CI version. | Installed 0.3.274 SDK, native Claude 2.1.274 against a scripted loopback gateway, actual tool enumeration/invocation, retained history, fork/reuse/compact, both clients, and offline permission/interruption transport. The adapter needs no Zod (SPEC-0026): that native run passed with Zod 4.6.5 installed, and SDK 0.3.241 and 0.3.281 passed the offline MCP checks with it. The range is an installation constraint, not proof that every release works. Real SDK/model end-to-end acceptance is pending. |
| Codex | Managed **`codex app-server`** subprocess; stdio JSONL and App Server **v2** types. The adapter does **not** import `@openai/codex-sdk`. | **`codex-cli 0.153.4`** was used for the recorded protocol-type comparison and offline launch-option checks. | v2 types generated by that CLI, real 0.153.4 binary with scripted gateway responses, deferred MCP discovery/invocation, retained history, fork/reuse/compact, both clients, and offline failure fixtures. Other CLI versions require regenerated types and contract tests; real-model acceptance is pending. |

These are the integration baselines for the published source, not claims about the latest upstream releases. The manifests are [Claude](../packages/adapter-claude/package.json) and [Codex](../packages/adapter-codex/package.json); detailed evidence and limitations are in [SPEC-0002](specs/0002-runtime-adapters.md#compatibility-boundaries-and-sources). Official OpenAI documentation distinguishes [App Server](https://learn.chatgpt.com/docs/app-server) from the [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), and states that generated protocol types are specific to the CLI version used.

Both adapters default to read-only and provide explicit native-session resume and bounded observation/cleanup. Embedded TypeScript can opt into workspace-write with host policy and full-stop observation; JSON CLI providers remain read-only. See [host policy and usage](reference.md#host-policy-and-durable-usage). Unconfirmed owned resources continue to block reconciliation. The optional Claude package loads only for selected Claude execution/inspection; Codex starts an owned local App Server child. A version string alone does not establish runtime acceptance.

Claude records owned ChildProcess handles through the SDK's `spawnClaudeCodeProcess` callback and confirms local cleanup by actual exit. Query.close returning, iterator.return(done:true), or AbortSignal is not exit evidence. The first half of cleanupTimeoutMs lets the SDK clean up; the remaining half observes owned stdin EOF/SIGTERM fallback. Missing/failed close triggers fallback immediately. Pending or invalid returns and an SDK that does not forward the signal do not skip fallback or extend the total asynchronous budget. Unexited resources remain held, and late exit updates evidence; local exit alone does not prove a remote terminal outcome. An injected query factory must launch observable fixtures through `request.options.spawnClaudeCodeProcess({command,args,cwd,env,signal})`; ignoring this callback conservatively retains unknown resources until eligible owner reconciliation. Verification uses real offline subprocesses; real-provider model acceptance is still pending.

The stock configuration has no generic `auth` or gateway/executable abstraction. Credentials and endpoint configuration remain with the selected native runtime or application host; unsupported JSON fields reject. The private orchestration bridge is implemented. Follow [the current integration guide](guide.md) and the [opt-in native plan](acceptance/README.md) for the remaining real-boundary acceptance. Public publication requires separate authorization; this project's license is MIT.
