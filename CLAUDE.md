# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project scope

One Node orchestration engine with thin TypeScript and Python SDKs. The engine exclusively owns SQLite state, scheduling, deadlines, and adapter calls. The SDKs use the shared JSON-RPC contract; they do not implement another scheduler, open the database, or call models themselves.

Implemented scope: SPEC-0001 foundation, SPEC-0003-A lifecycle, and SPEC-0003-A2 execution isolation. Storage schema 2, wire 1.0, event schemaVersion 1. SPEC-0003-B/C retention, GC, archival, and routing are not implemented. Git remote: `git@github.com:GfM-rvP9UN6UDe3W/Multi-Agent.git`. No npm/PyPI packages are published.

## Common commands

```sh
npm ci --ignore-scripts        # Install locked dependencies; no runtime downloads on startup
npm run typecheck              # tsc --noEmit
npm run format:check           # prettier --check; use npx prettier --write <file> when needed
npm test                       # node:test; recorded baseline: 157 tests, about 2 seconds
npm run test:python            # unittest; recorded baseline: 40 tests, about 4 seconds
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

**State changes and events share a transaction.** Use `store.transaction()`. `scheduler()` recomputes A/Q/R from dispatch rows without in-memory counters; do not introduce cached counts when changing scheduling.

**A2 admission.** A counts dispatches holding an execution lease. Q counts dispatches with unknown business outcomes. R reserves capacity for held leases not yet quarantined. Dispatch requires `A < maxActiveSessions` (default 2) and `Q + R < maxQuarantinedDispatches` (default 32). Releasing A does not reduce Q; business reconciliation does. `kick()` scans queued tasks in a microtask. Each in-flight dispatch has an in-memory `Flight` and a durable dispatch row.

**Deadlines.** Dispatch computes a budget from the smaller host timeout and adapter cap. The default total is 1,800 seconds, including initialization and acceptance. Acceptance and output do not extend it. Use monotonic time for enforcement and persisted wall time for diagnostics. `EngineClock` is a test seam accepted only through EngineConfig, not JSON configuration or wire parameters.

**Stop evidence requires special care.** Lease release must pass `stopProof()`: either pre_submission evidence proving no submission, or a terminal certificate plus `terminalCoversExecution` and confirmed local cleanup. Timeout, AbortSignal, interrupt acknowledgement, iterator completion, Promise return, a missing PID, or `hasActiveResources=false` alone are insufficient. Adapters report through `input.reportExecutionEvidence`; cleanup after execute finishes triggers `reevaluateRelease`. A live Flight or true `adapter.hasActiveResources(sessionId)` vetoes release. Contradictory evidence creates persistent execution_conflicts that block dispatch across restarts.

**Adapter contract.** `RuntimeAdapter` in `packages/engine/src/types.ts` requires `capabilities()` to declare `executionBudget={version:2,...}`; otherwise tasks.create fails with UNSUPPORTED_CAPABILITY before persistence. `execute()` produces RuntimeEvent values. Adapters retaining resources after execute must implement `hasActiveResources()`. `engine/src/fake.ts` provides the deterministic offline runtime used by tests.

**SDK parity.** TypeScript Orchestrator wraps both the in-process engine and UnixRpcClient with one API. `python/src/agent_orch/client.py` mirrors it. Wire fields are camelCase; Python converts only known envelope fields to snake_case. Raw JSON such as operation.result retains camelCase, for example `result["executionReleased"]`. API changes must update both SDKs and schemas/protocol.schema.json manually; there is no code generation.

**Relative cross-package imports.** Use paths such as `../../engine/src/types.ts`, not `@agent-orch/*`. npm workspaces create links, but current source imports use relative paths.

## Development constraints

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
| `docs/tdd/*.md` | Observed RED/GREEN evidence for each increment |
| `schemas/protocol.schema.json` | Normative wire data definitions |

AGENT_ORCHESTRATION_DESIGN.md and SDK_USAGE_AND_WIRING.md describe the full product and planned integration. Their auth, executable, MCP bridge, and gateway examples are **not implemented interfaces**; do not present them as current capabilities.
