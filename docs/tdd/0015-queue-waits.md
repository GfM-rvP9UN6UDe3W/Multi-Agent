# TDD-0015: Queue waits

Date: 2026-09-21. Base: `42e2c6f` (the rc.8 review corrections on branch `axion-rc9`). Nothing has been published.

## Reproduction before the specification

An embedding host reported that a task created with `dependencyTaskIds` expired while its dependency ran. Offline scripts with the fake adapter reproduced this at `58db94f`:

- A dependent task without a `contextPlan` was `waiting_dependency` at 5 s and 25 s. At 35 s it was `blocked` with `SCHEDULING_BLOCKED`, while its 45-second dependency was still running.
- With the largest allowed wait, 300,000 ms, a dependency that finished at once but whose human review took 5 min 1 s on the engine clock expired its dependent before approval. The dependent stayed blocked afterwards.
- `maxQueueWaitMs: 300001` failed with `VALIDATION_ERROR`.
- A queued task paused for 31 s was `blocked` as soon as it resumed. The host had not reported this.

## RED

The engine tests are in `tests/engine/queue-waits.test.ts`. The schema test is in `tests/contract/protocol-schema.test.ts`, and the Python test is in `python/tests/test_queue_waits.py`. All were run against `42e2c6f` before the engine changed:

- `node --test tests/engine/queue-waits.test.ts`: 7 of 8 failed.
- `node --test --test-name-pattern 0015 tests/contract/protocol-schema.test.ts`: 1 of 1 failed.
- `PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p test_queue_waits.py`: 1 of 1 failed.

| Criterion | Test | Failure at `42e2c6f` |
| --- | --- | --- |
| Q01 | a dependency wait never expires and the wait starts at release | The dependent task was `blocked`, not `waiting_dependency`, after an hour of review |
| Q01 | pause time does not count, a resume restarts the wait and its retry does not | `enqueuedAt` still held the admission time after the resume |
| Q02 | a released task without a wait dispatches in the releasing pass or expires | The zero-wait dependent was `blocked/SCHEDULING_BLOCKED` before its dependency was approved |
| Q03 | waits up to seven days are accepted and enforced | `maxQueueWaitMs must be an integer between 0 and 300000` |
| Q04 | the host default covers tasks and children without a wait and is fixed at admission | Waits were `[30000, 30000, 1000]`, not `[600000, 600000, 1000]` |
| Q04 | invalid host defaults fail engine creation and the JSON CLI | `Missing expected rejection: -1` |
| Q05 | host downtime never counts | The resumed task became `blocked/SCHEDULING_BLOCKED` |
| Q05 | computer sleep counts | Passed. It pins existing behavior, as the specification says |
| Q06 | the schema allows seven-day queue waits and a host default | `EngineLimits: additional property defaultMaxQueueWaitMs` |
| Q06 | Python round-trips a seven-day wait | `maxQueueWaitMs must be an integer between 0 and 300000` |

## Implementation

- `saveTask` restarts the wait whenever an unsubmitted task enters `queued` from another status. It captures one wall-clock value for `enqueuedAt` and `deadlineAt`, and it cancels any in-memory timer left from an earlier stay in the queue. Dependency release, client and owner resumes, and delegation approval all pass through it; the special case for delegation approval is gone.
- Only `queued` tasks arm a queue timer. The scheduler no longer scans `waiting_dependency` tasks for expiry, and `expireQueue` accepts only `queued` tasks.
- `contextPlan.maxQueueWaitMs` accepts up to 604,800,000 ms. `limits.defaultMaxQueueWaitMs` is validated by the engine and the JSON CLI, and admission resolves it for tasks, plans and `work_delegate` children.
- The schema raises both maxima and adds `EngineLimits.defaultMaxQueueWaitMs`; `npm run generate:protocol` regenerated the TypeScript and Python types.

## Mutation checks

With every test passing, each part below was removed in turn and the engine tests rerun. The sources were restored byte for byte afterwards.

| Removed part | Failing tests |
| --- | --- |
| Restart on entering `queued` | Q01 dependency, Q01 pause, Q05 downtime |
| Cancelling the earlier timer on restart | Q01 pause (the old timer expired the task 1 s after its resume) |
| Not timing dependency waits (the rc.8 scan restored) | Q01 dependency, Q02 |
| The host default for `work_delegate` children | Q04 host default |
| A zero default in the JSON CLI | Q04 invalid defaults |

## GREEN

- `node --test tests/engine/queue-waits.test.ts`: 8/8. Twelve parallel runs all passed.
- The Q06 schema test and the Python test pass.
- `npm test` on Node 24.14.0: **505/505**. `npm run test:python` on Python 3.14.6: **55/55**. Local IPC was permitted, and nothing was skipped. Typecheck, the generated-contract check (68 definitions), formatting and `git diff --check` pass.

## Native evidence for SPEC-0014 P02

The host asked whether two differently named Claude adapters had run with the real binary. They had not: P02's test injects a scripted `query`, and the gateway smoke registered one read-only adapter named `claude`. `scripts/native-gateway-smoke.mjs claude` now also registers `claude-read` (read-only) and `claude-write` (`workspace-write`, sandbox enabled) in the same engine. It runs one scripted task on each and requires completion, `execution.released`, no `execution.evidence_rejected` and distinct native sessions.

- Local run: Claude Code 2.1.274, SDK 0.3.274, a loopback scripted gateway, synthetic credentials and no model calls. All nine cases passed with 11 gateway requests ([evidence](0015-native-claude.json)). The writable adapter's stop observation received a target that named `claude-write`.
- The first attempt failed: the writable task ended `blocked` with `outcome_unknown`. The smoke's stop observer returned an object; the contract is a boolean, and only `true` counts. The same wrong stub was in `scripts/native-read-fence-smoke.mjs`. That script calls the adapter directly and never checked release, so its F04 results were unaffected. Both stubs now return a boolean. The read-fence smoke passes 3/3 again, and the Codex smoke with codex-cli 0.153.4 passes 6/6.
- The writable adapter's stop observer is a scripted attestation that no tool ran. A real host must observe the actual stop.

## Remaining boundary

- The CI native job runs the new case on Ubuntu 24.04 and macOS 14. Whether the writable profile's required OS sandbox is available on the Ubuntu runner is not yet known.
- Sleep counts because the deadline is wall-clock time. This matches the specification; no platform's suspend behavior was measured.
- Only the fake runtime exercised queue waits.
