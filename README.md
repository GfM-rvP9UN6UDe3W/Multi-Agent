# Agent Orchestration SDK

One Node.js orchestration engine, with TypeScript and Python SDKs for local applications that manage tasks, durable messages, session state, and human acceptance.

**This is an unpublished development version. The foundation, SPEC-0003-A lifecycle, A2 execution isolation, SPEC-0004 reliability fixes, and SPEC-0005 wire-contract tests are implemented.** Runnable source and offline fixture verification are available; the complete first-release design is not yet implemented. A2 evidence covers [cross-language integration](docs/tdd/0003-a2-wiring.md), [Claude](docs/tdd/0003-a2-claude.md), and [Codex](docs/tdd/0003-a2-codex.md). Earlier evidence remains in the foundation and A records. Ordinary tests use an explicitly enabled `fake` runtime or protocol fixtures, without model requests or login credentials. The Claude/Codex adapters implement a minimal protocol and bounded resource cleanup; real-model end-to-end acceptance remains unverified.

- [Foundation specification and acceptance criteria](docs/specs/0001-foundation.md)
- [Runtime adapter specification](docs/specs/0002-runtime-adapters.md)
- [Implemented lifecycle contract](docs/specs/0003-a-lifecycle.md)
- [A2 contract: execution occupancy, outcome quarantine, and shared deadlines](docs/specs/0003-a2-execution-isolation.md)
- [Reliability fixes: scheduling, shutdown, request deadlines, and Claude cleanup](docs/specs/0004-runtime-reliability.md)
- [Client recovery and wire-snapshot contracts](docs/specs/0005-wire-contract.md)
- [Archive and namespace-transition specification — not implemented](docs/specs/0003-b-archive.md)
- [Phased specification: A/A2 implemented; B/C retention and routing pending](docs/specs/0003-policy-retention-deadlines.md)
- [TDD evidence](docs/tdd/0001-evidence.md)
- [Contribution guidelines](CONTRIBUTING.md)
- [Full product design](AGENT_ORCHESTRATION_DESIGN.md) and [planned integration guide](SDK_USAGE_AND_WIRING.md)

## Implemented scope

| Component | Current capability |
| --- | --- |
| Single engine | SQLite WAL, OS file lock, persistence for tasks, sessions, operations, messages, events, approvals, and raw usage |
| Scheduling | Explicit provider/model, at most two occupied execution slots, serial execution per session, turn limits; separate accounting for durable leases and bounded business-outcome quarantine |
| Reliable messaging | Durable messages and outbox, idempotency keys, target-generation checks, separate acceptance and completion records |
| Task completion | Persist the result first; human approval is required for completed, and denial produces failed |
| Control and recovery | Durable deadlines, pause/drain, supported interrupt, resume, cancel, and continued shutdown waits; unknown quarantine and owner reconciliation, without automatic resend after crashes or timeouts |
| Scheduler diagnostics | Read-only `scheduler.get/getConflict`; owner-only `scheduler.resolveConflict` for resource conflicts with newly verified evidence |
| TypeScript | In-process `createOrchestrator` or Unix-socket `connectOrchestrator` |
| Python | `Orchestrator.local` owns a Node child process; `Orchestrator.connect` connects to the same shared host |
| Local protocol | JSON-RPC 2.0, stdio/Unix socket, version handshake, 1 MiB frames, 64 pending requests |
| CLI | `host`, `doctor`, `submit`, `status`, and `approve`; other commands are explicitly rejected |

The foundation automatically assigns one logical session to each task. `sessions.open/fork`, compact/rotate/stop, model tool callbacks and the MCP bridge, automatic verification commands, monetary budgets, workspace write locks, and cross-task session reuse are not implemented. The mailbox is currently exposed through the SDK; models cannot yet invoke delegation tools themselves. Human approval is the only implemented acceptance path.

SPEC-0003-A/A2 provide durable execution/control deadlines, late-evidence retention, execution leases, business-outcome quarantine, and owner-only `sessions.reconcile`. contextPlan, retention/GC, deduplication tombstones, storage-pressure protection, cross-task cost rules, and automatic policy selection remain in SPEC-0003-B/C. Long-running operation, capacity failures, and real-model acceptance are not yet validated.

New A2 turns have a default total budget of 1,800 seconds. Proven execution stop and local cleanup may release an unknown dispatch's execution slot while its business outcome remains quarantined: A=`executionOccupied` counts held execution leases; Q=`quarantined` counts unknown business outcomes; R=`quarantineReserved` reserves capacity for unquarantined in-flight execution, including pending cleanup. Dispatch requires `A < maxActiveSessions` and `Q + R < maxQuarantinedDispatches`, with defaults of 2 and 32. Two unknown dispatches that may still be executing occupy both slots. Releasing A does not reduce Q, resume work, resend requests, or approve results.

See the [JSON Schema](schemas/protocol.schema.json) for protocol data structures. [Actual payload contract tests](tests/contract/protocol-schema.test.ts) read task, approval, message, usage, operation, and related snapshots from a real Unix host, validate their constraints and corrupted variants, and compare mappings/raw JSON with a Python subprocess reading the same state. The test helper implements only the currently used constraint subset, rejects unsupported assertions and invalid additionalProperties values, and treats format as annotation. There is no production schema validator or schema-to-SDK code generation. See [scope and acceptance criteria](docs/specs/0005-wire-contract.md).

## Local development and verification

Declared minimums are Node.js 22.18+ and Python 3.11+. Recorded verification used Node.js 24.14.0 and Python 3.14.6. Node's built-in SQLite currently prints an experimental warning to stderr. The minimum-version matrix has not been separately verified.

Run from the repository root:

```sh
npm ci --ignore-scripts
npm run typecheck
npm run format:check
npm test
npm run test:python
```

Tests create and clean up only their own temporary workspaces, databases, sockets, and child processes. Unix-socket tests require local IPC permissions. If a restricted sandbox reports EPERM, rerun in an environment that permits local sockets; a skipped test is not a pass.

Node executes erasable TypeScript source directly. No publishable compiled package exists yet. Installing a provisional package name from npm/PyPI does not reproduce this checkout.

Scheduling reads queued candidates through a SQLite index and refreshes outer admission after an actual dispatch; nonqueued history no longer causes a full dispatch scan per task. Startup rebuilds task-state and dispatch-taskId indexes in existing schema 2 stores without changing business records. A/Q/R still come from durable dispatch records, and some historical queries retain linear cost. GC/archival remain unimplemented. Run `node tests/fixtures/scheduler-benchmark.ts . 50,100,150,300` to reproduce offline creation-latency samples; see [evidence and limits](docs/tdd/0004-runtime-reliability.md).

## Run the complete Python example

```sh
PYTHONPATH=python/src python3 examples/python/fake_roundtrip.py
```

The example starts a real Node stdio host, creates a fake task, reads the approval request, approves only predetermined fixture evidence, waits for completed, and then shuts down and cleans up its temporary files. This automatic decision is specific to a known fake fixture; it is not a general approval policy for real agents.

Python has no third-party runtime dependencies. See the [Python README](python/README.md) for virtual-environment installation and additional API examples.

## Embedded TypeScript

Create separate temporary directories, then run the interactive example:

```sh
DEMO_ROOT="$(python3 -c 'import pathlib,tempfile; print(pathlib.Path(tempfile.mkdtemp(prefix="agent-orch-demo-")).resolve())')"
mkdir -p "$DEMO_ROOT/workspace" "$DEMO_ROOT/state"
node examples/typescript/local.ts "$DEMO_ROOT/workspace" "$DEMO_ROOT/state"
```

Enter `approve` or `deny` after inspecting the fixture result. Other input leaves the task pending. The example preserves the supplied state directory so you can inspect restart behavior; decide whether to retain it after the engine stops. Source entry points:

```ts
import { createOrchestrator } from './packages/sdk-typescript/src/index.ts';
import { createFakeAdapter } from './packages/engine/src/fake.ts';

const orch = await createOrchestrator({
  workspace: '/absolute/existing/workspace',
  stateDir: '/absolute/private/state-outside-workspace',
  adapters: [createFakeAdapter()],
  providers: { fake: { model: 'fake-model' } },
  limits: { maxActiveSessions: 2, maxTurnsPerTask: 20, maxQuarantinedDispatches: 32 },
});
```

This snippet only creates the orchestrator. The complete example handles approval and shutdown. A timeout or cancellation of `task.wait({timeoutMs, signal})` stops only the local wait; remote cancellation requires an explicit `tasks.cancel`. Inspect and resolve paused/blocked states rather than waiting indefinitely for completion.

## Standalone host and cross-language integration

```text
TS application ── in-process SDK ─────────────────────────┐
                                                         ↓
Python SDK ── stdio ── Node child process ── shared engine ── SQLite/events/mailbox
                                                         ↑
TS / Python SDK ── Unix socket ── standalone Node host
                                                         ↓
                                     fake or an explicitly selected adapter
```

Embedded operation, an owned child process, and a standalone host are three alternatives; they must not each open the same stateDir. The shared host owns scheduling. A connected client's `close()` disconnects that client without shutting down the host.

The following fake configuration is **currently supported**. Replace the three absolute paths. The CLI requires existing workspace/stateDir directories without symlinks. Place the socket in a private directory owned exclusively by the current user, avoiding connection races in shared directories.

```json
{
  "configVersion": 1,
  "workspace": "/absolute/workspace",
  "stateDir": "/absolute/private-state",
  "transport": { "mode": "unix", "socketPath": "/absolute/private-state/host.sock" },
  "providers": { "fake": { "model": "fake-model", "permissionProfile": "read-only", "delayMs": 20 } },
  "limits": { "maxActiveSessions": 2, "maxTurnsPerTask": 20, "maxQuarantinedDispatches": 32 },
  "timeouts": { "acceptanceMs": 30000, "turnMs": 1800000, "drainMs": 300000, "interruptMs": 30000, "reconcileMs": 60000 }
}
```

Omit `timeouts` or override individual fields. The example shows all five defaults, each an integer from 1 to 86400000 milliseconds. Embedded TypeScript uses the same configuration object. Python owners write this configuration to JSON and pass it through `engine_command=[node, cli, "host", "--stdio", "--config", config_file]`; there is no `Orchestrator.local(timeouts=...)` parameter. SDK wait limits are independent of execution deadlines. Retries and restarts do not refresh existing deadlines.

The total deadline begins at dispatch and includes initialization and acceptance. Acceptance and output do not extend it. Explicit Claude/Codex `requestTimeoutMs` and `turnTimeoutMs` values can shorten the host budget but cannot extend it. Independent cleanup uses Claude `cleanupTimeoutMs` and Codex `closeTimeoutMs`; these names are not interchangeable. The CLI accepts these provider settings as integers from 1 to 3600000 milliseconds. `maxQuarantinedDispatches` must be an integer from 1 to 1024 and at least the effective `maxActiveSessions`. Lowering a limit does not delete history; excess occupancy blocks new work.

`scheduler.get()` returns A/Q/R, effective limits, `canDispatch`, reasons, and up to 16 occupancy/conflict references. Optional `execution` in `sessions.get()` reports leases, quarantine, and budget boundaries/sources. Both SDKs can read these over an ordinary socket. They require the exact capability `executionIsolation={version:1,resourceRelease:true,schedulerStatus:true,ownerConflictResolution:true,budgetVersion:2}`; an older host without it is rejected with `UNSUPPORTED_CAPABILITY` before sending. See the [scheduler and owner-conflict examples](SDK_USAGE_AND_WIRING.md#115-implemented-scheduler-queries-and-resource-conflicts) for fields and permissions.

Storage schema is currently 2, wire protocol remains 1.0, and event schemaVersion remains 1. Before opening schema 1 state, the host creates and verifies a same-directory `store-schema1-<uuid>.sqlite` backup, then upgrades transactionally. Failure prevents model submission. Older records without leases recover conservatively; existing deadlines remain unchanged. Older hosts cannot open schema 2. Restoring a backup does not undo later side effects and must not be used to replay work. Custom adapters must implement `executionBudget.version=2`, use `null` for unspecified provider caps, and honor the remaining monotonic budget. Missing capability prevents task creation/dispatch. Follow the A2 evidence/notification contract; a capability declaration alone does not prove safe release.

```sh
node packages/cli/src/main.ts doctor --config /absolute/orchestrator.json
node packages/cli/src/main.ts host --config /absolute/orchestrator.json
```

`doctor --config` currently validates configuration only. Its `configuration-only` result does not establish dependency, runtime, or model availability. `doctor --socket` verifies only the running host's handshake. `--stdio` opens no application socket and reserves stdout for protocol frames.

Client examples:

```ts
import { connectOrchestrator } from './packages/sdk-typescript/src/index.ts';
const orch = await connectOrchestrator({
  socketPath: '/absolute/private-state/host.sock',
  requestTimeoutMs: 30_000,
});
```

Ordinary TypeScript Unix RPC requests default to 30 seconds, matching Python's default request wait; configure this with `requestTimeoutMs`. The connection option `timeoutMs` only controls connection establishment, and initialize has a separate five-second limit. Read/mutation options `{timeoutMs, signal}` override one request, for example `orch.tasks.get(taskId, {timeoutMs: 5000})`. Connection/default/request limits are integer milliseconds in 1..2147483647. Mutation timeouts retain method/scope/idempotencyKey for receipt lookup. Timeout does not cancel a remote task or close a healthy connection. Explicit task.wait total budgets remain independent; owner close allows its shutdown budget plus 1000ms for the RPC receipt.

```python
from agent_orch import Orchestrator

async with Orchestrator.connect(socket_path="/absolute/private-state/host.sock") as orch:
    current = await orch.tasks.get(task_id)
```

Run `node packages/cli/src/main.ts --help` for submission, status, and approval arguments. The CLI does not approve automatically or enable fake by default. SIGINT/SIGTERM follow host shutdown procedures and clean up only owned processes.

CLI configuration `"shutdown": {"mode": "drain", "timeoutMs": 30000}` controls SIGINT/SIGTERM handling for both Unix and stdio hosts. Without configuration, preserve interrupt/1000ms for Unix and interrupt/30000ms for stdio. An incomplete shutdown reports `SHUTDOWN_INCOMPLETE` and operationId on stderr, retaining the control endpoint. Send another signal to continue the same mode, or let the stdio owner call `host.shutdown.continue`. Drain does not automatically escalate to interrupt. Unexpected parent EOF on stdio separately uses bounded 30000ms interrupt cleanup.

## Handling results and failures

- Full long outputs are stored at `stateDir/artifacts/<sha256>.txt`. Snapshot result and approval summary use an explicitly marked preview with artifactRefs beyond 64 KiB. Inspect the complete artifact before approving it. Event replay is bounded by count and encoded bytes.
- A creation receipt confirms persistence. `runtime_accepted` confirms upstream acceptance evidence. Message completed means that delivery batch finished; only task.completed means the deliverable passed acceptance.
- Idempotency scopes: `local` for tasks.create; taskId for task control; target sessionId for session control and messages; approvalId for approvals; conflictId for scheduler.resolveConflict. Recover a lost receipt with `operations.lookup({method,scope,idempotencyKey})`; do not resend blindly with a new key.
- Save each event cursor with its storeId. `events()` uses bounded read-only polling, never model requests or unbounded buffering for slow consumers. A nonzero cursor without the matching storeId is rejected.
- `SHUTDOWN_INCOMPLETE` retains the client and operationId. Continue drain or explicitly request interrupt until shutdown is confirmed. A shutdown error must not hide the original application error or Python cancellation.
- Restart does not automatically resume tasks. Unresolved running/dispatching work becomes blocked/outcome_unknown. Timeouts and late results do not clear quarantine automatically. Use owner reconciliation below rather than editing the database.
- Missing usage fields remain null. Do not estimate costs or claim cache hits/cost reductions without evidence. There are no paid heartbeats or additional management LLMs.

`sessions.reconcile(target, evidence, options)` accepts human attestation only from an embedded TypeScript owner or a Python-owned stdio host. Ordinary socket clients receive `UNAUTHORIZED`. The SDK first negotiates `initialize.capabilities.lifecycle={version:1,reconcile:"owner-attestation",durableDeadlines:true}` and rejects older hosts without it. The endpoint does not inspect upstream history or establish external side effects on the owner's behalf.

Attestation records local resources, remote execution, and side effects separately. When both execution sides are stopped and there are no active handles or evidence conflicts, it may release only the execution lease: `result.executionReleased=true`, `result.resolved=false`. If business outcome/sideEffects remain unknown, Q, blocked state, and the original activeDispatchId remain. Python operation.result is raw JSON; use `["executionReleased"]`. A confirmed completed outcome saves the result and leaves the task paused; explicit resume only requests acceptance again. Only confirmed not_executed permits explicit requeueing. failed/interrupted make the original task failed. Earlier unknown operations retain their history and gain resolution references. See the [cross-language reconciliation examples](SDK_USAGE_AND_WIRING.md#114-implemented-owner-attestation) for exact targets and keys.

An owner can also settle Claude records with no observed spawn, but only after execution observation ends, the spawn callback is sealed, and no process was ever observed. With an exact target and `localResources: "stopped"`, the host first commits the attestation and cleanup-preparation receipt, then retires the matching record. Successful acknowledgement emits `session.resources_reconciled` and sets `unobservedResourcesReconciled: true`. This is not observed exit evidence; unknown remote execution still prevents lease release. Live processes, stale targets, conflicts, and ordinary socket clients remain rejected. Reconcile remains available after active owner shutdown reports SHUTDOWN_INCOMPLETE, followed by continuation using the original shutdown operationId; task creation, execution resume, and message dispatch stay closed.

A third-party adapter whose prepare returns a non-function or throws is rejected before commit with `INVALID_RUNTIME_CONTRACT`. If its finalizer fails after attestation commits, `RESOURCE_CLEANUP_INCOMPLETE` carries operationId and `auditCommitted: true`. Inspect `result.resourceCleanup.status`, then explicitly retry reconcile with the original target, evidence, and idempotency key. get/lookup/wait only read receipts; waiting on persisted alone reaches the local timeout. While pending, `RESOURCE_CLEANUP_PENDING` blocks new dispatches on this host; successful acknowledgement resumes dispatch without automatic retry. If memory cleanup succeeded but acknowledgement failed, retry only persistence. After restart loses the original finalizer, retain outcome_unknown instead of substituting a new adapter. A committed declaration and a retired resource record are separate states.

Matching contradictory evidence for released execution creates `EXECUTION_EVIDENCE_CONFLICT`, persistently blocking new dispatches across restarts. The owner reads conflictId/revision through `scheduler.getConflict`, then submits newly verified stop evidence through `scheduler.resolveConflict`. This does not rewrite acceptance history or automatically reduce Q. Ordinary socket clients cannot resolve conflicts, and each conflict must be handled separately.

## Claude/Codex integration status and version baselines

| Runtime | Integration used by this repository | Version baseline | Verified boundary |
| --- | --- | --- | --- |
| Claude | Optional `@anthropic-ai/claude-agent-sdk` peer dependency; `query()` and native session resume | **0.3.241 is the declared minimum**; package range **`>=0.3.241 <1`**. No exact installed SDK version is locked. | Offline SDK-message fixtures, observed local fixture-process exits, and lifecycle tests. The range is an installation constraint, not proof that every release works. Real SDK/model end-to-end acceptance is pending. |
| Codex | Managed **`codex app-server`** subprocess; stdio JSONL and App Server **v2** types. The adapter does **not** import `@openai/codex-sdk`. | **`codex-cli 0.153.4`** was used for the recorded protocol-type comparison and offline launch-option checks. | v2 types generated by that CLI, configuration preflight, and actual offline subprocess fixtures. Other CLI versions require regenerated types and contract tests; real-model acceptance is pending. |

These are the integration baselines for the published source, not claims about the latest upstream releases. The manifests are [Claude](packages/adapter-claude/package.json) and [Codex](packages/adapter-codex/package.json); detailed evidence and limitations are in [SPEC-0002](docs/specs/0002-runtime-adapters.md#compatibility-boundaries-and-sources). Official OpenAI documentation distinguishes [App Server](https://learn.chatgpt.com/docs/app-server) from the [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), and states that generated protocol types are specific to the CLI version used.

Both adapters provide a read-only single-turn entry point, explicit native-session resume, and bounded observation/cleanup. Unconfirmed owned resources continue to block reconciliation. The optional Claude package loads only during execute; Codex starts an owned local App Server child. A version string alone does not establish runtime acceptance.

Claude records owned ChildProcess handles through the SDK's `spawnClaudeCodeProcess` callback and confirms local cleanup by actual exit. Query.close returning, iterator.return(done:true), or AbortSignal is not exit evidence. The first half of cleanupTimeoutMs lets the SDK clean up; the remaining half observes owned stdin EOF/SIGTERM fallback. Missing/failed close triggers fallback immediately. Pending or invalid returns and an SDK that does not forward the signal do not skip fallback or extend the total asynchronous budget. Unexited resources remain held, and late exit updates evidence; local exit alone does not prove a remote terminal outcome. An injected query factory must launch observable fixtures through `request.options.spawnClaudeCodeProcess({command,args,cwd,env,signal})`; ignoring this callback conservatively retains unknown resources until eligible owner reconciliation. Verification uses real offline subprocesses; real-provider model acceptance is still pending.

The full integration design's `auth`, `executable`, MCP bridge, and gateway examples are not the current CLI's complete implemented interface. Unsupported fields are rejected. Future changes must update the specification, configuration validation, both SDK contracts, and documentation together. Real-model acceptance, package publication, and license selection remain separate work items.
