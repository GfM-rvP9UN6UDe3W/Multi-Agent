# SPEC-0029: Usage by task, the time a task delivered, reactivating rules and tasks that a close paused

Date: 2026-09-26. Status: approved by the owner on 2026-09-26, who chose option 1 of both decisions that the downstream host's report on 0.1.5 raised and approved this design. Release: 0.1.6. Evidence: [TDD-0029](../tdd/0029-usage-by-task-and-close-markers.md).

## Why

The desktop host that [SPEC-0028](./0028-host-queries-and-lifecycle.md) served adopted 0.1.5, and reported what it could still not do without going around the engine.

- **A:** its usage page shows one row per task of a project or a group chat, with each task's token counts per model. `usage.summary` totals a whole tree, so the page read `usage.get` once per task: with the reads of B, about two calls per task, for up to 10,000 tasks.
- **B:** each row shows when the task last handed back its result. The host found that time by reading each task's events.
- **C:** the host names a rule's version by a hash of its command. When a user returned to an earlier command, the version was one the host had retired, and SPEC-0028 U03 refused to register it again. The host therefore did not retire rules at all.
- **D:** after `close({ mode: 'pause' })`, the turns the close interrupted and the queued tasks it paused are all `paused` with `owner_shutdown`, and no field of a task says which of them was running. A host that resumed them in the order of their events resumed a queued writer before the interrupted writer of the same files. The host read the events to tell them apart.

## Acceptance criteria

### A: Usage by task

- **A01** `usage.byTask({ taskIds })` takes 1 to 100 distinct task IDs and returns `{ tasks, missing }`. `tasks` holds, for each task that exists and in the order requested, `{ taskId, byModel, totals, completeness }` over that task's own usage records, not its children's. `missing` holds the IDs that name no task, in the order requested. Groups, sums, `unknownRecords`, `completeness` and the model of a record written before SPEC-0028 E01 are those of `usage.summary` (SPEC-0028 P03), from the same code. An empty, longer or repeated list fails with `VALIDATION_ERROR`.
- **A02** Its statements read no whole `tasks` or `usage` table. One statement reads the records of all the tasks through `usage_task`.
- **A03** A read-only view answers it through the same code (SPEC-0027 R03).
- **A04** `initialize` lists `workflow.usageByTask`, and both SDKs refuse the method before sending when a host does not list it. The schema gains `UsageByTaskParams`, `UsageTaskTotals` and `UsageByTaskResult`.

### B: When a task delivered its result

- **B01** A task snapshot holds `deliveredAt`, the time the task last delivered a result.
  - For human acceptance, each time the task enters `waiting_approval` for the review of its result. This includes a result offered again, after its approval expired or after an owner's reconciliation.
  - For checks acceptance, when its checks pass and it completes.
  - Entering `waiting_approval` for a runtime permission does not change it. Neither do an approval, a denial, a failed check or a repair.
- **B02** The engine writes it in the transaction that makes that change, so a read-only view returns it too. A task that delivered before this version has none, and a compaction task has none.
- **B03** The schema's `TaskSnapshot` gains `deliveredAt`.

### C: Reactivating a retired rule

- **C01** `rules.register` of a retired `id` and `version` with the same content reactivates the rule:
  - its row loses `retiredAt`, and it is effective again;
  - the event `rule.reactivated` is committed with it;
  - the operation's result holds `reactivated: true`.

  Other content still fails with `RULE_RETIRED`. This supersedes the part of SPEC-0028 U03 that refused the same content.
- **C02** A reactivated rule stays effective after a restart, a rollover and an import, and can be retired again.
- **C03** Reactivation counts toward the 1000 effective rules as a registration does: when 1000 are effective, it fails with `VALIDATION_ERROR` and the rule stays retired.

### D: Tasks that a close paused

- **D01** A close marks the tasks it pauses:
  - A queued task that a close of any mode pauses gets `pausedByClose: { operationId, wasRunning: false }`.
  - A task whose turn a close with mode `interrupt` or `pause` interrupted, once that turn reports its interrupted terminal and the task is paused, gets `pausedByClose: { operationId, wasRunning: true }`. A `drain` close interrupts no turn.

  `operationId` is the close's shutdown operation. The field is written in the transaction that pauses the task.
- **D02** A task paused by anything else has no `pausedByClose`.
  - A turn that another request had already interrupted, such as a session pause, is not the close's.
  - A turn that does not report an interrupted terminal is blocked with `outcome_unknown`, not paused.
- **D03** The field is removed when the task leaves `paused`, for example when `tasks.resume` queues it again or it is cancelled.
- **D04** The guide's section on shutdown says to resume the tasks with `wasRunning: true` first. The schema's `TaskSnapshot` gains `pausedByClose`.

## Timing invariants

- **B01, D01** Each field is written with the status change it describes, in one transaction; no reader sees one without the other.
- **D01** The close sets a flight's intent before it aborts the flight (SPEC-0028 S02), and the terminal handler marks the task only when that intent is the close's. A flight that already had another intent is never marked.

## Tests

- Engine: the totals of several tasks with several models and records written without a model, compared with `usage.get` of each task; order, missing IDs and refusals; the statements and their plans; a read-only view (A01 to A03).
- Engine: a human task that delivers, is revised, waits for a runtime permission and delivers again; a checks task that fails once, is repaired and passes; one that fails without a repair; a read-only view (B01, B02).
- Engine: reactivation with the same content, refusal of other content, the event and the result; restart, rollover and import; the limit (C01 to C03).
- Engine: both close modes with a running and a queued task; resuming and cancelling; a turn that a session pause is interrupting; the Claude runtime's close (D01 to D03).
- SDK and schema: the method from TypeScript and Python against real hosts, refusals before sending, and real payloads checked against the new definitions (A04, B03, D04).

## Not in this increment

- Time-range filters on usage, and costs per task, which the host computes from its own price list.
- Labels for tasks created before labels existed; the host keeps its own fallback for those few tasks.
