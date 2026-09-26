# TDD-0029: Usage by task, the time a task delivered, reactivating rules and tasks that a close paused

Date: 2026-09-26. Base: `dbf9732` (0.1.5 and its release record on `main`). Specification: [SPEC-0029](../specs/0029-usage-by-task-and-close-markers.md).

## RED

The new and changed tests were copied onto a clean checkout of the base and run there.

- `tests/engine/usage-by-task.test.ts`, 4 of 4 failed: `usage.byTask` failed with `METHOD_NOT_FOUND`.
- `tests/engine/delivered-at.test.ts`, 3 of 3 failed: a task in review of its result, and a checks task that completed, had no `deliveredAt`.
- `tests/engine/rule-reactivation.test.ts`, 3 of 3 failed: registering a retired version again with the same content failed with `RULE_RETIRED`, which also made the limit test fail with that code instead of `VALIDATION_ERROR`.
- `tests/engine/close-markers.test.ts`, 3 of 4 failed: neither the interrupted turn nor the queued task, in any close mode, had `pausedByClose`. `0029-D02`, which checks that a turn a session pause had interrupted is not marked, passed on the base, which marked nothing.
- `tests/contract/usage-by-task-sdk.test.ts`, 3 of 3 failed: the SDK had no `usage.byTask`, `initialize` listed no `workflow.usageByTask`, and the same content under a retired version was refused.
- `tests/contract/claude-close-interrupt.test.ts`: `0028-S01 0029-D01`, which now also expects `pausedByClose`, failed; the other seven passed.
- `python/tests/test_usage_by_task_0029.py`, 3 of 3 failed: `usage` had no `by_task`, the host listed no `usage_by_task`, and the same content under a retired version was refused.
- `tests/engine/rule-retirement.test.ts`: `0028-U03 0029-C01` now checks only that other content under a retired version is refused, which the base did.

## Changes

- **Usage by task (A).**
  - `reads.ts` groups records through `modelTotals` and `modelResolver`, which `usage.summary` and the new `usage.byTask` share.
  - `Store.existingTaskIds` and `Store.usageOfTasks` read the tasks and all their records, the second in one statement through `usage_task`.
  - `usage.byTask` is one of the shared reads, so a read-only view answers it.
- **Delivery time (B).** `saveTask` takes a `delivered` flag and sets `deliveredAt` to the same time as `updatedAt`. `requestApproval`, which puts a task in review of its result, and the completion of a task whose checks passed set it.
- **Reactivation (C).**
  - `rules.register` compares a retired version's digest with the request's. The same content rewrites the stored row without `retiredAt`, at the row's own key, and commits `rule.reactivated`; after the commit, the rule leaves the retired rules and becomes effective.
  - Other content still fails with `RULE_RETIRED`.
  - The limit of 1000 is checked before either.
- **Close marks (D).**
  - The close's transaction marks each queued task it pauses.
  - The terminal of an interrupted flight marks its task when the flight's intent is the close's, that is `shutdown`.
  - `saveTask` removes the mark when a task leaves `paused`.
- **Contract.**
  - `initialize` lists `workflow.usageByTask`, in the engine and in a read-only view.
  - Both SDKs have the method and refuse it before sending to a host without the feature.
  - The schema gains `UsageByTaskParams`, `UsageTaskTotals`, `UsageByTaskResult`, and `TaskSnapshot.deliveredAt` and `pausedByClose`. Python maps `delivered_at`, `paused_by_close` and `was_running`.

Found on the way:

- The design marked the tasks of `interrupt` and `pause` closes only. A `drain` close pauses the queued tasks as well, so D01 marks those too; a `drain` close interrupts no turn.
- The first version of the runtime-permission test gave its fake runtime a new native session identity on the second dispatch. The engine then could not confirm that the turn stopped, and blocked the task as `outcome_unknown`. The test now keeps the session's identity, as a real runtime does.

## GREEN

- The new and changed tests that name SPEC-0029 passed, and so did the other tests of their files. `test_usage_by_task_0029.py`: 3 of 3.
- `npm test`: 715 of 715 (698 before). `npm run test:python`: 101 of 101 (98 before).
- `npm run typecheck`, `npm run format:check` and `npm run check:generated` (82 definitions) passed.
- `npm run build:packages`, `scripts/build-python.py` with the pinned build tools and `npm run test:packages`: nine installation and bundle modes passed.
- The eight new and changed test files, run eight times each with eight runs at a time: 64 of 64 passed.

Measured on the recording Mac, on a store with 10,000 tasks and 50,000 usage records: `usage.byTask` of 100 tasks took 0.79 ms in process, and 100 separate `usage.get` calls 1.57 ms. A host that calls through a socket or stdio also saves 99 round trips per page.

## Mutation checks

Each mutation was applied alone to the implementation and the test file named was run; all 26 were caught.

| Mutation | Result |
| --- | --- |
| A task counts its children's records | caught by `0029-A01` |
| Tasks in database order instead of the order requested | caught by `0029-A01` |
| No model for records written before SPEC-0028 E01 | caught by `0029-A01` |
| A repeated task ID accepted | caught by `0029-A01` |
| One statement per task instead of one for all | caught by `0029-A02`, after the correction below |
| A statement that cannot use `usage_task` | caught by `0029-A02` |
| A read-only view without the feature | caught by `0029-A03` |
| The TypeScript SDK sends `usage.byTask` to a host without the feature | caught by `0029-A04` |
| A review of the result does not set `deliveredAt` | caught by `0029-B01` |
| A runtime permission's review sets it | caught by `0029-B01` |
| A failed check sets it | caught by `0029-B01 0029-B02` |
| An approval sets it | caught by `0029-B01` |
| The same content under a retired version still refused | caught by `0029-C01` |
| No `rule.reactivated` event | caught by `0029-C01` |
| A reactivated rule stays retired in memory | caught by `0029-C01` |
| Other content reactivates a retired version too | caught by `0028-U03 0029-C01` |
| Reactivation adds a row and keeps the retired one | caught by `0029-C02` |
| Reactivation ignores the limit of 1000 | caught by `0029-C03` |
| Queued tasks not marked | caught by `0029-D01` |
| Interrupted turns not marked | caught by `0029-D01` |
| A turn that another request interrupted marked too | caught by `0029-D02` |
| The mark outlives the pause | caught by `0029-D01` (D03) |
| An interrupted turn marked as not running | caught by `0029-D01` |
| The Python SDK sends `usage.by_task` to a host without the feature | caught by `test_0029_a04` |
| Python totals keep their camelCase keys | caught by `test_0029_a04_b03` |
| Python `paused_by_close` keeps camelCase keys | caught by `test_0029_c01_d04` |

One mutation first survived: reading each task's records with its own statement. `0029-A02` counted the distinct statements, and one statement per task repeats one text. It now counts the statements as prepared.

## Not verified

- Real models.
- A usage page with 10,000 tasks in the downstream application; the evidence is the query plan and the engine tests.
