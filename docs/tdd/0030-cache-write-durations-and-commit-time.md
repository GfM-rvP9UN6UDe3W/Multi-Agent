# TDD-0030: Cache writes by duration, one time per commit, and keys for rule changes

Date: 2026-09-26. Base: `b29fa23` (0.1.6 and its release record on `main`). Specification: [SPEC-0030](../specs/0030-cache-write-durations-and-commit-time.md).

## Reproduction

Before the specification, a scratch test on the base reproduced the two reports.

- A retired rule registered again under the key of its first registration: the engine returned the first operation, with the same ID and no `reactivated`, and the rule stayed retired. Retiring a reactivated rule under the key of an earlier retirement left it effective.
- With a clock one day ahead of the process clock, a task's `deliveredAt` and `updatedAt` were the process clock's time, and the `occurredAt` of its `task.waiting_approval` event the engine clock's, one day later.

## RED

The new tests ran on the base, which had only the new and changed tests and the specification.

- `tests/engine/cache-write-durations.test.ts`, 3 of 3 failed. The engine refused an observation with the split as `INVALID_RUNTIME_CONTRACT`, so a runtime that reported one never delivered.
- `tests/contract/claude-cache-write-durations.test.ts`: the test that expects a split failed; the adapter reported none. The test that expects no split passed on the base, which never reported one.
- `tests/contract/cache-write-durations-sdk.test.ts`, 1 of 1 failed: the totals had no split.
- `tests/engine/commit-time.test.ts`, 3 of 3 failed.
  - B01: `deliveredAt` was not the `occurredAt` of `task.waiting_approval`.
  - B02: `updatedAt` was on the process clock.
  - B03: the events of one approval were stamped at three times: `approval.approved` at .592, `task.completed` at .593 and `operation.created` at .596.
- `python/tests/test_cache_write_durations_0030.py`, 1 of 1 failed: the task whose runtime reported a split never delivered.
- `tests/engine/host-workflow.test.ts`: `0030-B01 a handoff request records the time of its transaction`, added after the trace below, failed: the handoff's `createdAt` was a reading taken before its transaction.
- `tests/engine/rule-keys.test.ts` passed on the base: C01 pins the behavior that SPEC-0001 AC02 already required, so it has no RED.

## Changes

- **Cache writes by duration (A).**
  - The Claude adapter reads `usage.cache_creation` and reports `cacheWrite5mInputTokens` and `cacheWrite1hInputTokens` only when both are non-negative integers that add up to `cache_creation_input_tokens`.
  - `usageRecord` accepts the two counts on any runtime's observation, both or neither, adding up to `cacheWriteInputTokens`, and refuses anything else with `INVALID_RUNTIME_CONTRACT`. The record keeps them only when reported, and a repeated report is compared on them.
  - `usage.recorded` carries them when the record has them. `totals` in `reads.ts` sums them, so `usage.summary`, `usage.byTask` and a read-only view report them.
  - The schema's `UsageRecord` and `UsageRecordedData` gain them as optional fields, `UsageTotals` and `UsageModelTotals` as required ones; the generated types follow, and Python maps `cache_write_5m_input_tokens` and `cache_write_1h_input_tokens`.
- **One time per transaction (B).**
  - `Store.transaction` reads the clock once after `BEGIN` and clears the reading when the transaction ends. `Store.wallTime()` returns that reading inside a transaction and a new one outside it; events and retention records take their times from it.
  - The engine reads its wall clock only through `wall()` and `time()`, which use `Store.wallTime()`. The module's process-clock `now()` is gone: a task's `updatedAt` and a dispatch's `createdAt` used it.
  - A handoff request is built inside its transaction, so its `createdAt` and `expiresAt` are the transaction's.
- **Keys for rule changes (C).** The guide's section on retiring rules and the concepts' section on idempotency say that a key names one request, and that reactivating or retiring a rule again takes a new key.
- The totals that `0028-P03` and `0029-A01` expect gain the two counts, 0 for records without a split.

Found on the way:

- The first version of the validation refused one duration alone through a separate check. A missing count is not a safe integer, so the check was redundant, and a mutation that removed it survived; it was removed.
- A trace of every clock reading outside a transaction, over the whole suite, found the handoff request above. The other readings compare with deadlines or arm timers, or are the two times that SPEC-0030 B02 names: an execution budget's `enteredAt`, read with its monotonic start, and the time of an internal failure. Tool calls, which no method returns, keep their own readings.

## GREEN

- The new and changed tests that name SPEC-0030 passed, and so did the other tests of their files. `test_cache_write_durations_0030.py`: 1 of 1.
- `npm test`: 726 of 726 (715 before). `npm run test:python`: 102 of 102 (101 before).
- `npm run typecheck`, `npm run format:check` and `npm run check:generated` (82 definitions) passed.
- `npm run build:packages`, `scripts/build-python.py` with the pinned build tools and `npm run test:packages`: nine installation and bundle modes passed.
- The eight new and changed test files, run eight times each with eight runs at a time: 64 of 64 passed.

## Mutation checks

Each mutation was applied alone to the implementation and the tests named were run; all 20 were caught.

| Mutation | Result |
| --- | --- |
| A missing duration counts as zero | caught by `0030-A02` |
| Durations that do not add up accepted | caught by `0030-A02` |
| A negative duration accepted | caught by `0030-A02` |
| The record drops the split | caught by `0030-A03`, `0030-A04` |
| `usage.recorded` drops the split | caught by `0030-A03` |
| `usage.recorded` carries zero durations without a split | caught by `0030-A03` |
| Totals swap the durations | caught by `0030-A04` |
| Totals count every cache write as five minutes | caught by `0030-A04` |
| The adapter reports a split that does not add up | caught by `0030-A01` |
| The adapter swaps the durations | caught by `0030-A01` |
| The adapter splits without a cache-write count | caught by `0030-A01` |
| The schema does not require the durations in totals | caught by `0030-A05` |
| Python keeps camelCase durations | caught by `test_0030_a05` |
| No reading per transaction | caught by `0030-B01`, `0030-B03` |
| Events read the clock themselves | caught by `0030-B01`, `0030-B03` |
| A task update reads the process clock | caught by `0030-B01`, `0030-B02` |
| A dispatch reads the process clock | caught by `0030-B02` |
| The reading outlives its transaction | caught by `0014-H03` and `0017-A04`: handoffs no longer expired on time |
| A handoff reads its creation time apart from its transaction | caught by `0030-B01` |
| A replayed rule key executes again | caught by `0030-C01` |

Two mutations first survived, and both were equivalent: removing the redundant check above, and a `usage.recorded` that always listed the durations, which JSON drops when they are undefined. They were replaced by the first and sixth rows.

## Not verified

- Real models. That Claude's two durations always add up to its cache writes is taken from its SDK, which adds each field across calls; no recorded native usage had cache writes.
