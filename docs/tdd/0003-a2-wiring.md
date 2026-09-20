# SPEC-0003-A2: Bilingual SDK, CLI, and public-schema wiring evidence

Date: 2026-09-19. Scope: public wiring, configuration validation, and offline protocol verification. Engine state machines/adapter evidence are separate. This does not establish real Claude/Codex identity or paid-model acceptance.

## RED

Add `tests/contract/execution-isolation-wiring.test.ts`, `python/tests/test_execution_isolation.py`, and independent Python fixture extensions, then run:

```sh
node --test tests/contract/execution-isolation-wiring.test.ts
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p test_execution_isolation.py -v
```

All five TS tests failed: missing scheduler entry point, CLI rejecting maxQuarantinedDispatches, schema turnMs still 300000. Five Python methods produced one failure and 11 errors (including capability subtests): missing scheduler/snake_case executionIsolation wiring and turn_ms still 300000. These were actual pre-implementation RED. Later real-host integration was regression validation, without invented RED.

## Implementation

- TS exposes scheduler.get, getConflict({conflictId}), and resolveConflict({conflictId,expectedRevision,evidence}, {idempotencyKey}). All check exact complete executionIsolation v1/budgetVersion 2 before send. Resolution returns OperationHandle with conflictId idempotency scope.
- Python exposes scheduler.get, get_conflict(conflict_id), and resolve_conflict(conflict_id,evidence,expected_revision=...,idempotency_key=...). Capability types are strict: bool is not a version and numeric 1 is not true. Known snapshot/nested execution/lease/budget fields become snake_case; user JSON/operation.result retain keys.
- CLI validates integer maxQuarantinedDispatches in 1..1024 and at least effective maxActiveSessions, then passes it unchanged. Explicit requestTimeoutMs/turnTimeoutMs are retained/validated. Cleanup fields are Claude cleanupTimeoutMs and Codex closeTimeoutMs. New defaults do not replace shorter explicit limits.
- Python LifecycleTimeouts defaults turn_ms to 1800000 with other limits unchanged. Public schema adds 11 definitions for scheduler requests/responses, conflicts, leases, budgets, session summary, and EngineLimits. Wire remains 1.0 and event schemaVersion 1.

## GREEN and real cross-language host

```sh
node --test tests/contract/execution-isolation-wiring.test.ts tests/contract/sdk.test.ts
node --test tests/contract/execution-isolation-wire.test.ts
npm run typecheck
PYTHONPATH=python/src:python/tests python3 -m unittest test_execution_isolation test_reconcile test_sdk test_lifecycle test_transport_parsing -v
```

TS wiring/existing SDK: 11/11 passed. Real Unix bilingual integration: 1/1 passed. Typecheck passed. Of 32 Python tests, 31 passed in sandbox; one old Unix fixture failed bind EPERM. With local IPC allowed, that case passed 1/1; the environment failure was not called success.

The real Unix test starts temporary Node CLI with explicit fake provider. After a 40 ms total deadline, task stays blocked/outcome_unknown. Late terminal/cleanup evidence yields A=0/Q=1/R=0. With capacity one, reason remains QUARANTINE_CAPACITY_EXCEEDED; a released lease does not fabricate business success. TS and a separate actual Python process connect to the same host. Complete scheduler/session snapshots match field by field after known-field wire conversion. Ordinary-socket conflict resolution receives UNAUTHORIZED. There is one dispatch.started and no approval.requested.

The independent Python protocol fixture proves unsupported capabilities send no scheduler request. Owner resolution returns handle, raw JSON, exact request echo, same-key receipt, and changed-payload conflict. Lost-receipt errors retain method, conflict scope, and key.

```sh
npx prettier --check packages/sdk-typescript/src/index.ts packages/cli/src/config.ts schemas/protocol.schema.json tests/contract/execution-isolation-wiring.test.ts tests/contract/execution-isolation-wire.test.ts
```

Scoped formatting passed. Test finally/after hooks clean owned hosts, fixtures, and temporary directories. No real models.

## Python actual-host and full regression

Add three `python/tests/test_node_execution_isolation.py` cases using actual Node stdio/Unix CLI: running sessions expose default 1800000 ms budget; explicit 40 ms turn with late cleanup yields A=0/Q=1/R=0 while retaining activeDispatchId/business unknown; two clients read equal state and ordinary sockets cannot resolve conflicts. Also assert deadlineAt-enteredAt=1800000 ms.

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p test_node_execution_isolation.py -v
npm run test:python
```

With local IPC permitted, new integration passed 3/3 and an independent complete Python rerun passed 40/40 with no failures/skips, covering the earlier Unix permission failure.

## Claude cleanup-parameter correction

Review found CLI allowed Claude closeTimeoutMs while the adapter actually reads cleanupTimeoutMs, silently ignoring user configuration. First add provider-specific field and actual-adapter execution tests:

```sh
node --test --test-name-pattern='provider-specific cleanup keys' tests/contract/execution-isolation-wiring.test.ts
```

Actual RED: 1/1 failed, `INVALID_CONFIG: Unknown claude provider field: cleanupTimeoutMs`. Change Claude allow-list/integer validation to cleanupTimeoutMs, retain Codex closeTimeoutMs, and reject crossed names.

The test reads 17 ms from JSON, constructs the actual Claude adapter through engineConfig, then injects an offline query fixture. A hanging iterator.return remains pending at virtual 16 ms and yields cleanup unknown at 17 ms with resources retained. Resolve the late return and close the owned adapter. This proves behavior beyond configuration echo, without loading the official SDK or invoking a model.

```sh
node --test tests/contract/execution-isolation-wiring.test.ts
npm run typecheck
npx prettier --check packages/cli/src/config.ts tests/contract/execution-isolation-wiring.test.ts schemas/protocol.schema.json
```

Actual GREEN: wiring 6/6, typecheck/format passed. README/SDK guide distinguish cleanup fields. Completed attestation still requires result but permits a genuine empty string; schema removes result.minLength while retaining string type and maximum length 524288.
