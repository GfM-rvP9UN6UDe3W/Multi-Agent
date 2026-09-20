# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project scope

One Node orchestration engine with thin TypeScript and Python SDKs. The engine exclusively owns SQLite state, scheduling, deadlines, and adapter calls. The SDKs use the shared JSON-RPC contract; they do not implement another scheduler, open the database, or call models themselves.

Implemented scope: SPEC-0001 foundation, SPEC-0003-A lifecycle, A2 execution isolation, SPEC-0004 scheduling/shutdown/TypeScript request-deadline/Claude cleanup fixes, SPEC-0005 client recovery guidance and wire-snapshot contract tests, SPEC-0006 typed host-runtime contracts and offline conformance, and SPEC-0007 embedded policy/options injection and durable usage replay. Storage schema 2, wire 1.0, event schemaVersion 1. SPEC-0003-B/C retention, GC, archival, and routing are not implemented. Git remote: `git@github.com:masonlee39/Multi-Agent.git`. No npm/PyPI packages are published.

## Common commands

```sh
npm ci --ignore-scripts        # Install locked dependencies; no runtime downloads on startup
npm run typecheck              # tsc --noEmit
npm run format:check           # prettier --check; use npx prettier --write <file> when needed
npm test                       # node:test; engine and protocol contract suites
npm run test:python            # unittest; Python SDK and actual local-host integration
```

Run one file or one matching test:

```sh
node --test tests/engine/lifecycle.test.ts
node --test --test-name-pattern "0003-A05" tests/engine/lifecycle.test.ts
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p 'test_lifecycle.py' -v
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -k disconnected_mutations -v
```

`npm test` includes only `tests/engine/*.test.ts tests/contract/*.test.ts`. Tests in `tests/e2e/` are not discovered. Put new tests in the configured directories or update the package.json glob.

Shared wire, lifecycle, or scheduling changes require both `npm test` and `npm run test:python`, as specified in CONTRIBUTING.

Runnable examples and CLI:

```sh
PYTHONPATH=python/src python3 examples/python/fake_roundtrip.py
node examples/typescript/local.ts "$WORKSPACE" "$STATE_DIR"  # Existing, separate directories
node packages/cli/src/main.ts doctor --config /absolute/orchestrator.json
node packages/cli/src/main.ts host --config /absolute/orchestrator.json
```

Node 22.18+ / Python 3.11+; recorded verification used Node 24.14.0 and Python 3.14.6. The `node:sqlite` experimental warning on stderr is expected.

## Architecture

**Single writer.** `LocalEngine` in `packages/engine/src/index.ts` owns SQLite, scheduling, deadlines, and adapters. Wire methods are dispatched by the switch in `call(method, params, context)`. Adding a method requires a case, validation, specification criteria, and cross-language tests.

**Three entry points, one engine.** In-process `createOrchestrator`; CLI `host --stdio` for a Python-owned child; CLI `host --socket` for a Unix socket. They cannot open the same stateDir concurrently.

**Transport determines ownership.** In `packages/cli/src/host.ts`, stdio connections use `owner=true` and socket connections use `owner=false`. `host.shutdown`, `sessions.reconcile`, and `scheduler.resolveConflict` use this flag to reject ordinary clients with `UNAUTHORIZED`. Permission changes require reviewing both connection construction and the engine's `context.owner` checks.

**Storage.** Business tables in `packages/engine/src/store.ts` use JSON blobs with `(id TEXT PRIMARY KEY, data TEXT)`: tasks, sessions, messages, outbox, approvals, dispatches, artifacts, usage, and execution_conflicts. `operations` adds `UNIQUE(method,scope,key)` for idempotency. Event AUTOINCREMENT rowids become cursors. `BEGIN EXCLUSIVE` on `owner.sqlite` provides the OS-level ownership lock; a second engine receives `HOST_ALREADY_RUNNING`. stateDir must be absolute, mode 0700, and disjoint from workspace after resolving symlinks.

**Durable state changes and events share a transaction.** Use `store.transaction()`. `scheduler()` recomputes A/Q/R from dispatch rows without in-memory counters; do not introduce cached counts. Its canDispatch/reasons also combine this host's closing flag and pendingResourceCleanups memory state (`RESOURCE_CLEANUP_PENDING`). These are not cached A/Q/R counts, and the complete scheduler response is not a pure database snapshot.

**A2 admission.** A counts dispatches holding an execution lease. Q counts dispatches with unknown business outcomes. R reserves capacity for held leases not yet quarantined. Dispatch requires `A < maxActiveSessions` (default 2) and `Q + R < maxQuarantinedDispatches` (default 32). Releasing A does not reduce Q; business reconciliation does. `kick()` scans queued tasks in a microtask. Each in-flight dispatch has an in-memory `Flight` and a durable dispatch row.

**Deadlines.** Dispatch computes a budget from the smaller host timeout and adapter cap. The default total is 1,800 seconds, including initialization and acceptance. Acceptance and output do not extend it. Use monotonic time for enforcement and persisted wall time for diagnostics. `EngineClock` is a test seam accepted only through EngineConfig, not JSON configuration or wire parameters.

**Stop evidence requires special care.** Automatic lease release must pass `stopProof()`: either pre_submission evidence proving no submission, or a terminal certificate plus `terminalCoversExecution` and confirmed local cleanup. Timeout, AbortSignal, interrupt acknowledgement, iterator completion, Promise return, a missing PID, or `hasActiveResources=false` alone are insufficient. Adapters report through `input.reportExecutionEvidence`; cleanup after execute finishes triggers `reevaluateRelease`. A live Flight or true `adapter.hasActiveResources(sessionId)` vetoes automatic release. R04's narrow `prepareUnobservedCleanup` interface handles only an exact target whose observation ended, whose spawn callback is sealed, and for which no process was ever observed. Retire its record only after the attestation transaction commits; do not report fictitious exit evidence. A genuinely live process still rejects owner stop claims. Owner reconcile remains available during incomplete active shutdown, while new work stays closed. Contradictory evidence creates persistent execution_conflicts that block dispatch across restarts.

**Cleanup receipts.** Check the prepare result is a function before committing. After the declaration commits, finalizer failure or failed completion persistence returns RESOURCE_CLEANUP_INCOMPLETE, retaining operationId and a pending receipt and pausing new dispatches on this host. Only an explicit owner retry with the original payload/key continues the original finalizer. If memory cleanup already finished, retry only its durable acknowledgement. A restart that loses the original finalizer retains outcome_unknown; do not prepare again or simulate success. Successful calls return completed, and the resource-completion event is persisted in the acknowledgement transaction.

**Adapter contract.** `RuntimeCapabilities` requires a typed `executionBudget={version:2,...}` with explicit null caps; optional `executionEvidence` is typed version 1. `readRuntimeCapabilities` validates detached immutable JSON snapshots before admission and again before dispatch. Missing/unsupported versions fail with UNSUPPORTED_CAPABILITY; malformed declarations fail with INVALID_RUNTIME_CONTRACT. Each dispatch uses one snapshot, including its permission check and terminal coverage. `execute()` produces RuntimeEvent values. Adapters retaining resources after execute must implement `hasActiveResources()`. Hosted adapters call `requireEngineRuntimeInput` before submission to require the original generation, budget, and evidence callback; standalone `RuntimeInput` stays compatible. This preflight is not authentication. `engine/src/fake.ts` remains the automatic deterministic runtime. Optional `engine/src/testing.ts` and `testing-host.ts` provide controlled-host conformance and an offline example without loading test code into ordinary startup. A passed fixture does not validate a real application's bridge or permission enforcement.

**SDK parity.** TypeScript Orchestrator wraps both the in-process engine and UnixRpcClient with one API. `python/src/agent_orch/client.py` mirrors it. Wire fields are camelCase; Python converts only known envelope fields to snake_case. Raw JSON such as operation.result retains camelCase, for example `result["executionReleased"]`. API changes must update both SDKs and schemas/protocol.schema.json manually; there is no code generation.

**Claude interruption.** SPEC-0008 advertises interrupt support and owns one open AsyncIterable user prompt plus partial-message observation. Defer Query.interrupt until matched main-turn activity; call once, keep observing, and classify only structured aborted_streaming/aborted_tools results as interrupted. Receipt, arbitrary error text, EOF, and process exit do not establish an interrupted terminal. Cleanup and extended-host stop proof remain separate. Late evidence cannot undo an expired control. Never change this into immediate SDK-controller abort on an engine cancellation request.

`tests/contract/protocol-schema.test.ts` validates task, approval, message, usage, operation, and related snapshots from an actual Unix host. A Python subprocess reads the same state to verify field mappings and preservation of raw JSON. The helper supports the schema constraints currently used, rejects unsupported assertion keywords and invalid additionalProperties values, and treats format as annotation. It is not a production validator or complete JSON Schema implementation. Wire extensions require actual payload checks and negative cases, not just assertions that definition names exist.

**Relative cross-package imports.** Use paths such as `../../engine/src/types.ts`, not `@agent-orch/*`. npm workspaces create links, but current source imports use relative paths.

## Development constraints

SPEC-0007 adds `adapter-claude/src/options.ts` for typed native options, reserved ownership fields, permission guards, and write sandbox configuration. `engine/src/stop-observation.ts` bounds host full-stop observations for expanded execution; false/missing/late proof cannot bypass local process evidence or business quarantine. The JSON CLI still disallows write/native callbacks. `engine/src/usage.ts` validates bounded JSON observations; `recordUsage` commits rows with `usage.recorded` atomically, rejects ID conflicts, and retains the original dispatch identity for late callbacks. Both SDKs expose exact-record reads. Keep native hooks/options/private objects out of persistence and wire payloads. Fixture policy mapping does not validate native sandbox enforcement or an application's ledger.

- **TDD is required:** specification and numbered criteria, tests with an observed RED, implementation, then RED/GREEN evidence in docs/tdd. Test names reference acceptance IDs such as AC04 or 0003-A05. Regression coverage for already-correct behavior does not need fabricated RED evidence.
- **Erasable TypeScript only:** no enum, namespace, or parameter properties. With verbatimModuleSyntax, use `import type`; imports include `.ts` extensions.
- **No third-party runtime dependencies:** Python uses the standard library. The optional Claude Agent SDK peer loads dynamically only inside execute.
- **Treat unknown conservatively:** no automatic outcome resolution, resend, retry, or unsupported lease release. Missing usage stays null; do not estimate costs.
- **Reject unsupported capabilities explicitly:** currently sessions.open/fork, compact/rotate/stop, automatic verification, and verificationRules. Do not simulate success.
- **No credentials or real models in ordinary tests:** temporary workspace/stateDir, explicit fake provider, and no default fake configuration. Unix-socket EPERM requires a permitted environment and a rerun, not a passing result.
- Commit, push, and package publication require the user's authorization.
- Write documentation, examples, and source comments in English. Keep intentional multilingual fixtures used to test Unicode behavior.

## Documentation authority

Read the relevant specification before changing behavior. Resolve implementation/specification differences and update them together.

| File | Authority |
| --- | --- |
| `docs/specs/0001-foundation.md` | Wire 1.0 method table, AC01–AC12, baseline snapshot fields |
| `docs/specs/0002-runtime-adapters.md` | Claude/Codex adapter boundaries and acceptance evidence |
| `docs/specs/0003-a-lifecycle.md` | Durable deadlines and owner reconciliation; A2 supersedes its 300-second turn default |
| `docs/specs/0003-a2-execution-isolation.md` | **Current authority:** A/Q/R, 1,800-second budget, leases, evidence, and conflicts |
| `docs/specs/0003-policy-retention-deadlines.md` | Phased plan; B/C criteria are not implemented |
| `docs/specs/0003-b-archive.md` | Archive and namespace transition, not implemented |
| `docs/specs/0004-runtime-reliability.md` | Historical scheduling scans, signal shutdown, TS request deadlines, and Claude exit/cleanup evidence |
| `docs/specs/0005-wire-contract.md` | Client cleanup recovery, real wire snapshots, cross-language mapping, and test-validator boundaries |
| `docs/specs/0006-host-runtime-contract.md` | Typed adapter capabilities, runtime/input preflight, existing-host offline conformance, and process recovery |
| `docs/tdd/*.md` | Observed RED/GREEN evidence for each increment |
| `schemas/protocol.schema.json` | Normative wire data definitions |

AGENT_ORCHESTRATION_DESIGN.md and SDK_USAGE_AND_WIRING.md describe the full product and planned integration. Their auth, executable, MCP bridge, and gateway examples are **not implemented interfaces**; do not present them as current capabilities.
