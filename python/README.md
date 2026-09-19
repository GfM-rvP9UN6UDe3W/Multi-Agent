# Python SDK — foundation 1.0

This source package implements the async Python side of [SPEC-0001](../docs/specs/0001-foundation.md)
and the lifecycle and execution-isolation extensions in
[SPEC-0003-A](../docs/specs/0003-a-lifecycle.md) and
[SPEC-0003-A2](../docs/specs/0003-a2-execution-isolation.md).
It uses only the Python standard library at runtime and supports Python 3.11+.
The Node engine requires Node.js 22.18+. No package has been published.

Python does not implement another scheduler, open the SQLite database, or call model APIs.
Only the Node host owns those operations. The tested end-to-end runtime is the explicit
`fake` provider; these results are not Claude/Codex model acceptance.
A2 has passed offline protocol and real Node stdio/Unix fixture integration; see the
[A2 wiring evidence](../docs/tdd/0003-a2-wiring.md).

## Run from this checkout

From the repository root:

```sh
PYTHONPATH=python/src python3 examples/python/fake_roundtrip.py
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -v
```

The example creates temporary, separate workspace/state directories, starts the real
Node stdio host with only the fake provider, approves exact known fixture evidence,
checks the completed task, shuts down its host, and removes its own temporary files.
It makes no model calls and does not read login credentials.

Tests include a separate Python protocol fixture and the real Node host. Unix socket
tests require permission to create local sockets. The Node integration class is skipped
only if Node or the local CLI source is unavailable; a test skip is not integration proof.

For an editable development install, use a virtual environment:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e ./python
```

Setuptools is a build dependency, not a runtime dependency. This command may need access
to your configured package index for build tooling.

## Own a local host

Use the real absolute workspace/state paths and an explicit provider in the host config.
The current local entry point accepts an argument array containing the CLI configuration:

```python
from agent_orch import Orchestrator

async with Orchestrator.local(
    engine_command=[node_executable, cli_source, "host", "--stdio", "--config", config_file],
    close_timeout=30.0,
) as orch:
    print(orch.info.instance_id, orch.info.store_id)
    capabilities = await orch.capabilities(provider="fake")
```

All arguments are passed without a shell. `await Orchestrator.local(...)` also starts and
returns an owner when an application wants to manage `close()` explicitly.
The host's stdout is reserved for JSON-RPC. The SDK continuously reads stdout and stderr,
retaining only the last 16 KiB of stderr bytes (`orch.stderr_tail`) without printing logs.

Host deadlines belong in the caller's JSON configuration passed by `--config`; `local()`
does not accept a `timeouts` option or rewrite `engine_command`. The optional `timeouts`
object uses `acceptanceMs=30000`, `turnMs=1800000`, `drainMs=300000`,
`interruptMs=30000`, and `reconcileMs=60000` by default. Each override must be an integer
from 1 through 86400000 milliseconds. `LifecycleTimeouts` exposes snake_case fields;
`agent_orch.types.to_wire(LifecycleTimeouts(...))` produces that JSON object. These
deadlines are independent of local SDK wait timeouts and do not reset on retry/restart.
`LifecycleTimeouts().turn_ms` is therefore 1800000. This total budget starts at dispatch
and includes adapter startup, initialization and acceptance waiting. Acceptance and
ordinary output do not restart it. The effective budget is the smaller of the host
limit and any explicit provider cap; acceptance waiting also fits within the total.
The engine and adapters use the same monotonic remaining budget. Persisted UTC times
support diagnosis and recovery; cleanup has its own bounded wait.

The owner JSON configuration also accepts `limits.maxQuarantinedDispatches`, default 32,
an integer from 1 through 1024 and at least the effective `limits.maxActiveSessions`
(default 2, range 1 through 2). Clients cannot increase these limits through the SDK.
Changing a limit requires a host restart; existing records and deadlines are retained.

An owner closes via `host.shutdown`. `ShutdownIncomplete` leaves the connection alive:

```python
from agent_orch import ShutdownIncomplete

try:
    await orch.close(timeout=30)
except ShutdownIncomplete as pending:
    # Select drain or interrupt according to the caller's authorized shutdown policy.
    await pending.client.close(
        operation_id=pending.operation_id, mode="drain", timeout=30,
    )
```

An additional timeout still requires handling. Do not exit the event loop and report the
host as closed while shutdown remains incomplete. `async with` uses bounded drain and
preserves a body exception as the cause if cleanup also fails. Applications should retain
their business result/error separately when they continue cleanup outside the context.
The executable example demonstrates that pattern. The SDK installs no global signal handlers.

## Connect to an existing local host

```python
async with Orchestrator.connect(socket_path="/absolute/private/host.sock") as orch:
    state = await orch.tasks.get(task_id)
    print(state.status)
```

Connection-mode `close()` only disconnects. It does not send host shutdown or cancel tasks.
Explicit owner shutdown options on a connected client raise `UNAUTHORIZED`.
The same connection cannot submit owner reconciliation: `sessions.reconcile` returns
`UNAUTHORIZED` for ordinary socket clients even when the host advertises the capability.
The scheduler's `get` and `get_conflict` methods are read-only and available on these
connections; `resolve_conflict` is owner-only and also returns `UNAUTHORIZED`.

## Tasks, approvals, handles and events

```python
from agent_orch import AcceptanceSpec, RuntimeSpec, TaskSpec

task = await orch.tasks.create(
    TaskSpec(
        goal="Inspect the approved workspace",
        runtime=RuntimeSpec(provider="fake", model="fake-model"),
        acceptance=AcceptanceSpec(mode="human", criteria=["Evidence reviewed"]),
    ),
    idempotency_key="my-persisted-business-key",
)
```

The returned `TaskHandle` is an attribute-access creation snapshot with an ID and
`await task.wait(timeout=...)`. Creating a task only confirms persistence. An approval
consumer must read `approval.requested`, query `approvals.get`, display current evidence,
and call `approvals.decide(approval_id, {"choice": ..., "expected_revision": ...})` using
an authorized decision. The task does not become completed just because a model returns.
`tasks.get` returns a fresh snapshot; `task.wait` returns a completed/failed/cancelled snapshot.
Paused or blocked tasks require explicit caller handling and are not successful results.

Task/session mutations and approval decisions return operation handles where specified:
`await operation.wait(timeout=...)` returns completed/noop/rejected/failed/outcome_unknown.
Use `operations.get` or `operations.lookup(method=..., scope=..., idempotency_key=...)`
to resolve a lost receipt. Mutation receipts and errors retain all three lookup fields.
`tasks.create` uses scope `local`; task changes use the task ID, session controls the session
ID, messages the recipient session ID, and approval decisions the approval ID. Explicit
business keys are required for cross-process recovery. Generated keys are also retained on
locally cancelled mutation calls.
`scheduler.resolveConflict` uses the conflict ID as its operation scope.

`events` uses bounded read-only `events.read` pages (128 by default, at most 256) and sleeps
50 ms on empty pages. It does not generate model requests or accumulate an unbounded queue:

```python
async for event in orch.events(task_id=task_id):
    print(event.type, event.cursor)
```

Persist both `event.cursor` and `event.store_id` when implementing restartable consumers.
For continuation, pass `after_cursor=...` and `store_id=...`; a nonzero cursor without its
store identity is rejected. Known protocol fields use snake_case. Raw usage and unknown
user dictionaries, including `operation.result`, preserve their original keys.
`Snapshot.as_dict()` returns plain data.

Cancelling a wait/iterator or receiving `TIMEOUT` only stops local waiting. Use
`tasks.cancel(task_id)` for remote cancellation. Concurrent requests are bounded to 64 and
UTF-8 JSON frames to 1 MiB. Exceeding either produces a stable error rather than a silent retry.

## Inspect execution capacity and resource conflicts

All three scheduler methods require the complete `initialize.capabilities.executionIsolation`
contract: integer `version=1`, `resourceRelease=true`, `schedulerStatus=true`,
`ownerConflictResolution=true`, and integer `budgetVersion=2`. Python exposes this object
as `orch.info.capabilities.execution_isolation` with snake_case fields. Missing or
incompatible values raise `UNSUPPORTED_CAPABILITY` before a scheduler request is sent;
the SDK does not fall back to an older host's behavior. Lifecycle version 1 remains separate.

```python
scheduler = await orch.scheduler.get()
print(scheduler.execution_occupied, scheduler.quarantined, scheduler.quarantine_reserved)
print(scheduler.can_dispatch, scheduler.reasons)
if scheduler.conflicts:
    conflict = await orch.scheduler.get_conflict(scheduler.conflicts[0].conflict_id)
    print(conflict.id, conflict.revision, conflict.dispatch_id, conflict.status)
```

The counts are per dispatch: A (`execution_occupied`) counts held execution leases;
Q (`quarantined`) counts business outcomes still isolated; R (`quarantine_reserved`)
counts held leases not yet quarantined, including initialization and pending cleanup.
A new dispatch needs both A < `max_active_sessions` and Q + R <
`max_quarantined_dispatches`. A and Q can overlap. Confirmed execution stop and cleanup
can release A while Q remains; only final business reconciliation removes Q.

At the Q + R limit, new work is rejected with `QUARANTINE_CAPACITY_EXCEEDED` and queued
work stops dispatching. Original idempotent requests still return their receipts.
Queries, reconciliation, cancellation, approval and shutdown remain available; resuming
a saved result only to request acceptance is also allowed. Other scheduler reasons are
`EXECUTION_CAPACITY_EXHAUSTED`, `HOST_STOPPING` and `EXECUTION_EVIDENCE_CONFLICT`.
`occupants` and `conflicts` contain at most 16 examples each; check `truncated` and
`conflicts_truncated` alongside `open_conflicts`.

`sessions.get(session_id)` includes optional `execution` while an active dispatch is
associated with the session. Its `lease.status` is `held` or `released`;
`quarantined` is the independent business flag. Optional `execution.budget` reports
`policy_version=2`, `entered_at`, `acceptance_deadline_at`, `deadline_at`,
`effective_acceptance_ms`, `effective_turn_ms`, `acceptance_source` and `turn_source`.
Remaining-time callbacks are internal Node capabilities and never enter the Python wire.

To resolve a specific resource conflict, the owner supplies reviewed stop evidence and
the latest conflict revision. This example accepts evidence already checked by the caller:

```python
async def resolve_reviewed_conflict(owner, conflict_id, evidence, business_key):
    conflict = await owner.scheduler.get_conflict(conflict_id)
    operation = await owner.scheduler.resolve_conflict(
        conflict.id, evidence, expected_revision=conflict.revision,
        idempotency_key=business_key,
    )
    return await operation.wait(timeout=10)
```

Use `ReconcileEvidence(source="owner_attestation", ...)` with both `local_resources`
and `remote_execution` set to `stopped` and a review summary. Its business `side_effects`
and `outcome` may remain `unknown`. Active observation/cleanup handles, an old revision,
or insufficient stop evidence prevent resolution. The conflict ID remains usable after
the session clears its active dispatch. Conflicts survive restart and all open conflicts
must be resolved before dispatch resumes; resolution does not rewrite business outcomes
or acceptance history. Keep the same key when recovering a lost receipt.

## Reconcile an unknown outcome as the owner

`await orch.sessions.reconcile(target, evidence, idempotency_key=...)` returns an
`OperationHandle`. It is available to the owner created by `Orchestrator.local`, after
negotiating lifecycle version 1 with `reconcile="owner-attestation"` and
`durableDeadlines=true`. Read this as `orch.info.capabilities.lifecycle.durable_deadlines`.
Missing or incompatible capability produces `UNSUPPORTED_CAPABILITY` before sending.

Use a fresh session's ID, generation, revision, active dispatch and state as the exact
target. `ReconcileEvidence` records an explicit human owner's review of local resources,
remote execution, side effects and outcome. It does not inspect upstream history for you.
Unknown business evidence keeps the dispatch isolated. In A2, both resource fields being
`stopped`, with no active observation/cleanup handle or open execution-evidence conflict,
allow a partial reconciliation to release the execution lease while `side_effects` or
`outcome` remains `unknown`. The task stays blocked, the session stays `outcome_unknown`,
the active dispatch identity and Q are retained, and no acceptance or rerun is created.
Only one stopped resource field is insufficient. A current active handle rejects a
stop claim; a complete business attestation must also agree with recorded terminal evidence.

The completed reconciliation operation reports resource and business decisions separately.
Its result is raw JSON, so read the camelCase key exactly:

```python
receipt = await operation.wait(timeout=10)  # operation returned by sessions.reconcile
print(receipt.result["executionReleased"], receipt.result["resolved"])
```

A resource-only reconciliation returns `executionReleased=True` and `resolved=False`.
The operation's `completed` status confirms that the declaration was recorded; it does
not mean the task completed. `execution_released` is not a key in `receipt.result`.

For `completed`, include the reviewed full result string (an empty string is valid; maximum
length 524288): reconciliation saves it and leaves the
task paused, and an explicit `tasks.resume` only requests acceptance again. `not_executed`
allows explicit requeueing; `failed`/`interrupted` make the original task failed.
The earlier unknown operation retains its status and gains a `resolution` reference.
Keep a stable business key and use `operations.lookup` after a lost receipt instead of
submitting a new key. The complete
[TS/Python examples](../SDK_USAGE_AND_WIRING.md#114-本轮已实现所有者人工核对)
show the target and evidence mapping. [Python TDD evidence](../docs/tdd/0003-a-python.md)
and [increment evidence](../docs/tdd/0003-a-evidence.md) distinguish fixture verification
from unperformed real-model acceptance.

## Host upgrade and adapter compatibility

Wire protocol version remains `1.0`; the current database and initialize handshake use
schema version 2 (`orch.info.schema_version`). Before upgrading a schema 1 store, the
host creates `stateDir/store-schema1-<uuid>.sqlite` and verifies its integrity and store
identity. A backup/migration failure prevents host startup. Old engines that require
schema 1 cannot open the upgraded database. Existing persisted deadlines are never
refreshed by migration; old unknown dispatches without release evidence remain held and
quarantined. Raising limits or restarting does not automatically re-execute them.

Node adapters must advertise `executionBudget={version:2, acceptanceCapMs:..., turnCapMs:...}`.
Each cap is either `null` for no explicit provider cap or an integer from 1 through
86400000; an omitted version or any version other than 2 makes new `tasks.create` calls
fail with `UNSUPPORTED_CAPABILITY` before task persistence or adapter execution. The
host also validates this contract before dispatch. Built-in fake, Claude and Codex
adapters implement it; explicit provider timeouts remain effective when shorter.
Adapters must consume the supplied monotonic budget and report matching execution and
cleanup evidence. Missing or unverified terminal coverage cannot release a lease merely
because an iterator ended. These adapter hooks are internal Node contracts, not new
Python `local()` arguments. Offline fixtures do not prove real-provider stop guarantees.

## Implemented boundary

Implemented namespaces: `tasks.create/get/resume/cancel`, `sessions.get/control/reconcile`,
`scheduler.get/get_conflict/resolve_conflict`, `messages.send/get`,
`approvals.get/decide`, `operations.get/lookup`, `usage.get`,
`capabilities`, `events`, and owner/connection lifecycle.

`sessions.open/fork`, compact/rotate/stop controls, and automatic verification return
`UNSUPPORTED_CAPABILITY` in this increment. Session pause/resume requires all five target
fields from a fresh snapshot. Provider/model and permissions remain host configuration.
An absent usage field stays unknown/null; the client does not invent prices or token totals.
Retention/GC, tombstones, `state.snapshot`, `contextPlan` and automatic policy selection
remain planned SPEC-0003-B/C work. The SDK does not automatically clear unknown outcomes.
