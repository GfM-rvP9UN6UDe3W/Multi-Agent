# SPEC-0024: Read-path performance

Date: 2026-09-24. Status: approved by the owner on 2026-09-24, who accepted the review's recommendation to correct these two findings first. Evidence: [TDD-0024](../tdd/0024-read-path-performance.md).

## Why

A review of 0.1.2 measured two costs that grow with a store's history rather than with its current work.

- **Task events.** `events.read` with `taskId` reads the whole event log after the cursor, `limit` rows at a time, and filters the rows in JavaScript, although the index `events_task_cursor` on `(taskId, cursor)` exists. Both SDK iterators wait 50 ms after a page that returned no event. A new task's first event therefore reached `orch.events({ taskId })` 0.5 seconds after it was written behind 1,000 events of other tasks, 5.1 seconds behind 10,000 and 25.5 seconds behind 50,000. The quickstart waits 10 seconds. The log also keeps more than its 30 days: it is collected only as a continuous prefix, which stops at the first event of a task that is still open or ended less than 90 days ago, and at most 500 events an hour.
- **Expiry checks.** Before every call except `scheduler.get` and `scheduler.getConflict`, the engine loads and parses every approval to find the pending ones that expired, and before every call it reads every message through `json_extract` to find the persisted ones that expired. Each scheduler pass reads every handoff, and each dispatch, like each cancel of a task that is not running, loads every message to find its persisted ones. Approvals are never collected. With 10,000 rows in each of these tables every call cost about 22 ms more, with 50,000 about 140 ms. One idle event subscriber, which reads every 50 ms, used 27% of a core with 10,000 finished approvals and 88% with 50,000, on the engine's single thread.

## Acceptance criteria

### E: Task-filtered event reads

- **E01** `events.read` with `taskId` reads only that task's events after `afterCursor`, through the index on `(taskId, cursor)`, in cursor order, at most `limit` of them and within the 768 KiB page budget. How long it takes does not depend on the events of other tasks.
- **E02** Its cursor never skips an event of the task that it did not return. When the page stops at `limit` events or at the byte budget, the cursor is that of the last event it returned. Otherwise every event of the task up to the store's last event has been returned, and the cursor is the store's last event cursor at the time of the read, or `afterCursor` if that is larger; the events of other tasks in between are not the reader's.
- **E03** Reads without `taskId`, the cursor checks (`CURSOR_EXPIRED` and the store identity), the retention floor and the page budget are unchanged.

The SDKs do not change. With this host a task-filtered page returns no event only when the reader has caught up, so the iterators' 50 ms wait after such a page is right. Waiting only when the cursor did not move was considered and rejected: this host moves the cursor of a caught-up reader whenever another task wrote an event, so on a busy host the iterator would read without pause.

### X: Pending approvals, messages and handoffs

- **X01** The engine reads pending approvals, persisted messages and pending handoffs only through partial indexes that hold just those rows, keyed by `expiresAt`: in the expiry checks before each call, in each scheduler pass and dispatch, and when the messages of a cancelled task or a stopped session expire. None of these reads touches a finished approval, message or handoff, so their cost does not grow with history.
- **X02** They find, deliver and expire the same rows as before, in the order in which the rows were created, with the same state changes and events. `expiresAt` is compared as the UTC ISO 8601 string that the engine writes with `toISOString()`, as the message check already did. The rows are put in creation order after the query: an `ORDER BY rowid` in it makes SQLite scan the table in row order instead of using the index.
- **X03** The indexes are created with `CREATE INDEX IF NOT EXISTS` when a store opens, like the store's other indexes. The storage schema stays 3. An engine without them opens a store that has them, and SQLite keeps them current on its writes.

## Not in scope

- The event log's retention and collection, which SPEC-0003 B defines. E01 makes task-filtered reads independent of the log's size instead.
- Other reads that grow with history outside the calls and passes above: the cost ledger's budget checks read every cost row once per dispatch, and recovery at startup reads every approval, task and, for a task that was running, every message.

## Tests

Deterministic, with no timing assertions:

- A task-filtered read from the start of a store that holds 5,000 events of other tasks returns the task's first event in its first page (E01).
- A task-filtered read with a small `limit` pages through a task's events interleaved with other tasks' events without skipping one, and its cursor jumps to the store's last event when the page is not full (E02). After every event was collected, the cursor stays at `afterCursor` (E02).
- The statements that read calls, a scheduler pass with its turn, and a cancel prepare are explained with `EXPLAIN QUERY PLAN`: none reads the whole approvals, messages or handoffs table (X01).
- The existing tests of approval, message and handoff expiry, and of event reads and cursors, pass unchanged (E03, X02).

TDD-0024 records the timings before and after and a store with the indexes opened by an engine without them (X03).
