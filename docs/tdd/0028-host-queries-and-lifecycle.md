# TDD-0028: Task queries, self-contained events, queue reasons, a pausing close, rule retirement and a non-blocking reserve

Date: 2026-09-26. Base: `41869d1` (0.1.4 and its release record on `main`). Specification: [SPEC-0028](../specs/0028-host-queries-and-lifecycle.md).

## RED

The new and changed tests were copied onto a clean checkout of the base and run there, and their final versions were run there again before delivery, with the same results.

- `tests/engine/task-queries.test.ts`, 5 of 5 failed. `tasks.list` refused `status` with `VALIDATION_ERROR: Unknown field: status` (P01, P04), and `tasks.getMany` and `usage.summary` failed with `METHOD_NOT_FOUND` (P02, P03).
- `tests/engine/self-contained-events.test.ts`, 4 of 4 failed.
  - `0028-E01`: the usage record had no `sessionId`.
  - `0028-E02`: the data of `usage.recorded` held only `usageRecordId`, `dispatchId` and `provider`.
  - `0028-E03`: the failed rule in `verification.completed` had no `outputTail`, and `verification-feedback.ts` exported no `completedRules`.
- `tests/engine/verification-feedback.test.ts`: `0022-V04 0028-E03`, which now expects the failed rule's tail, failed; the other four passed.
- `tests/engine/queue-reasons.test.ts`, 8 of 8 failed: every read returned no `blockedBy`, and `initialize` listed no `workflow.queueReasons`.
- `tests/engine/pause-close.test.ts`, 3 of 4 failed: `close({ mode: 'pause' })` failed with `VALIDATION_ERROR: Unknown close mode`, and `initialize` listed no `workflow.pauseClose`. `0028-S03`, which checks that `interrupt` is unchanged, passed.
- `tests/contract/claude-close-interrupt.test.ts`: the three `0028-S` tests failed with `Unknown close mode`; the five `0022-C` tests passed.
- `tests/engine/rule-retirement.test.ts`, 6 of 6 failed: `rules.retire` failed with `METHOD_NOT_FOUND`.
- `tests/engine/reserve.test.ts`, 4 of 5 failed.
  - `0028-W01`: the `setImmediate` callback had not run when `createEngine` resolved.
  - `0028-W02`: no reserve write went through `fs.promises`; a partial file was left in place; and the test of admission and close timed out, waiting for an asynchronous write that never came.
  - The test that `storage.configure` writes a missing reserve before it returns passed on the base, whose write was synchronous.
- `tests/contract/reserve-guard.test.ts`: `0028-W03` failed, because the guard let a process write 4097 bytes through a file handle. `0011-R10`, whose assertion now expects no complete `emergency.reserve` after the guard stopped the host, failed as well: the base wrote to `emergency.reserve` itself and left it empty.
- `tests/contract/host-queries-sdk.test.ts`, 4 of 4 failed: the SDK sent `status` to a host without the feature, `initialize` listed no `taskQueries`, the schema had no `RuleRetireParams`, and the command-line configuration refused `shutdown.mode: "pause"`.
- `python/tests/test_host_queries_0028.py`, 3 of 3 failed: `tasks.list` took no `status`, `rules` had no `retire`, and the host listed no `task_queries`.
- Existing tests changed with this increment failed on the base as expected: `0014-X02`, which lists the new workflow features, and B05 of the storage governance tests, which calls `reserve()`.
- `npm run typecheck` reported errors in the new tests where they called the methods and options that did not exist.

## Changes

- **Queries (P).**
  - `Store.listTasks` takes `status` and `order`, and the reads of `engine/src/reads.ts` validate them. A `desc` page without a cursor starts at the newest task.
  - `tasks.getMany` reads the tasks by primary key and returns them in the order asked.
  - `usage.summary` joins the tasks of the tree to their usage records, and resolves the model of an older record through its dispatch's session.
  - `usage.get` reads through `Store.taskUsage`.
  - The store creates the indexes `tasks_root` and `usage_task`.
- **Events (E).**
  - `recordUsage` adds `sessionId`, `model`, `rootTaskId` and `recordedAt` to a new record, and compares a repeat with the stored record through `reportedUsage`, which drops those fields. `usage.recorded` carries the token counts, the model and the root task.
  - `verification-feedback.ts` chooses the failed rules' lines once, in `feedbackLines`; the retry prompt and the new `completedRules`, which builds the rules of `verification.completed`, both use that choice.
- **Queue reasons (B).**
  - `writeConflict` became `writeConflictHolders`, which returns the holders, and `storageBlocked` joins the two storage checks that `start` made. The scheduler uses both.
  - `addBlockers` asks, for each waiting task that a read returns, the scheduler snapshot, `storageBlocked`, `sessionReady` and `writeConflictHolders`, in the order of B01. It reads the snapshot, the storage status and the active dispatches at most once per read. `readCall` takes it as a hook, which the read-only view does not pass.
  - `storage.configure` starts a scheduler pass.
- **Pausing close (S).**
  - `close` accepts `pause`. For each flight that it interrupts and that has no other intent, it sets `pausedByClose` before `abort()`. The interrupted terminal then chooses `owner_shutdown` instead of `runtime_interrupted`.
  - The command-line configuration and both SDKs accept the mode. The SDKs refuse it before sending to a host without `workflow.pauseClose`, and the Python SDK checks the host's features without calling `start()`, whose lock `close` holds.
- **Rule retirement (U).**
  - `rules.retire` is an owner mutation. It finds the stored row by its content, adds `retiredAt`, commits `rule.retired` and, after the commit, removes the rule from the effective rules.
  - `effectiveRules` sets retired rows aside before it validates anything and returns them in the order they were retired.
  - Admission and `rules.register` refuse a retired identity with `RULE_RETIRED`, and `rules.list` takes `includeRetired`, in the engine and in the read-only view.
- **Reserve (W).**
  - `StorageGovernance` no longer writes the reserve in its constructor or in `configure`. `reserve()` writes it through `fs.promises`, in chunks of at most 1 MiB, to `emergency.reserve.partial`, then datasyncs it, renames it and syncs the directory. Calls during a write share it, and `settled()` waits for it.
  - `createEngine` awaits `writeReserve()`, which closes what the constructor opened when the write fails. `storage.configure` and the store switch await the reserve, and `close` waits for a write in progress.
  - `tests/fixtures/reserve-guard.mjs` also counts writes through file handles from `fs.promises.open`, to both file names.
- **Contract.** The schema gains `TaskBlocker`, `TaskGetManyParams`, `TaskGetManyResult`, `UsageSummaryParams`, `UsageTotals`, `UsageModelTotals`, `UsageSummary`, `HostShutdownParams`, `RuleRetireParams` and `RuleListParams`, the new optional fields of `TaskListParams`, `TaskSnapshot`, `UsageRecord`, `UsageRecordedData` and `RegisteredVerificationRule`, and the four workflow features. `RuleListResult` lost its limit of 1000 items, since retired rules follow the effective ones. `npm run generate:protocol` rewrote the generated files.

Found on the way:

- `0028-P04` first failed after the implementation: without statistics, SQLite ran the join of `usage.summary` by scanning every usage record and looking up its task. The test's check had missed that step, because the plan names the table by its alias; it now refuses every `SCAN` step. The join became a `CROSS JOIN`, which keeps the tasks as the outer loop, and compares with `+t.id`. The column's text affinity had kept SQLite from searching `usage_task`.
- Reading the new `listTasks` showed that a `desc` page without a filter or a cursor built an empty `WHERE`; `0028-P01` now reads such a page.
- The first run of the Claude tests on the base did not end. When the base refused `close({ mode: 'pause' })`, the tests left the orchestrator and its runtime process open; they now close it in any case.
- The downstream host found that section 11.2 of the guide recommended pausing each running session and then closing with `drain`, which lets a queued task start in between. A script reproduced it on the tag `v0.1.4` and on this branch: a second writer to the same paths, queued behind a running turn, was `running` right after the session pause, and a `drain` close with a 2-second budget ended with `SHUTDOWN_INCOMPLETE` while it ran. With `close({ mode: 'interrupt' })` the second writer was paused with `owner_shutdown` and never started, and `0028-S01` covers the same order for `pause`. The guide now recommends the two modes and says why the other sequence does not stop all work.
- Existing tests that changed:
  - `0014-X02` lists the four new workflow features.
  - B05 of the storage governance tests writes the reserve with `reserve()`, since the constructor no longer does.
  - The offline conformance kit in `engine/src/testing.ts` compares the fields that a runtime reported, through `reportedUsage`.
  - `0011-R10` checks both reserve file names.

## GREEN

- The 41 tests that name SPEC-0028, 40 new ones and `0022-V04 0028-E03`, passed, and so did the other tests of their files. `test_host_queries_0028.py`: 3 of 3.
- `npm test`: 698 of 698 (658 before). `npm run test:python`: 98 of 98 (95 before).
- `npm run typecheck`, `npm run format:check` and `npm run check:generated` (79 definitions) passed.
- `npm run build:packages`, `scripts/build-python.py` with the pinned build tools and `npm run test:packages`: nine installation and bundle modes passed, and the SDK's declarations name no internal module.
- The nine new and changed test files, run eight times each with eight runs at a time: 72 of 72 passed.

Measured on the recording Mac, outside the test commands, so without the reserve guard:

- **Starting with the default 256 MiB reserve.** A 5 ms interval timer, set before `createEngine`, never ran during the base's start (143 to 151 ms): the event loop was blocked for all of it. With this change it ran 25 or 26 times during a start of the same length (142 to 147 ms), and the longest gap between runs was 8 to 10 ms, which includes opening the store and recovery.
- **Queries on 10,000 finished tasks with 50,000 usage records.** Whether any task is active: 0.016 ms through `tasks_status`, and 3.05 ms with that index dropped. The newest completed task: 0.009 ms. One task's usage records: 0.007 ms through `usage_task`, where the base's `usage.get` read the whole table in 48 ms. The usage of a tree of ten tasks: 0.047 ms.

## Mutation checks

Each mutation was applied alone to the implementation and the test file named was run; all 60 were caught.

| Mutation | Result |
| --- | --- |
| `tasks.list` ignores `status` | caught by `0028-P01` |
| `desc` ignored | caught by `0028-P01` |
| A `desc` page without a filter or cursor builds an empty `WHERE` | caught by `0028-P01` |
| A repeated status or task ID accepted | caught by `0028-P01` |
| `tasks.getMany` in database order | caught by `0028-P02` |
| `usage.summary` counts the root task only | caught by `0028-P03` |
| An older record's model not resolved through its session | caught by `0028-P03` |
| `usage.summary` of a task that has a parent | caught by `0028-P03` |
| No index `usage_task` | caught by `0028-P04` |
| `usage.get` reads the whole usage table | caught by `0028-P04` |
| The join of `usage.summary` compares with `t.id` | caught by `0028-P04` |
| The TypeScript SDK sends `status`, or `tasks.getMany`, to a host without `taskQueries` | caught by `0028-P05` (two mutations) |
| A repeat compared on the whole record, `recordedAt` included | caught by `0028-E01` |
| A record without `model`, or without `rootTaskId` | caught by `0028-E01` (two mutations) |
| `usage.recorded` with `raw`, or without the token counts | caught by `0028-E02` (two mutations) |
| No output tails in `verification.completed` | caught by `0028-E03` |
| The event's tails chosen without the prompt's budget | caught by `0028-E03` |
| No `capacity` reason | caught by `0028-B01 0028-B02` |
| `host_stopping` before `scheduler_failed` | caught by `0028-B01` |
| `execution_conflict` before `resource_cleanup` | caught by `0028-B01 0028-B02` |
| The read checks only the session's status, not the scheduler's session check | caught by `0028-B01 0028-B02` |
| No `storage` reason | caught by `0028-B01 0028-B02` |
| Wrong holders of conflicting write paths | caught by `0028-B01 0028-B02` |
| Completed dependencies listed | caught by `0028-B01` |
| A running task carries `blockedBy` | caught by `0028-B01 0028-B02` |
| No scheduler pass after `storage.configure` | caught by `0028-B01 0028-B02` |
| `pause` refused | caught by `0028-S01 0028-S02` |
| An interrupted turn paused as `runtime_interrupted` | caught by `0028-S01 0028-S02` |
| A pausing close interrupts no turn | caught by `0028-S01 0028-S02` |
| `mayHaveBeenSent` false for a pausing close | caught by `0028-S01 0028-S02` |
| A turn that a session pause is interrupting also marked | caught by `0028-S02`, the test of a close during a session pause |
| The TypeScript SDK sends `pause` to a host without `pauseClose` | caught by `0028-S04` |
| The command-line configuration refuses `pause` | caught by `0028-S04` |
| A retired rule stays effective | caught by `0028-U01` |
| Retired rules count toward the 1000 | caught by `0028-U01` |
| No `rule.retired` event | caught by `0028-U01` |
| A task naming a retired rule fails as `UNKNOWN_VERIFICATION_RULE` | caught by `0028-U01` |
| A retired version registered again | caught by `0028-U03` |
| A configured rule retired | caught by `0028-U03` |
| Retired rows validated with the effective ones | caught by `0028-U04` |
| `includeRetired` ignored | caught by `0028-U01` |
| The TypeScript SDK sends `rules.retire` to a host without `ruleRetirement` | caught by `0028-U05` |
| `createEngine` does not wait for the reserve | caught by `0028-W01` |
| The reserve written under its final name | caught by `0028-W02` |
| No `datasync`, or no directory sync | caught by `0028-W02` (two mutations) |
| A partial file from an earlier start kept | caught by `0028-W02` |
| `close` does not wait for a reserve write | caught by `0028-W02` |
| `storage.configure` does not wait for the reserve | caught by `0028-W02` |
| The guard does not count writes through file handles, or does not know the partial name | caught by `0011-R10`, which then wrote the 256 MiB reserve, and `0028-W03` (two mutations) |
| The Python SDK sends `status`, `get_many`, `include_retired` or `pause` to a host without the feature | caught by `test_0028_p05_u05_s04` (four mutations) |
| Python `usage.summary` keeps camelCase totals | caught by `test_0028_p05_b01` |
| Python `blocked_by` keeps camelCase keys | caught by `test_0028_p05_b01` |

Two of the first run's patches were wrong and were run again: the one of `status` matched the handoff filter too, and the one that dropped `rule.retired` broke the syntax. The first run also found the one mutation that survived, marking a turn that a session pause was already interrupting. The Claude test of that case had waited for the pause to end, so no turn was left when the close came; the engine test `0028-S02 a turn that a session pause is still interrupting` closes while the pause is in progress. Three Python mutations first survived for another reason: the fixture host of the negotiation test listed no workflow features at all, so the SDK refused the calls for `taskList` or `runtimeRules`, and the host answered unknown methods with the same code. The fixture's new mode `workflow-0.1.4` lists the features of 0.1.4, and the test checks that the SDK itself refused.

## Not verified

- A desktop application's own event loop, such as Electron's, while the engine starts; the evidence is the Node event loop of the tests and of the measurement above.
- Stores with millions of tasks or usage records. The query plans are fixed by the tests, not the time on such a store.
- The recommended desktop settings in a user's environment.
- Real models.
