# Agent Orchestration SDK

One Node.js orchestration engine, with TypeScript and Python SDKs for local applications that manage tasks, durable messages, session state, and human acceptance.

Licensed under the [MIT License](LICENSE). Commercial use, modification and redistribution are permitted with the copyright and license notice preserved. Third-party SDKs and native executables retain their own licenses.

**The five npm packages are ESM-only; direct `require()` is not exported.** Host-side single-file CJS and ESM bundles are supported through the [bundled-host integration contract](docs/acceptance/bundled-host.md). A Claude consumer installs **`@agent-orch/sdk` + `@agent-orch/engine` + `@agent-orch/adapter-claude`**. The SDK alone does not install a provider. The other packages are `@agent-orch/adapter-codex` and `@agent-orch/cli`. Local RC tarballs and their SHA-256 manifest can be installed without public npm publication.

**Development packages; not published to npm or PyPI.** SPEC-0001–0012 cover storage, routing, accounting, bundled-host delivery, client-pause precedence and scoped tool queries. SPEC-0012 runtime source `9ce65e4` and test-harness follow-ups through `4ff806c` pass **442 Node tests and 49 Python tests**, with no skipped tests; nine package-installation/bundle modes also pass. The selected Ubuntu Node 24 job passed **10/10** sequential samples on exact source `4ff806c`, and all 60 jobs across those workflows succeeded. See the [completion matrix](docs/specs/0009-complete-design.md#completion-matrix), [original implementation evidence](docs/tdd/0009-complete-design.md), [RC/bundle verification evidence](docs/tdd/0010-bundled-host-delivery.md), [release-readiness evidence](docs/tdd/0011-release-readiness.md), [current fix evidence](docs/tdd/0012-tool-control-and-capacity.md), and [exact CI record](docs/tdd/0012-ci.json). Real Claude/Codex binaries also pass tools, approval, saved-history fork/reuse/compact and both-client checks against a scripted loopback gateway on Ubuntu and macOS. See the [remaining-gate ledger](docs/acceptance/readiness.md). Real-model acceptance, actual OS sandbox enforcement, external application integration, economic benefit and registry publication remain unverified boundaries. Ordinary tests use explicit fake runtimes or owned protocol fixtures without login credentials or model requests.

## Install and integrate

Choose packages for the process that will own or connect to the engine:

| Package | Role | When needed |
| --- | --- | --- |
| `@agent-orch/sdk` | TypeScript application API | TypeScript consumers |
| `@agent-orch/engine` | Shared scheduler, storage and runtime contracts | Engine owners; also an SDK dependency |
| `@agent-orch/adapter-claude` | Claude runtime adapter | Claude execution |
| `@agent-orch/adapter-codex` | Codex App Server adapter | Codex execution |
| `@agent-orch/cli` | Standalone/managed Node host and commands | CLI or Python-owned host operation |

Use local tarballs from one candidate version. The evidence-complete committed-source handoff is `0.1.0-rc.7` (Python `0.1.0rc7`). The immutable rc.5 and rc.6 files retain their original provenance and are not reused for this handoff. To reproduce rc.7 in a fresh artifact directory:

```sh
npm ci --ignore-scripts
npm run build:packages -- dist/release/0.1.0-rc.7 --version 0.1.0-rc.7
/absolute/build-env/bin/python scripts/build-python.py dist/release/0.1.0-rc.7 --version 0.1.0-rc.7
```

This candidate is local and unpublished. The builds write five npm tarballs, a Python wheel/sdist and SHA-256 manifests. Existing candidate directories are immutable; use a new version for changed bytes. Verify hashes before installation. In the consuming project, install the three Claude packages together, substituting the absolute artifact directory:

```sh
npm install /absolute/rc/agent-orch-sdk-0.1.0-rc.7.tgz \
  /absolute/rc/agent-orch-engine-0.1.0-rc.7.tgz \
  /absolute/rc/agent-orch-adapter-claude-0.1.0-rc.7.tgz
```

Keep the generated npm lockfile. Install the Codex adapter instead for Codex execution; add the CLI when running a separate Node host. Python installs its wheel separately and connects to that Node host; the Python package does not bundle or download an engine.

The delivered `0.1.0-rc.1` artifacts predate the MIT decision and retain their original `UNLICENSED` metadata. Current source and future builds use MIT. Existing candidate files are immutable; use a new version for a new delivery.

### Claude in a bundled application

The host owns its pinned Claude SDK and native executable. When supplying `config.query`, also supply a matching `createMcpServer` callback if orchestration tools are enabled, and `inspectSession` if native history inspection is required. Missing MCP binding fails before submission; missing inspection binding reports `unavailable`. The adapter does not silently resolve another SDK for an injected host.

Public helpers `createClaudeMcpServer(tools, { sdk, zod })` and `inspectClaudeSession(input, sdk)` bind those operations to the host's dependencies. Default Node loading requires the optional native SDK and **Zod 4.4.3** peer. Native enumeration exposed an incompatibility between SDK 0.3.274 and Zod 4.6.5; widening this tested pairing requires repeating tools/list and real-binary checks. See the [complete host-injection example](docs/acceptance/bundled-host.md#host-owned-claude-sdk).

Package exports are ESM-only. The package smoke verifies CJS and ESM single-file hosts after removing node_modules and moving each executable into a separate deployment directory. Its CJS configuration adapts `import.meta.url` only in the third-party Claude SDK; see the [exact bundle configuration](scripts/package-bundles-smoke.mjs). Actual Axion Vite/Electron 43.2.0 / Node 24.18 acceptance remains pending.

## Documentation

- [Foundation specification and acceptance criteria](docs/specs/0001-foundation.md)
- [Runtime adapter specification](docs/specs/0002-runtime-adapters.md)
- [Implemented lifecycle contract](docs/specs/0003-a-lifecycle.md)
- [A2 contract: execution occupancy, outcome quarantine, and shared deadlines](docs/specs/0003-a2-execution-isolation.md)
- [Reliability fixes: scheduling, shutdown, request deadlines, and Claude cleanup](docs/specs/0004-runtime-reliability.md)
- [Client recovery and wire-snapshot contracts](docs/specs/0005-wire-contract.md)
- [Host runtime contract and offline conformance](docs/specs/0006-host-runtime-contract.md)
- [Embedded host policy and durable usage replay](docs/specs/0007-host-policy-and-usage.md)
- [Archive and namespace-transition contract](docs/specs/0003-b-archive.md)
- [Lifecycle, storage and routing contracts](docs/specs/0003-policy-retention-deadlines.md)
- [Design completion specification](docs/specs/0009-complete-design.md)
- [Bundled-host delivery specification](docs/specs/0010-bundled-host-delivery.md)
- [Release-readiness fixes and native verification](docs/specs/0011-release-readiness.md)
- [Client-pause precedence and scoped capacity](docs/specs/0012-tool-control-and-capacity.md)
- [Optional routing layer with pluggable judges, including TypeSafe Jev](docs/specs/0018-routing-layer.md)
- [Current acceptance gates](docs/acceptance/readiness.md)
- [TDD evidence](docs/tdd/0001-evidence.md)
- [Contribution guidelines](CONTRIBUTING.md)
- [Full product design](AGENT_ORCHESTRATION_DESIGN.md) and [integration guide](SDK_USAGE_AND_WIRING.md)

## Implemented scope

| Component | Current capability |
| --- | --- |
| Single engine | SQLite WAL, exclusive writer, durable task/session/operation/message/approval/event/usage state; schema 3 |
| Scheduling | Dependencies, finite reuse queues, per-session single flight, overlapping write-scope exclusion, A/Q/R isolation, turn/delegation/message limits |
| Sessions | Logical open, serial reuse, checkpoint-bound native fork, observed compaction, generation rotation, pause/resume/stop and owner reconciliation |
| Model tools | Owner-enabled work_delegate, work_send, work_read, work_control; private Claude MCP and Codex stdio bridge with dispatch-bound authorization |
| Acceptance | Human result review or frozen registered verification commands; separate expiring runtime-permission approval |
| Accounting | Exact registered-price estimates, direct/tree/overhead cost views, dispatch reservations, late usage and explicit unknown coverage |
| Storage | Protected bounded GC, lifetime tombstones, leased paged snapshots, backpressure, settlement reserve, verified backups and phased archive/namespace rollover |
| TypeScript | Embedded owner or Unix-socket client; generated wire types and bounded schema validator |
| Python | Standard-library async client; owned Node stdio host or Unix connection; equivalent methods, generated wire types and validator |
| Local protocol | Wire 2.0, immutable expectedStoreId on mutations, JSON-RPC 2.0, 1 MiB frames; per-connection and host-wide resource limits |
| CLI | host, doctor, submit, run, attach, status, approve, control; private tool-bridge |
| Delivery | Five local npm tarballs, Python wheel/sdist, clean-install smoke script, configured macOS/Linux version matrix |
| Routing layer | Optional SDK layer, `@agent-orch/sdk/routing` and `agent_orch.routing`: a judge you choose, such as the built-in TypeSafe Jev adapter, proposes which agent in a group takes a request and which results it carries; the engine validates and executes the declaration |

The owner enables model tools with `tools: { enabled: true }` and runtime permission requests with `runtimeApprovals: { enabled: true }`. Defaults preserve the smaller tool surface. The engine does not infer task independence from prose or select an economic routing strategy automatically; the optional [routing layer](#routing-layer-optional) can propose declarations with a judge the application chooses. `contextPlan` declares fresh/reuse/fork or in-turn continuation intent. Fork preparation returns a logical receipt; native forking happens on first use and must produce a distinct native ID. Checks execute trusted owner-registered commands and detect changed baselines; this is not an OS isolation boundary for arbitrary executables.

New A2 turns have a default total budget of 1,800 seconds. Proven execution stop and local cleanup may release an unknown dispatch's execution slot while its business outcome remains quarantined: A=`executionOccupied` counts held execution leases; Q=`quarantined` counts unknown business outcomes; R=`quarantineReserved` reserves capacity for unquarantined in-flight execution, including pending cleanup. Dispatch requires `A < maxActiveSessions` and `Q + R < maxQuarantinedDispatches`, with defaults of 2 and 32. Two unknown dispatches that may still be executing occupy both slots. Releasing A does not reduce Q, resume work, resend requests, or approve results.

See the [JSON Schema](schemas/protocol.schema.json), generated TypeScript `WireTypes`, Python `wire_types`, and `validateWire` / `validate_wire`. Generation is deterministic and checked by `npm run check:generated`. The production validators support the audited schema subset used here, fail on unsupported assertions and treat format as annotation; they are not general-purpose JSON Schema implementations. [Actual payload tests](tests/contract/protocol-schema.test.ts) and [generated-contract tests](tests/contract/generated-wire.test.ts) exercise both languages against real hosts.

## Local development and verification

Declared minimums are Node.js 22.18+ and Python 3.11+. Recorded local verification used Node.js 22.18.0 and 24.14.0, and Python 3.14.6. Node's built-in SQLite prints an experimental warning on that verified runtime. The [CI matrix](.github/workflows/offline.yml) configures macOS/Linux and minimum/current runtime jobs. Exact source `4ff806c` passed the selected Ubuntu Node 24 contract/package/capacity job ten consecutive times, from [run 35572905203](https://github.com/masonlee39/Multi-Agent/actions/runs/35572905203) through [run 35575180837](https://github.com/masonlee39/Multi-Agent/actions/runs/35575180837); every six-job workflow passed in full. See the [recorded SPEC-0012 CI evidence](docs/tdd/0012-ci.json).

Run from the repository root:

```sh
npm ci --ignore-scripts
npm run check:generated
npm run typecheck
npm run format:check
npm test
npm run test:python
```

Tests create and clean up only their own temporary workspaces, databases, sockets, and child processes. Unix-socket tests require local IPC permissions. If a restricted sandbox reports EPERM, rerun in an environment that permits local sockets; a skipped test is not a pass.

Node executes erasable TypeScript source directly. Distribution builds emit JavaScript and declarations, rewrite package boundaries, and include generated schemas. Install the local artifacts; nothing has been published to npm/PyPI.

```sh
npm run build:packages
# Use an isolated Python build environment with setuptools >=77.0.3, wheel and build.
python scripts/build-python.py dist/release
PACKAGE_BUILD_PYTHON="$(command -v python)" npm run test:packages
```

The package smoke creates fresh temporary npm installations and a Python venv, runs embedded TS and owned-host Python, checks each optional adapter independently, exercises the packaged Codex MCP bridge and actual Claude SDK MCP transport, rebuilds the sdist and repeats the Python round trip without network access. It also bundles SDK + engine + Claude adapter as CJS and ESM, deletes the temporary node_modules, and runs fixture tasks through human approval in both formats. `PACKAGE_BUILD_PYTHON` must point to the prepared build environment to include the sdist rebuild. Native provider dependencies are optional and are not downloaded at ordinary startup. See [acceptance instructions](docs/acceptance/README.md) and [local RC installation](docs/acceptance/bundled-host.md).

Scheduling uses indexed queued tasks, active dispatches and parent-scoped tool subtrees. The programmatic engine defaults to **10,000 persisted logical sessions** (`limits.maxLogicalSessions`); after that, opening another session or creating a task that needs one fails with `SESSION_CAPACITY_EXHAUSTED`. An owner can set the limit as high as 100,000 after sizing the store, or settle and roll over to a new store. Retained sessions are not removed by routine GC. The CLI config accepts the same explicit limit.

Run `npm run benchmark:capacity -- 1000,10000,50000 100` for bounded offline measurements. This script explicitly sets `maxLogicalSessions: 100000` to seed 50,000 historical sessions; the 50k row is **not** a default-configuration result. On the recorded Apple M5 Pro / Node 24.14.0 host, earlier admission p95 was 6.13 / 8.68 / 16.77 ms. With indexed subtree lookup, 20 bound `work_read` calls per row averaged 0.46 / 0.55 / 0.64 ms. See [current raw measurements](docs/tdd/0012-capacity.json), [earlier measurements](docs/tdd/0011-capacity.json), and the [measurement limits](docs/acceptance/readiness.md). Retained history still affects some storage/accounting queries, so these numbers are not an unlimited-capacity claim.

## Run the complete Python example

Both languages also have matching offline checks/dependency/snapshot examples:

```sh
node examples/typescript/checks-and-dependencies.ts
PYTHONPATH=python/src python3 examples/python/checks_and_dependencies.py
```

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

Enter `approve` or `deny` after inspecting the fixture result. Other input leaves the task pending. The example preserves the supplied state directory so you can inspect restart behavior; decide whether to retain it after the engine stops. Applications using installed packages import their public entry points:

```ts
import { createOrchestrator } from '@agent-orch/sdk';
import { createFakeAdapter } from '@agent-orch/engine/fake';

const orch = await createOrchestrator({
  workspace: '/absolute/existing/workspace',
  stateDir: '/absolute/private/state-outside-workspace',
  adapters: [createFakeAdapter()],
  providers: { fake: { model: 'fake-model' } },
  limits: { maxActiveSessions: 2, maxTurnsPerTask: 20, maxQuarantinedDispatches: 32 },
});
```

This snippet only creates the orchestrator with an explicit offline fake adapter. The complete repository example uses source imports and handles task creation, approval and shutdown. A timeout or cancellation of `task.wait({timeoutMs, signal})` stops only the local wait; remote cancellation requires an explicit `tasks.cancel`. Inspect and resolve paused/blocked states rather than waiting indefinitely for completion.

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

The total deadline begins at dispatch and includes initialization and acceptance. Acceptance and output do not extend it. Explicit Claude/Codex `requestTimeoutMs` and `turnTimeoutMs` values can shorten the host budget but cannot extend it. Independent cleanup uses Claude `cleanupTimeoutMs` and Codex `closeTimeoutMs`; these names are not interchangeable. The CLI accepts these provider settings as integers from 1 to 3600000 milliseconds. `maxActiveSessions` must be an integer from 1 to 8. `maxQuarantinedDispatches` must be an integer from 1 to 1024 and at least the effective `maxActiveSessions`. Lowering a limit does not delete history; excess occupancy blocks new work.

`scheduler.get()` returns A/Q/R, effective limits, `canDispatch`, reasons, and up to 16 occupancy/conflict references. Optional `execution` in `sessions.get()` reports leases, quarantine, and budget boundaries/sources. Both SDKs can read these over an ordinary socket. They require the exact capability `executionIsolation={version:1,resourceRelease:true,schedulerStatus:true,ownerConflictResolution:true,budgetVersion:2}`; an older host without it is rejected with `UNSUPPORTED_CAPABILITY` before sending. See the [scheduler and owner-conflict examples](SDK_USAGE_AND_WIRING.md#115-implemented-scheduler-queries-and-resource-conflicts) for fields and permissions.

Storage schema is **3**, wire protocol **2.0**, and event schemaVersion remains **1**. Before upgrading schema 1/2, the host verifies a recovery SQLite backup and a complete bundle of retained artifacts and managed native history. Migration failure prevents dispatch; existing deadlines remain unchanged. Wire 1.0 is rejected. Every mutation retains a versioned `(storeId, method, scope, idempotencyKey, digest)` identity; reconnecting or refreshing the handshake cannot substitute a new store for an old retry. Custom adapters still require executionBudget version 2 and the existing stop-evidence contract.

Owner-configured `stores: { controlDir, storesRoot, archiveRoot }` enables backups and rollover. These canonical private directories must be outside the workspace. Rollover refuses unfinished tasks, unknowns, resources, controls, messages, approvals and snapshot leases; it preserves the old directory and creates a fresh namespace without executable task copies. Import gives the backup a new identity and quarantines unfinished work for explicit owner review. Use public APIs, never restore an old manifest or copy an old SQLite file over live state.

Default retention is 30 days for events, 90 for terminal details, 180 for raw usage; references and pins override age. GC processes at most 500 records / 8 MiB per batch with a 50 ms target. Artifact payload bytes count; a single oversized artifact is reported in `oversizedArtifacts` and retained for explicit archive/capacity handling. No unbounded automatic deletion is used. Snapshot leases last 60 seconds and cannot be extended by clock rollback. Quota defaults (10 GiB, warning at 80%, admission backpressure at 90%, 1 GiB minimum free space, 256 MiB emergency reserve, one million minimal records) are policy limits, not tested production capacity. Configure smaller reserves explicitly for fixtures.

```sh
node packages/cli/src/main.ts doctor --config /absolute/orchestrator.json
node packages/cli/src/main.ts host --config /absolute/orchestrator.json
```

`doctor --config` checks configuration, Node/SQLite, directory access and selected native dependency/CLI versions without reading login credentials or calling models. Its `offline-preflight` result is not authentication, sandbox or model acceptance. `doctor --socket` verifies only the running host's handshake. `--stdio` opens no application socket and reserves stdout for protocol frames.

Client examples:

```ts
import { connectOrchestrator } from '@agent-orch/sdk';
const orch = await connectOrchestrator({
  socketPath: '/absolute/private-state/host.sock',
  requestTimeoutMs: 30_000,
});
```

Ordinary TypeScript Unix RPC requests default to 30 seconds, matching Python's default request wait; configure this with `requestTimeoutMs`. The connection option `timeoutMs` only controls connection establishment, and initialize has a separate five-second limit. Read/mutation options `{timeoutMs, signal}` override one request, for example `orch.tasks.get(taskId, {timeoutMs: 5000})`. Connection/default/request limits are integer milliseconds in 1..2147483647. Mutation timeouts retain the complete immutable retry identity for receipt lookup. Timeout does not cancel a remote task or close a healthy connection. Explicit task.wait total budgets remain independent; owner close allows its shutdown budget plus 1000ms for the RPC receipt.

```python
from agent_orch import Orchestrator

async with Orchestrator.connect(socket_path="/absolute/private-state/host.sock") as orch:
    current = await orch.tasks.get(task_id)
```

Run `node packages/cli/src/main.ts --help` for all commands. `run` submits and observes; `attach` observes an existing task. Both detach on approval/blocked/paused states by default. `--interactive` requires a TTY and explicit approve/deny; `--follow` keeps observing. Ctrl-C or an observation timeout detaches the client. `control` requires an exact saved session target JSON and returns a durable operation receipt. The CLI does not approve automatically or enable fake by default. SIGINT/SIGTERM follow host shutdown procedures and clean up only owned processes.

CLI configuration `"shutdown": {"mode": "drain", "timeoutMs": 30000}` controls SIGINT/SIGTERM handling for both Unix and stdio hosts. Without configuration, preserve interrupt/1000ms for Unix and interrupt/30000ms for stdio. An incomplete shutdown reports `SHUTDOWN_INCOMPLETE` and operationId on stderr, retaining the control endpoint. Send another signal to continue the same mode, or let the stdio owner call `host.shutdown.continue`. Drain does not automatically escalate to interrupt. Unexpected parent EOF on stdio separately uses bounded 30000ms interrupt cleanup.

## Handling results and failures

- Full long outputs are stored at `stateDir/artifacts/<sha256>.txt`. Snapshot result and approval summary use an explicitly marked preview with artifactRefs beyond 64 KiB. Inspect the complete artifact before approving it. Event replay is bounded by count and encoded bytes.
- A creation receipt confirms persistence. `runtime_accepted` confirms upstream acceptance evidence. Message completed means that delivery batch finished; only task.completed means the deliverable passed acceptance.
- Idempotency scopes: `local` for tasks.create; taskId for task control; target sessionId for session control and messages; approvalId for approvals; conflictId for scheduler.resolveConflict. Recover in the original store with `operations.lookup({method,scope,idempotencyKey})`; use `archives.lookup` with the original storeId after rollover. Preserve the SDK retry identity; `retry` never changes its namespace or payload digest.
- Save each event cursor with its storeId. `events()` uses bounded read-only polling, never model requests or unbounded buffering for slow consumers. A nonzero cursor without the matching storeId is rejected.
- `SHUTDOWN_INCOMPLETE` retains the client and operationId. Continue drain or explicitly request interrupt until shutdown is confirmed. A shutdown error must not hide the original application error or Python cancellation.
- Restart does not automatically resume tasks. Unresolved running/dispatching work becomes blocked/outcome_unknown. Timeouts and late results do not clear quarantine automatically. Use owner reconciliation below rather than editing the database.
- Missing usage fields remain null. Registered-price estimates retain unknown coverage; do not report those estimates as bills or demonstrated cost reductions. There are no paid heartbeats or additional management LLMs.

`sessions.reconcile(target, evidence, options)` accepts human attestation only from an embedded TypeScript owner or a Python-owned stdio host. Ordinary socket clients receive `UNAUTHORIZED`. The SDK first negotiates `initialize.capabilities.lifecycle={version:1,reconcile:"owner-attestation",durableDeadlines:true}` and rejects older hosts without it. The endpoint does not inspect upstream history or establish external side effects on the owner's behalf.

Attestation records local resources, remote execution, and side effects separately. When both execution sides are stopped and there are no active handles or evidence conflicts, it may release only the execution lease: `result.executionReleased=true`, `result.resolved=false`. If business outcome/sideEffects remain unknown, Q, blocked state, and the original activeDispatchId remain. Python operation.result is raw JSON; use `["executionReleased"]`. A confirmed completed outcome saves the result and leaves the task paused; explicit resume only requests acceptance again. Only confirmed not_executed permits explicit requeueing. failed/interrupted make the original task failed. Earlier unknown operations retain their history and gain resolution references. See the [cross-language reconciliation examples](SDK_USAGE_AND_WIRING.md#114-implemented-owner-attestation) for exact targets and keys.

An owner can also settle Claude records with no observed spawn, but only after execution observation ends, the spawn callback is sealed, and no process was ever observed. With an exact target and `localResources: "stopped"`, the host first commits the attestation and cleanup-preparation receipt, then retires the matching record. Successful acknowledgement emits `session.resources_reconciled` and sets `unobservedResourcesReconciled: true`. This is not observed exit evidence; unknown remote execution still prevents lease release. Live processes, stale targets, conflicts, and ordinary socket clients remain rejected. Reconcile remains available after active owner shutdown reports SHUTDOWN_INCOMPLETE, followed by continuation using the original shutdown operationId; task creation, execution resume, and message dispatch stay closed.

A third-party adapter whose prepare returns a non-function or throws is rejected before commit with `INVALID_RUNTIME_CONTRACT`. If its finalizer fails after attestation commits, `RESOURCE_CLEANUP_INCOMPLETE` carries operationId and `auditCommitted: true`. Inspect `result.resourceCleanup.status`, then explicitly retry reconcile with the original target, evidence, and idempotency key. get/lookup/wait only read receipts; waiting on persisted alone reaches the local timeout. While pending, `RESOURCE_CLEANUP_PENDING` blocks new dispatches on this host; successful acknowledgement resumes dispatch without automatic retry. If memory cleanup succeeded but acknowledgement failed, retry only persistence. After restart loses the original finalizer, retain outcome_unknown instead of substituting a new adapter. A committed declaration and a retired resource record are separate states.

Matching contradictory evidence for released execution creates `EXECUTION_EVIDENCE_CONFLICT`, persistently blocking new dispatches across restarts. The owner reads conflictId/revision through `scheduler.getConflict`, then submits newly verified stop evidence through `scheduler.resolveConflict`. This does not rewrite acceptance history or automatically reduce Q. Ordinary socket clients cannot resolve conflicts, and each conflict must be handled separately.

## Existing application runtimes

Inject an application-owned `RuntimeAdapter` through `EngineConfig.adapters` to use an existing application's complete admission, permission, tool, and audit pipeline. The standalone provider adapters remain optional. Budget v2 is required and typed; malformed capabilities are rejected before task admission and rechecked before queued work starts. `requireEngineRuntimeInput` preserves the original engine identity, signal, remaining budget, and evidence callback. It does not authenticate callers or enforce host permissions.

```sh
node examples/typescript/hosted.ts
node --test tests/contract/host-runtime.test.ts tests/contract/host-runtime-process.test.ts
```

The example uses an explicitly offline host fixture and simulated task review, creates temporary state, and cleans it up. The reusable test suite covers native acceptance, rejection, ambiguous submission, duplicate keys/usage, cancellation without stop proof, live background resources, stale evidence, and explicit owner recovery. A real host-process crash/restart test includes a Python client. The `./testing` and `./testing-host` exports are optional and not loaded by normal engine startup.

This increment is not a production Axion bridge, durable cross-store journal, authenticated multi-tenant boundary, packaged-application/hot-update acceptance, or real-model verification. A main-turn result is not proof that all owned work stopped; tool confirmation is not human task acceptance. See [the integration guide](SDK_USAGE_AND_WIRING.md#51-integrating-an-existing-applications-runtime), [SPEC-0006](docs/specs/0006-host-runtime-contract.md), and [verification evidence](docs/tdd/0006-host-runtime-contract.md).

## Host policy and durable usage

[SPEC-0007](docs/specs/0007-host-policy-and-usage.md) adds typed Claude `options` / `extendOptions`, configurable tools and setting sources, and opt-in `workspace-write` for both embedded adapters. Adapter-owned model, workspace, session, cancellation, and spawn fields cannot be overridden. Claude composes a workspace/private-state guard with host hooks; write mode requires native sandboxing without unsandboxed fallback. Custom/MCP tool authority remains the trusted host's responsibility. The host must select the same permission profile in the adapter config and `EngineConfig.providers`.

Claude native extensions or either adapter's write profile require `observeExecutionStop` to prove full execution stop after a matched terminal. Missing, false, failed, or timed-out observations keep the execution unknown/held; independently observed local process exit is also required. A late positive observation may release execution capacity without clearing the unknown business outcome. Native `canUseTool`/hooks can support host tool confirmation; engine result approval is a separate action.

Claude advertises `interrupt: true` under [SPEC-0008](docs/specs/0008-claude-interruption.md). Interrupt-mode pause and active cancel send `Query.interrupt()` through one open streaming prompt, after matching turn activity. Only a matching structured abort result plus stop/cleanup proof confirms interruption. The request receipt alone cannot pause/cancel a task. `interruptTimeoutMs` defaults to 30000; CLI values must be integers from 1 through 3600000. Host control and turn deadlines may expire sooner. [Pause, revise, and resume](SDK_USAGE_AND_WIRING.md#53-claude-interruption-and-revision) preserve the native session without restoring unsaved reasoning.

Codex `networkAccess` and `webSearch` (`disabled`, `cached`, `live`) are independent controls, defaulting to false/disabled. These serializable settings also work in the JSON CLI. Native callbacks/options and workspace-write require embedded TypeScript; they cannot be sent in a Python/JSON provider configuration. Native SDK/platform enforcement still needs separate acceptance, even when fixture policy mapping passes.

Every observed usage record is persisted with one `usage.recorded` event in the same transaction, including failed Claude terminals and retained late observations. Read its exact record with `orch.usage.getRecord(event.data.usageRecordId)` in TypeScript or `await orch.usage.get_record(event.data.usage_record_id)` in Python. The engine supplies adapters with `input.reportUsage` for observations beyond the iterator lifetime. Callback/yield replay deduplicates by dispatch and usage identity; conflicting payloads reject instead of overwriting.

Run the durable outbox and ledger replay example:

```sh
node examples/typescript/usage-forwarding.ts
```

It uses only temporary SQLite stores and a fake runtime. It reopens the host outbox, resumes and deliberately replays cursors, and simulates a lost delivery acknowledgment: two delivery attempts produce one ledger row. A real destination must honor `(storeId, usageRecord.id)` idempotency. Commit the host outbox before advancing its checkpoint. Historical rows are not backfilled into events; abrupt loss before a provider observation remains unknown. Turn-level aggregate usage is not proof of an audit record for every native model request. This does not connect to Axion or Work Nexus. See [wiring details](SDK_USAGE_AND_WIRING.md#52-implemented-host-policy-and-usage-forwarding) and [verification evidence](docs/tdd/0007-host-policy-and-usage.md).

## Routing layer (optional)

The engine executes the routing a caller declares. It never decides which agent should take a request. The optional routing layer in both SDKs makes that decision with a judge you choose, and returns an ordinary declaration for you to review and submit. It decides:

- **Who takes the request.** An idle agent whose work fits it, or a busy one worth waiting for: the request waits up to 20 minutes for it, then starts a fresh session. Otherwise a fresh session runs in parallel.
- **What the agent receives.** Up to 20 earlier results from other relevant agents, most relevant first. A result over the engine's 32 KiB context limit is left out, with a `CONTEXT_OMITTED` reason.
- **Which runtime and model fresh work uses.** A read-only or writable runtime, and a small, default or large model.
- **Who hears about a finding.** The agents a new finding affects receive it as a `finding` message.

It routes only inside one group of agents. With `scope: 'root'`, the default, a group is one root task. With `scope: 'engine'`, a group is a whole engine; use this when the host runs one engine per group, with its own workspace and `allowCrossRootReuse`. The engine still enforces its compatibility, cross-root, capacity, write-conflict, queue and approval rules, so a wrong judgment cannot bypass them.

### TypeSafe Jev as the judge

[Jev](https://typesafe.ai) is TypeSafe's fast judgment model. It answers choice, yes/no and score questions with calibrated probabilities and never generates text. Each routing decision costs one Jev call. On 2026-09-22, `jev-1.13.0` answered a four-agent team's 33 routing judgments in 0.8 seconds for about $0.0001, including requests written in Chinese. Those were small offline trials; see [SPEC-0018](docs/specs/0018-routing-layer.md).

```ts
import { createJevJudge, createRouter } from '@agent-orch/sdk/routing';

const router = createRouter({
  orchestrator: orch,
  judge: createJevJudge({ apiKey: process.env.JEV_API_KEY! }), // pinned to jev-1.13.0
  runtimes: {
    // Each model must be in that provider's configured model list.
    readOnly: { provider: 'claude-read', model: 'default-model', small: 'small-model' },
    writable: { provider: 'claude-write', model: 'default-model', large: 'large-model' },
  },
  scope: 'engine', // one engine per group, configured with allowCrossRootReuse
  describe: (agent) => `${roleOf(agent.session.id)}: ${agent.task.spec.goal}`,
});

const proposal = await router.route({ goal: text, acceptance, members: groupSessionIds });
if (!proposal.needsConfirmation || (await userAccepts(proposal))) await router.submit(proposal);

const plan = await router.notifications({ text: finding, fromSessionId, members: groupSessionIds });
await router.notify(plan); // plan.confirm and plan.followUp are left to the host
```

```python
from agent_orch.routing import JevJudge, RouteRuntime, Router

router = Router(orch, JevJudge(os.environ["JEV_API_KEY"]), scope="engine",
                read_only=RouteRuntime("claude-read", "default-model", small="small-model"),
                writable=RouteRuntime("claude-write", "default-model", large="large-model"))
proposal = await router.route(text, acceptance, group_session_ids)
if not proposal.needs_confirmation:
    await router.submit(proposal)
```

### Your own judge, or your own router

A judge is any object with `evaluate({ state, questions })` that answers with probabilities. It can wrap another model or plain rules. The answers are `{ type: 'choice', choice, probabilities, confidence }`, `{ type: 'yesno', probability }` or `{ type: 'score', probabilities, confidence }`. The question ids and the state shape are listed in the [wiring guide](SDK_USAGE_AND_WIRING.md#83-optional-routing-layer). You can also skip the layer and declare `contextPlan` yourself.

### Boundaries

- **Nothing runs without you.** `route()` never submits.
  - `needsConfirmation` is set when the judge's own confidence, or its probability for the proposed option, is below 0.85; on a narrow margin between the top two options; on uncertainty about whether files change; or on a missing runtime.
  - `reasons` records why each proposal looks the way it does.
- **A failing judge falls back.** If the judge fails or times out, the proposal becomes a fresh session without context, and it asks for confirmation by default. The Jev judge's timeout bounds the whole evaluation, including its retry.
- **Findings stay in the group.** The source of a finding must be one of the members. With `scope: 'root'`, a `rootTaskId` other than the source's own root is refused before the judge is asked.
- **Results the engine would refuse are left out.** The router asks the engine with `context.checkRefs` which results it would accept, and leaves out a result that was collected after 90 days or damaged on disk, with a `CONTEXT_OMITTED` reason. The engine still checks again on submit, so a result that changes in between fails the submission with the engine's error, and nothing is created. An engine without the check reports `CONTEXT_UNCHECKED`.
- **Versions.** The rules above on the judge's confidence, results over 32 KiB, findings and the Jev timeout come from [SPEC-0019](docs/specs/0019-routing-corrections.md), which rc.13 includes. The check before submitting is [SPEC-0020](docs/specs/0020-context-check.md), in the current source after rc.13.
- **What leaves the process.** Only the goal, one description per member and a finding's text are sent to the judge.
  - Agents appear under neutral aliases, never engine ids.
  - The default description is the latest task goal plus the first 600 characters of its result.
  - Pass `describe` to control or redact that text, and to give agents a stable role, because the latest task changes as work is routed.
- **Verification.** The tests use scripted judges, a local mock of the Jev API and a real engine with the fake runtime. Live Jev calls are not part of CI, and the default thresholds come from small offline trials.

## Claude/Codex integration status and version baselines

| Runtime | Integration used by this repository | Version baseline | Verified boundary |
| --- | --- | --- | --- |
| Claude | Optional `@anthropic-ai/claude-agent-sdk` peer dependency; `query()` and native session resume | **0.3.241 is the declared minimum**, with peer range **`>=0.3.241 <1`**. **0.3.274** is the exact offline-tested candidate and pinned protocol CI version. | Installed 0.3.274 SDK with Zod 4.4.3, native Claude 2.1.274 against a scripted loopback gateway, actual tool enumeration/invocation, retained history, fork/reuse/compact, both clients, and offline permission/interruption transport. The range is an installation constraint, not proof that every release works. Real SDK/model end-to-end acceptance is pending. |
| Codex | Managed **`codex app-server`** subprocess; stdio JSONL and App Server **v2** types. The adapter does **not** import `@openai/codex-sdk`. | **`codex-cli 0.153.4`** was used for the recorded protocol-type comparison and offline launch-option checks. | v2 types generated by that CLI, real 0.153.4 binary with scripted gateway responses, deferred MCP discovery/invocation, retained history, fork/reuse/compact, both clients, and offline failure fixtures. Other CLI versions require regenerated types and contract tests; real-model acceptance is pending. |

These are the integration baselines for the published source, not claims about the latest upstream releases. The manifests are [Claude](packages/adapter-claude/package.json) and [Codex](packages/adapter-codex/package.json); detailed evidence and limitations are in [SPEC-0002](docs/specs/0002-runtime-adapters.md#compatibility-boundaries-and-sources). Official OpenAI documentation distinguishes [App Server](https://learn.chatgpt.com/docs/app-server) from the [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), and states that generated protocol types are specific to the CLI version used.

Both adapters default to read-only and provide explicit native-session resume and bounded observation/cleanup. Embedded TypeScript can opt into workspace-write with host policy and full-stop observation; JSON CLI providers remain read-only. See [host policy and usage](#host-policy-and-durable-usage). Unconfirmed owned resources continue to block reconciliation. The optional Claude package loads only for selected Claude execution/inspection; Codex starts an owned local App Server child. A version string alone does not establish runtime acceptance.

Claude records owned ChildProcess handles through the SDK's `spawnClaudeCodeProcess` callback and confirms local cleanup by actual exit. Query.close returning, iterator.return(done:true), or AbortSignal is not exit evidence. The first half of cleanupTimeoutMs lets the SDK clean up; the remaining half observes owned stdin EOF/SIGTERM fallback. Missing/failed close triggers fallback immediately. Pending or invalid returns and an SDK that does not forward the signal do not skip fallback or extend the total asynchronous budget. Unexited resources remain held, and late exit updates evidence; local exit alone does not prove a remote terminal outcome. An injected query factory must launch observable fixtures through `request.options.spawnClaudeCodeProcess({command,args,cwd,env,signal})`; ignoring this callback conservatively retains unknown resources until eligible owner reconciliation. Verification uses real offline subprocesses; real-provider model acceptance is still pending.

The stock configuration has no generic `auth` or gateway/executable abstraction. Credentials and endpoint configuration remain with the selected native runtime or application host; unsupported JSON fields reject. The private orchestration bridge is implemented. Follow [the current integration guide](SDK_USAGE_AND_WIRING.md) and the [opt-in native plan](docs/acceptance/README.md) for the remaining real-boundary acceptance. Public publication requires separate authorization; this project's license is MIT.
