# TDD-0017: Audit corrections for rc.10

Date: 2026-09-22. Base: `fbf9bdf` (rc.10). Nothing has been published.

## Reproduction before the specification

A self-audit of `2d50e3e..fbf9bdf` found four defects. Offline scripts with the fake adapter reproduced three of them at `fbf9bdf`:

- A rule registered with `cwdRelative: "app"`, then the directory removed: the next engine start failed with a raw `ENOENT` from `lstat`. No configuration change could recover it, because registered rules cannot be removed.
- The same `tasks.create` request retried after `limits.defaultMaxQueueWaitMs` changed from 30,000 to 600,000 failed with `IDEMPOTENCY_CONFLICT`.
- `revise` on a task whose session had been stopped completed, and left the task `paused` as `paused_by_client`; `tasks.resume` then failed with `SESSION_CLOSED`.

The fourth, handoff expiry without a timer, was found by reading the code: `handoff.expired` was only written by a scheduler pass, a handoff read or a new request.

## RED

Tests: `tests/engine/audit-corrections.test.ts` and `python/tests/test_audit_corrections.py`. Both were run against `fbf9bdf` before the engine changed:

- `node --test tests/engine/audit-corrections.test.ts` failed 11 of 12.
- `PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p test_audit_corrections.py` failed 2 of 2.

| Test | Failure at `fbf9bdf` |
| --- | --- |
| 0017-A01 a registered rule whose directory was removed no longer blocks startup | The restart failed with `ENOENT` |
| 0017-A01 a configured rule with a missing path starts the engine and refuses its tasks | Engine creation failed with `ENOENT` |
| 0017-A01 registration refuses a missing path with INVALID_WORKSPACE_SCOPE | `rules.register` failed with a raw `ENOENT` |
| 0017-A01 a rollover carries a rule whose directory was removed | `stores.rollover` failed with `ENOENT` |
| 0017-A01 the CLI configuration checks only the shape of its rules | `loadConfig` refused the configuration (`ENOENT`) |
| 0017-A02 an identical retry returns the original task after the default wait changes | `IDEMPOTENCY_CONFLICT` |
| 0017-A03 revise on a stopped session fails and leaves the approval pending | The decision succeeded |
| 0017-A04 a pending handoff expires on an idle host without other activity | No `handoff.expired` after the expiry |
| 0017-A04 a handoff expires while the requesting turn is still running | No `handoff.expired` during the turn |
| 0017-A04 the timer moves to the next pending handoff after each expiry | The first request did not expire at its time |
| 0017-A04 a restarted host arms the expiry of stored pending handoffs | No `handoff.expired` after the restart |
| Python host restarts with a rule whose directory was removed | The host exited during startup (`Engine connection ended before the next complete response`) |
| Python revise on a stopped session is refused | The decision succeeded |

`0017-A01 a check whose directory disappears after admission fails its verification` passed at `fbf9bdf`. It is regression coverage: execution already recorded a failed verification.

## Implementation

- **A01:** `normalizeRules` takes `checkPaths`. `effectiveRules`, used at startup, in store switches and in the import pre-check, and the CLI configuration loader pass `false`. The shape check gained a filesystem-free test that `cwdRelative` and every `baselinePaths` entry stay inside the workspace by name. `checkRulePaths` resolves the paths and turns a system error into `INVALID_WORKSPACE_SCOPE` naming the rule, the path and the error code. `rules.register` still checks paths, and `tasks.create` now calls `checkRulePaths` for every referenced rule inside the admission transaction.
- **A02:** `tasks.create` stores the spec normalized with the host default but digests `taskSpec(p.spec)`, which uses the fixed 30,000 ms fallback. `work_delegate` children carry an explicit wait, and a replayed tool call returns its stored result, so the delegate path is unchanged.
- **A03:** the task-acceptance branch of `approvals.decide` fails `revise` with `SESSION_CLOSED` when the task's session is closed. The failure happens inside the operation transaction, so no operation, approval change or task change is stored.
- **A04:** `tryExpireHandoffs` reads the pending requests once. It expires the due ones and arms a single timer for the earliest remaining expiry, cancelling the previous one. The timer only wakes the scheduler. It is also armed after a new request commits and at startup, and both close paths cancel it. A failed expiry does not re-arm for that request, so a store that cannot write does not loop.

## Mutation checks

With all tests passing, each part was removed in turn:

| Removed part | Failing tests |
| --- | --- |
| Shape-only loading of registered rules | Registered-rule restart, rollover |
| Shape-only loading of configured rules | Configured-rule startup |
| The admission path check | Registered-rule restart, configured-rule startup |
| Mapping a system error to `INVALID_WORKSPACE_SCOPE` | Registration |
| The by-name containment check | CLI configuration |
| Shape-only CLI configuration loading | CLI configuration |
| The fixed-fallback digest | A02 |
| The closed-session revise check | A03 |
| Arming the handoff timer | All four A04 tests |
| Arming at startup | A04 restart |
| Arming after a new request | A04 running turn |
| Choosing the earliest expiry | A04 next pending |

The sources were restored byte for byte.

## A05: messages to a stopped session

The audit report listed this defect as a boundary. The owner then approved the design in SPEC-0017 A05, and it was implemented on top of `d4ae686`, which holds A01–A04.

Two offline probes at `d4ae686` reproduced it. A task waiting for acceptance received a message, its session was stopped, and approve left the task `paused` as `paused_by_client`; `tasks.resume` then failed with `SESSION_CLOSED`. In the second probe, `messages.send` to the stopped session returned a `persisted` message that expired 24 hours later.

RED, run against `d4ae686` before the engine changed: the five engine tests failed 5 of 5, and the Python test failed 1 of 1.

| Test | Failure at `d4ae686` |
| --- | --- |
| 0017-A05 approving a task whose session was stopped with a pending message completes it | The task became `paused/paused_by_client` |
| 0017-A05 stopping an idle session expires its pending messages at once | The message stayed `persisted` |
| 0017-A05 stopping a running session expires messages sent during the run when it ends | The carried message completed, but the late one stayed `persisted` |
| 0017-A05 messages to a stopped session are refused with SESSION_CLOSED | The send succeeded |
| 0017-A05 startup expires pending messages that earlier versions left on stopped sessions | After a restart the message stayed `persisted` |
| Python approval completes after the session stopped with a message | The message stayed `persisted` |

The legacy test closes the session directly in `store.sqlite` while the engine is stopped. That reproduces what rc.10 left behind, which the API can no longer produce.

Implementation: `saveSession` calls `expireStoppedMessages` whenever it sets `closed`. That covers both stop paths, because the immediate stop and the end of a stopped dispatch save the session inside their transactions. `expireStoppedMessages` expires only `persisted` messages addressed to the session, updates the outbox row and emits `message.expired` with `reason: "session_stopped"`. A carried message is already `dispatching` or `runtime_accepted` by then, and that dispatch settles it first. `messages.send` refuses a closed target inside its operation transaction, so nothing is stored. The recovery transaction at startup expires `persisted` messages whose session is already closed.

| Removed part | Failing tests |
| --- | --- |
| Expiring on close | Approve, idle stop, running stop |
| Refusing sends to a closed session | Send refusal |
| The startup sweep | Legacy startup |
| Expiring only when no dispatch is active | Running stop |
| Limiting expiry to `persisted` messages | Running stop: the carried message was expired |

The sources were restored byte for byte.

## GREEN

- The seventeen engine tests and the three Python tests pass. The engine file passed 24 of 24 runs, eight at a time.
- `npm test` on Node 24.14.0: **525/525**. `npm run test:python` on Python 3.14.6: **59/59**. Local IPC was permitted, and nothing was skipped. Typecheck, the generated-contract check (68 definitions, schema unchanged), formatting and `git diff --check` pass.

## Remaining boundary

- A task that rc.10 already left `paused` after an approve or revise on a stopped session is not repaired. `tasks.cancel` ends it.
- The A04 tests use the manual engine clock. The real timer uses `setTimeout`, clamped to its maximum delay; no test waited a real day.
