# TDD-0016: Sessions after their task ends

Date: 2026-09-22. Base: `7c9e922` (rc.9). Nothing has been published.

## Reproduction before the specification

An embedding host reported the stranded session, and offline scripts with the fake adapter reproduced it at `7c9e922`:

- A child owner process started a dispatch and exited before `close` finished. After a restart the task was `blocked` (`outcome_unknown: previous owner exited during a dispatch`) and the session was `outcome_unknown`, holding one execution slot and one quarantine slot.
- Reconciled with unknown side effects and outcome, the attestation released the execution slot only: execution 0, quarantine still 1. With `limits.maxQuarantinedDispatches: 1`, the scheduler reported `QUARANTINE_CAPACITY_EXCEEDED` and a new task was refused.
- Reconciled as resolved and `interrupted`, the attestation released both slots and failed the task. The session stayed `paused`. `sessions.control` resume failed with `STALE_TARGET` (`Task is terminal`), and a task that reused the session stayed `queued`.
- A session paused while its task awaited acceptance, then approved, was `paused` with a completed task, and resume failed the same way. The host had not reported this path.
- `close({mode: "interrupt"})` paused the running task with `runtime_interrupted` and its session without a `pauseOrigin`. A client pause before the close left `pauseOrigin: "client"`.

## RED

Tests: `tests/engine/session-recovery.test.ts` (with the child fixture `tests/fixtures/dispatch-crash-owner.ts`) and `python/tests/test_session_recovery.py`. Both were run against `7c9e922` before the engine changed:

- `node --test tests/engine/session-recovery.test.ts` failed 3 of 3.
- `PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p test_session_recovery.py` failed 1 of 1.

| Test | Failure at `7c9e922` |
| --- | --- |
| a crashed dispatch reconciled as interrupted leaves a session that resumes and continues | Resume failed with `STALE_TARGET` (`Task is terminal`) |
| a session paused before its task was approved resumes and continues | The runtime-resume guard check got `STALE_TARGET` instead of `UNAUTHORIZED`: the terminal check rejected every resume first |
| a session paused before its task was denied resumes and continues | Same as the approved case |
| Python resumes a session whose task ended | `OrchestrationError: Task is terminal` |

## Implementation

`sessions.control` still refuses every command except `resume` on a session whose associated task ended. `resume` on such a paused session keeps the runtime-origin check, requires that no dispatch or runtime resource remains active, and saves the session `idle` (which clears `pauseOrigin`). The existing `session.idle` event and the scheduler pass at the end of the control call follow. Nothing else changes; resuming an unpaused session remains a no-op.

## Mutation checks

With all tests passing, each guard was removed in turn:

| Removed part | Failing tests |
| --- | --- |
| The active-resource guard | Both acceptance-path tests |
| The runtime-origin check on this path | Both acceptance-path tests |
| Refusing other commands on an ended task | Both acceptance-path tests |

Removing the new path itself is the baseline, which failed everywhere. The sources were restored byte for byte.

## GREEN

- The three engine tests and the Python test pass. Twelve parallel runs of the engine file all passed.
- `npm test` on Node 24.14.0: **508/508**. `npm run test:python` on Python 3.14.6: **56/56**. Local IPC was permitted, and nothing was skipped. Typecheck, the generated-contract check (68 definitions, schema unchanged), formatting and `git diff --check` pass.

## Remaining boundary

- The crash test kills the owner with SIGKILL. A power loss or kernel panic was not exercised.
- S03's Intel macOS evidence comes from CI only; no Intel machine was used locally.
- Resuming a session continues its native history, including the interrupted turn's partial record. The fake runtime shows only that the native identity is kept, not how a real model treats that history.
