# TDD-0024: Read-path performance

Date: 2026-09-24. Base: `main` at `40d2afe` (0.1.2 and pull request #24). Specification: [SPEC-0024](../specs/0024-read-path-performance.md).

## RED

`tests/engine/read-path.test.ts`, copied into a worktree of `40d2afe` and run there: 4 of 5 tests failed.

- `0024-E01`: behind 5,000 events of other tasks, the first page of a task-filtered read returned no event: `actual: [], expected: [ 'mine' ]`.
- `0024-E02`, interleaved events: with `limit: 2` the first page returned one of the task's events, `[ '2' ]` instead of `[ '2', '5' ]`, because the limit counted the rows the read scanned, not the task's events.
- `0024-E02`, byte budget: the page that reached the budget returned the cursor `'4'`, an event of another task after the last event it returned, `'3'`.
- `0024-E02`, collected log: passed. The old read returned `afterCursor` on an empty log; the test keeps the new cursor jump from moving backwards.
- `0024-X01`: every step read whole tables. Because the first assertion stops the test, a copy that printed the scans instead of asserting them listed each step:
  - read calls: `SCAN approvals` from the approval expiry check (`SELECT data FROM approvals ORDER BY rowid`) and `SCAN messages` from the message expiry check;
  - a scheduler pass with its turn: the same two, `SCAN handoffs` from the handoff expiry, and `SCAN messages` from `pendingMessages` (`SELECT data FROM messages ORDER BY rowid`);
  - a cancel of a task waiting for approval: the first two, and `SCAN messages` from the loop that expires the task's persisted messages.

## Changes

- `Store.events` reads a task's events with `WHERE taskId=? AND cursor>?` through `events_task_cursor`. A page that stops at `limit` events or at the byte budget keeps the cursor of the last event it returned. Otherwise the cursor moves to the store's last event, and never backwards.
- The store creates three partial indexes when it opens: `approvals_pending_expiry`, `messages_persisted_expiry` and `handoffs_pending_expiry`.
- The approval expiry check queries the pending approvals whose `expiresAt` passed instead of loading every approval.
- `pendingMessages`, the cancel path and `expireStoppedMessages` read persisted messages through one helper, `persistedMessages`, which uses the partial index.
- The queries select `rowid` and put the rows in creation order in JavaScript. The first version kept `ORDER BY rowid` in SQL, and X01 still failed: SQLite then scanned the table in row order instead of using the index.

## GREEN

- `tests/engine/read-path.test.ts`: 5 of 5.
- `npm test`: 610 of 610, five more than before. `npm run test:python`: 91 of 91; `events.read` is a wire method, so both suites ran. Typecheck and formatting passed.
- The existing tests of approval, message and handoff expiry (SPEC-0014 H03, SPEC-0017 A04 and A05) and of event cursors pass unchanged.

## Mutation checks

| Mutation | Result |
| --- | --- |
| A page that reaches the byte budget is not marked full | caught by `0024-E02`, byte budget: its cursor jumped past the task's third event |
| The cursor jumps even when the log is behind it | caught by `0024-E02`, collected log: the cursor moved back to `0` |
| A page that is full by `limit` still jumps | caught by `0024-E02`, interleaved events |
| The task-filtered read scans the whole log again | caught by `0024-E01` and `0024-E02` |
| The three partial indexes are not created | caught by `0024-X01` only: `SCAN approvals`, `SCAN messages` |
| The approval query orders by `rowid` in SQL | caught by `0024-X01`: `SCAN approvals` |

## Measurements

The scripts are scratch files, not committed, like the preloads of TDD-0023. Each size uses a new engine whose rows are written through its store, and timings come from `performance.now()` and `process.cpuUsage()` on the same 4-core machine before and after the change. Absolute values differ between machines; the growth with history is the point.

| Measurement | History | Before (`40d2afe`) | After |
| --- | --- | --- | --- |
| Time of one read call (`events.read`, `storage.status` or `usage.get`), with N finished approvals and N messages | N = 10,000 | 21.6 to 21.7 ms | 0.05 to 0.11 ms |
| | N = 50,000 | 138.6 to 145.2 ms | 0.05 to 0.12 ms |
| Time of `scheduler.get`, which skips the approval check | N = 10,000 | 5.8 ms | 0.05 ms |
| | N = 50,000 | 27.5 ms | 0.03 ms |
| `orch.events({ taskId })` until a new task's `approval.requested`, behind N events of other tasks | N = 0 | 51 ms | 52 ms |
| | N = 10,000 | 5,080 ms | 52 ms |
| | N = 50,000 | 25,485 ms | 51 ms |
| Engine CPU while one subscriber reads every 50 ms, with N finished approvals | N = 10,000 | 27% of a core | 1% |
| | N = 50,000 | 88% of a core | 1% |

## Compatibility (X03)

A store that the changed engine had created, with the three indexes, was opened by the engine at `40d2afe` from a worktree of that commit. That engine approved the store's pending approval and ran a second task to its approval. `PRAGMA integrity_check` then returned `ok`, and a query forced through `approvals_pending_expiry` found exactly the second task's pending approval, so the old engine's writes kept the partial index current. The changed engine reopened the store and listed its tasks as completed and waiting for approval.

## Not verified

- Timings on other machines, on other file systems and with real runtimes.
- Stores with more than 50,000 rows in a table. The query plans do not depend on the size, and the engine never runs `ANALYZE`, so SQLite chooses them without table statistics.
