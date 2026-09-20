# SPEC-0003-A: Python SDK TDD evidence

Date: 2026-09-19. Scope: Python sessions.reconcile, capability negotiation, public request types, snake_case mapping, and actual Node wiring. Other changes in the increment provide the Node engine/host. Protocol fixtures are not real-runtime acceptance.

## RED

Add `python/tests/test_reconcile.py` and lifecycle mode in the independent protocol fixture, then run:

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p test_reconcile.py -v
```

Actual result: `Ran 5 tests`, `FAILED (errors=10)`. Six missing/incompatible capability subcases and other calls raised AttributeError because _Sessions lacked reconcile. Public-type cases lacked LifecycleTimeouts/ReconcileEvidence. This was runtime RED from missing interfaces, not an invented assertion or compile error.

## GREEN

Repeat the command after implementation: all five passed, covering:

- initialize lifecycle must declare integer version=1, reconcile="owner-attestation", and boolean durableDeadlines=true. Old hosts, wrong versions/methods/types fail before mutation send.
- ReconcileEvidence and exact targets map snake_case to wire. Return OperationHandle; lifecycle/resolution fields support snake_case, while raw operation.result preserves original keys.
- Lost receipts retain method=sessions.reconcile, session scope, and idempotency key. Same-key lookup/repeat recovers the original operation.
- Local OperationHandle.wait timeout neither resends nor renews durable deadlines.
- Public LifecycleTimeouts fields/defaults; omitted evidence.result is not serialized as null.

Orchestrator.local gains no timeouts parameter and does not inspect/rewrite engine_command. Callers write `agent_orch.types.to_wire(LifecycleTimeouts(...))` into their own temporary --config JSON; the host validates it.

## Actual Node stdio/socket integration

Add `python/tests/test_node_reconcile.py` and run:

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p test_node_reconcile.py -v
```

- Stdio owner loads a 40 ms drain deadline from temporary configuration. Pause expires to outcome_unknown; late result is evidence only and task remains blocked.
- Explicit completed attestation pauses the task. Resume requests acceptance only; human approval completes it. Exactly one dispatch.started event proves no second fake-runtime execution on this path.
- Same-key reconcile returns the original ID. The original pause retains outcome_unknown plus resolution. Deadline, resolution, and output survive restart.
- A non-owner socket using the same public Python method receives UNAUTHORIZED; disconnect leaves the shared host running.

First sandbox run passed stdio but failed socket on local listen EPERM. After local-socket permission, both passed. This environment adjustment is not interface RED.

## Full regression

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -v
python3 -m compileall -q python/src/agent_orch python/tests
```

All 32 tests passed with none skipped; compilation exited 0. Only independent Python protocol fixtures, real Node subprocesses, temporary directories/databases/sockets, and explicit fake providers were used. No login credentials or paid models. Actual Claude/Codex history inspection, external side-effect proof, and model business acceptance are outside this evidence.
