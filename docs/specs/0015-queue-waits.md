# SPEC-0015: Queue waits for multi-agent hosts

Date: 2026-09-21. Status: approved by the owner; implemented in `559cf43` for rc.9; [CI run 35614848946](https://github.com/masonlee39/Multi-Agent/actions/runs/35614848946) passed all six jobs. Evidence: [TDD-0015](../tdd/0015-queue-waits.md). Origin: an embedding host reported that dependent tasks expire while their dependencies run, and asked for longer queue waits. This specification refines the Queueing row of [SPEC-0003](0003-policy-retention-deadlines.md) and applies to every caller.

## Problem

A routing decision gives each task a queue wait: 30 seconds for a task without a `contextPlan`, and `contextPlan.maxQueueWaitMs` (at most 300 seconds) otherwise. Before this specification the wait ran from admission and kept running while a task waited for its dependencies or was paused. Three consequences:

- A task created with `dependencyTaskIds` expired with `SCHEDULING_BLOCKED` whenever its dependencies, including human acceptance, took longer than its wait. This defeated [SPEC-0014](0014-host-workflow-controls.md) D01, whose purpose is to create the dependent task up front.
- A queued task that was paused for longer than its wait expired as soon as it was resumed.
- Hosts whose agents routinely queue for minutes (write-path exclusion, one session per agent, the concurrency limit, accepted handoffs) could not configure a sufficient wait, and a task without a `contextPlan` could not configure one at all.

Non-goals: unbounded queueing, reviving tasks that already expired, and changing fallback, target-generation checks or retry semantics.

## Acceptance criteria

- **Q01 — Only queued time counts:** The queue wait bounds how long a task that has not been submitted stays `queued` before its first dispatch. A task in `waiting_dependency` or `paused` has no queue timer and never expires by its routing deadline. Each time an unsubmitted task enters `queued` from another status, its wait restarts. The engine sets `routing.enqueuedAt` to that moment and `routing.deadlineAt` to that moment plus `routing.maxQueueWaitMs`, in the transaction that changes the status. This covers completed dependencies, a client or owner resume, and a delegation approval. Retrying a request still never renews a deadline. While a task is not queued, its `deadlineAt` keeps its last value and is informational. Tasks that already expired stay `blocked`.
- **Q02 — Timing invariants:**
  1. Only a `queued` task that is neither submitted nor expired holds a queue timer.
  2. Entering `queued` and the new deadline commit in one transaction. The timer is armed after the commit from the persisted deadline, so a restart in between re-arms from the same deadline.
  3. Restarting a wait cancels any in-memory timer left from an earlier stay in the queue, so an old deadline can never expire the task.
  4. Expiry is evaluated only for `queued` tasks.
  5. Dependencies are released at the start of every scheduler pass, and a task's completion schedules a pass. A released task with `maxQueueWaitMs: 0` dispatches in that pass or expires, as a ready task with no wait does today.
  6. A reused session is still checked at dispatch against the expected generation, so a long wait never runs a stale route; it fails with `STALE_TARGET`.
- **Q03 — Longer waits:** `contextPlan.maxQueueWaitMs` accepts 0 through 604,800,000 (seven days, the same limit as `tools.handoffTtlMs`). Such timers are below the platform timer limit. After a restart the persisted wall-clock deadline re-arms them, bounded by `maxQueueWaitMs`.
- **Q04 — Host default:** `limits.defaultMaxQueueWaitMs`, 0 through 604,800,000 with a default of 30,000, sets the wait of a task without a `contextPlan` and of a `contextPlan` that omits `maxQueueWaitMs`. This includes children created by `work_delegate` whose plan omits the field; a `work_delegate` call without a `contextPlan` continues in the caller's session and creates no child. The wait is resolved at admission and stored with the task, so a later configuration change does not alter admitted tasks. The idempotency digest uses the fixed 30,000 ms fallback, so an identical retry matches under any default ([SPEC-0017](0017-audit-corrections.md) A02). Invalid values fail engine creation with `VALIDATION_ERROR`. The JSON CLI accepts the field and rejects invalid values with `INVALID_CONFIG`.
- **Q05 — Clock and host lifetime:** A queued task's wait is measured on the wall clock, as its persisted `deadlineAt` states. Time the computer sleeps while a task is queued therefore counts; after waking, a task whose deadline has passed expires at the next scheduler pass. Time the host is not running never counts. Closing the host pauses queued tasks with reason `owner_shutdown`, and a start after a crash pauses them with `owner_restart`. They do not run until the host resumes them, and resuming restarts the full wait (Q01). Tasks waiting for dependencies or paused are not timed at all.
- **Q06 — Contract and documentation:** The schema raises both `maxQueueWaitMs` maxima and adds `EngineLimits.defaultMaxQueueWaitMs`. Generated TypeScript and Python types follow. A task with a seven-day wait round-trips through the Python SDK on a real host. SPEC-0003's Queueing row, SPEC-0014 D04 and the wiring guide describe the new rule, including Q05.

## Remaining bounds

Tasks waiting for dependencies still count toward `limits.maxQueuedTasks` (queued and `waiting_dependency` together). A dependency that fails or is cancelled still blocks its dependents with `dependency_failed`. A dependency that is never accepted keeps its dependents waiting until the host cancels them. Model-created children may request any wait up to the same seven-day limit.

## Verification

Record an observed RED for Q01–Q06 against `42e2c6f` before changing the engine, except where a criterion only pins existing behavior. Use the engine clock seam to move time; tests must not depend on real sleeps longer than the scheduler needs. Then run the focused tests, the generated-contract, type and format checks, and both full suites. No credentials or paid models are used.
