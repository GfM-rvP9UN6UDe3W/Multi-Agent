# SPEC-0028: Task queries, self-contained events, queue reasons, a pausing close, rule retirement and a non-blocking reserve

Date: 2026-09-26. Status: approved by the owner on 2026-09-26, with the recommended option of each decision on the downstream host's report. Release: 0.1.5. Evidence: [TDD-0028](../tdd/0028-host-queries-and-lifecycle.md).

## Why

The rest of the report that [SPEC-0027](./0027-read-only-access-and-host-corrections.md) answered in part. A desktop host that embeds the engine could meet each of these needs only by reading more than it wanted, by keeping its own copy of engine state, or not at all.

- **P:** a host that asks whether any task is active listed every task. Showing a conversation's tasks newest first meant reading all of them. A timeline that showed N tasks made N calls to `tasks.get`. Token totals per conversation came from `usage.get` on each task, and `usage.get` read the whole usage table each time.
- **E:** `usage.recorded` named a usage record, and the host read the record to learn its tokens and model. `verification.completed` said that a check failed, but not what it printed.
- **B:** a queued task did not say why it waited: for a free execution slot, its session, another task's write paths, storage, or nothing.
- **S:** closing with `interrupt` marks the interrupted turns `runtime_interrupted`, as if the runtime had stopped by itself. A host that closes because the user quits cannot tell those turns from ones that the runtime interrupted.
- **U:** a verification rule registered at runtime stayed effective for good. A host that replaced rules as its projects changed reached the limit of 1000 effective rules.
- **W:** the engine wrote its emergency reserve, 256 MiB by default, synchronously while it started. In an Electron main process that blocked the window for as long as the disk took.

## Acceptance criteria

### P: Task queries and token totals

- **P01** `tasks.list` accepts `status`, a list of 1 to 10 distinct task statuses, and `order`, `asc` (the default) or `desc`. `status` can be combined with one of `parentTaskId`, `sessionId` and `label`. A `desc` page starts with the newest matching task, and its `nextCursor` continues with older ones. An unknown or repeated status, an empty or longer list, and another order fail with `VALIDATION_ERROR`.
- **P02** `tasks.getMany({ taskIds })` takes 1 to 100 distinct task IDs and returns `{ tasks, missing }`: the tasks that exist and the IDs that do not, each in the order of the request. An empty, longer or repeated list fails with `VALIDATION_ERROR`.
- **P03** `usage.summary({ rootTaskId })` totals the usage records of a root task and of every task whose `rootTaskId` names it. It returns `{ rootTaskId, byModel, totals, completeness }`.
  - `byModel` has one entry per provider and model, ordered by provider and then model, with an unknown model last: `{ provider, model, records, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, unknownRecords }`. Each token count is the sum over the records that report it. `unknownRecords` counts the records whose input or output count is null.
  - `totals` has the same counts over all the records. `completeness` is `reported` when there is at least one record and no record is unknown, and `unknown` otherwise, as for `usage.get`.
  - A record written before this version has no `model` and takes the model of its dispatch's session. When that dispatch or session was collected, `model` is null.
  - A task that has a parent fails with `VALIDATION_ERROR`, and an unknown task with `NOT_FOUND`.
- **P04** The statements of `tasks.list` with `status`, `tasks.getMany`, `usage.summary` and `usage.get` read no whole `tasks` or `usage` table. `status` searches the index `tasks_status`. `usage.summary` searches the new index `tasks_root` on a task's `rootTaskId` and the new index `usage_task` on a usage record's `taskId`, and `usage.get` searches `usage_task`.
- **P05** `initialize` lists `workflow.taskQueries`. Both SDKs expose the new parameters and methods, and refuse them before sending when a host does not list it. A read-only view (SPEC-0027 R) answers them through the same code.

### E: Events that carry their content

- **E01** A usage record written from this version on also holds `sessionId`, `model` (its session's model), `rootTaskId` and `recordedAt`. A repeated report of an observation is compared with the stored record on the fields that earlier versions stored: the identity, the four token counts and `raw`. A late repeat is therefore accepted as before, and not refused with `IDEMPOTENCY_CONFLICT` because its time differs.
- **E02** The data of `usage.recorded` also holds the four token counts, `model` and `rootTaskId`. It does not hold `raw`, which can be 512 KiB; `usage.getRecord` returns it. The envelope's `sessionId` and `occurredAt` give the session and the time.
- **E03** In `verification.completed`, each failed rule also holds `outputTail`, the end of its output that the retry prompt shows (SPEC-0022 V02): at most 4096 bytes for a rule and 16384 bytes for the failed rules of one event, chosen by the same function as for the prompt. A failed rule whose tail does not fit holds `outputOmitted: 'limit'` instead. This supersedes SPEC-0022 V04: the event now carries output text, which contains whatever the check printed, such as workspace paths or secrets.
- **E04** The schema's `UsageRecord` and `UsageRecordedData` describe the new fields as optional properties. Both SDKs return them unchanged.

### B: Why a task waits

- **B01** `tasks.get`, `tasks.list` and `tasks.getMany` return `blockedBy`, `{ reason, taskIds?, sessionId? }`, on a queued task and on a task that waits for its dependencies. It is computed when the task is read, and it is neither stored nor announced by an event. For a queued task, `reason` is the first of these that holds:
  - `scheduler_failed`: the engine stopped after an internal failure;
  - `host_stopping`: the host is closing;
  - `capacity`: every execution slot is held, and `taskIds` are the tasks that hold them;
  - `quarantine_capacity`: quarantined and reserved dispatches fill the quarantine capacity;
  - `resource_cleanup`: an owner's resource cleanup is pending on this host;
  - `execution_conflict`: an execution evidence conflict is open;
  - `storage`: storage is backpressured, or a rollover is being settled;
  - `session_busy`: the task's session is not ready. `sessionId` is the session, and `taskIds` are the tasks that hold it: those with an active dispatch on it, and the session's current task when that task has not ended;
  - `write_conflict`: the task's write paths overlap those of a held lease or a pending verification, and `taskIds` are those tasks;
  - `scheduling`: nothing above holds, and the scheduler's next pass takes the task.

  A task that waits for its dependencies has `{ reason: 'dependency', taskIds }`, where `taskIds` are the dependencies that have not completed.
- **B02** The scheduler and the reads decide with the same functions: the scheduler snapshot, the storage check, the session check and the holders of conflicting write paths. In each case of B01 other than `scheduling`, the scheduler does not dispatch the task; once the cause is gone, it does. `storage.configure` now starts a scheduler pass, as the other changes that can free a task already did, so a task that waited for storage runs when a new policy ends the backpressure.
- **B03** Other tasks have no `blockedBy`, and a read-only view never returns it. `initialize` lists `workflow.queueReasons`. A budget is not a queue reason: a task that its budget does not allow is paused, with the reason in its `reason`.

### S: A close that pauses

- **S01** `close({ mode: 'pause' })` in either SDK and `host.shutdown` with `mode: 'pause'` close as `interrupt` does (SPEC-0022 C01, C02). Admission stops, queued tasks become `paused` with `owner_shutdown`, and running turns are interrupted and awaited. A turn that this close interrupted and that reports its interrupted terminal pauses its task with `owner_shutdown`, not `runtime_interrupted`.
- **S02** The close marks each turn it interrupts before it aborts that turn, and the terminal reads the mark. No task therefore passes through `runtime_interrupted`. A turn that another request had already interrupted keeps `runtime_interrupted`. A turn that does not report an interrupted terminal within the wait ends as with `interrupt`: `blocked` with `outcome_unknown`.
- **S03** `drain` and `interrupt` behave as before.
- **S04** `host.shutdown.continue` and the command-line configuration's `shutdown.mode` also accept `pause`. `initialize` lists `workflow.pauseClose`, and both SDKs refuse `pause` before sending when a host does not list it. The schema's new `HostShutdownParams` describes the parameters of both shutdown methods.

### U: Retiring verification rules

- **U01** `rules.retire({ id, version, idempotencyKey })`, for the owner only, retires a rule registered at runtime. Its stored row gets `retiredAt`, and the event `rule.retired` is committed with it. The rule leaves the effective rules at once: it no longer counts toward the 1000 effective rules, and a task that names it fails admission with `RULE_RETIRED`. Retiring a retired rule changes nothing and completes as `noop`. An unknown rule fails with `UNKNOWN_VERIFICATION_RULE`.
- **U02** A task admitted before its rule was retired keeps its frozen copy: its verification and its repair retries run the rule as before.
- **U03** A rule of the configuration cannot be retired (`VALIDATION_ERROR`). A retired `id` and `version` cannot be registered again (`RULE_RETIRED`); a changed rule takes a new version.
- **U04** Retired rules stay retired after a restart, a rollover and an import, and they never keep an engine from starting: retired rows are left out before the effective rules are validated, so a retired row cannot conflict with a configured rule either. `rules.list` returns the effective rules; with `includeRetired: true`, it also returns the retired ones after them, each with its `retiredAt`. A read-only view answers the same.
- **U05** `initialize` lists `workflow.ruleRetirement`. Both SDKs have `rules.retire` and the `includeRetired` option, and refuse them before sending when a host does not list it. The schema gains `RuleRetireParams`, `RuleListParams` and the rule's `retiredAt`.

### W: A reserve that does not block, and settings for desktop hosts

- **W01** `createEngine` writes the emergency reserve through `fs.promises`, in chunks of at most 1 MiB, and the event loop runs between them. A `setImmediate` callback scheduled just before `createEngine` runs before `createEngine` resolves, while the reserve is not complete.
- **W02** When `createEngine` resolves, `emergency.reserve` has its full size and was synced with its directory. The reserve is written to `emergency.reserve.partial` and renamed when complete, so a file named `emergency.reserve` is always complete, and admission's check of the reserve means what it meant before. A partial file that a crash left is removed at the next start. `storage.configure` and the store switch of a rollover or an import write a missing reserve the same way before they return, and a close waits for such a write.
- **W03** The test guard of SPEC-0011 R10 also stops writes through `fs.promises` file handles, to either file name.
- **W04** The guide's section on desktop hosts recommends settings and says why: `storage.quotaBytes` 2 GiB, `storage.minFreeBytes` 512 MiB and `storage.emergencyBytes` 32 MiB; `limits.defaultMaxQueueWaitMs` of seven days; and `cleanupTimeoutMs` 5000 for the Claude adapter.

## Timing invariants

- **S02** For each flight that it interrupts, the pausing close marks the flight before it calls `abort()` on the flight's controller. The terminal handler reads the mark in the transaction that writes the task's status, so the reason is chosen once. A flight that already had another intent, such as a session pause, is not marked.
- **W01, W02** `createEngine` returns the engine only after the renamed reserve and its directory were synced. Recovery, which needs no reserve, still runs before the reserve is written. The scheduler is not started by the constructor: as before, the first scheduler pass follows a call.
- **B01** `blockedBy` is computed inside the read, from state that the same call reads. A list computes the scheduler snapshot and the storage status at most once.

## Tests

- Engine: filters, combinations, order and pages; `getMany` order and missing IDs; summaries with children, several models and records written without `model`; the statements of each query and their plans (P01 to P04).
- Engine: the new record fields and a late repeat; the event data; failed rules with output tails within the budgets, and the omitted ones (E01 to E03).
- Engine: each queue reason with the scheduler's behavior for it, and the task dispatched once the cause is gone; dependencies; other statuses and the read-only view (B01 to B03).
- Contract: a pausing close with the offline Claude runtime, a turn that does not answer, and a turn that a session pause interrupted first (S01 to S03).
- Engine: retiring, admission, the limit, frozen copies with a repair retry, the refusals, restart, rollover and import (U01 to U04).
- Engine and contract: the event loop during `createEngine`, the reserve when it resolves, a partial file from an earlier start, and the guard with an asynchronous writer (W01 to W03).
- SDK and schema: every new method and option from TypeScript and Python against a real host, their refusals before sending, the command-line configuration, and real payloads checked against the new definitions (P05, E04, S04, U05).

## Not in this increment

- `blockedBy` does not say when a task will run. It does not name the reason for a task that another host's scheduler would take.
- A budget does not appear as a queue reason (B03).
- Retired rules are kept; nothing collects them. `rules.list` with `includeRetired` returns every retired rule in one page.
