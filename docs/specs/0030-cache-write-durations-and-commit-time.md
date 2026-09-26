# SPEC-0030: Cache writes by duration, one time per commit, and keys for rule changes

Date: 2026-09-26. Status: approved by the owner on 2026-09-26, who chose option 1 of both decisions that the downstream host's report on 0.1.6 raised and approved this design. Release: 0.1.7. Evidence: [TDD-0030](../tdd/0030-cache-write-durations-and-commit-time.md).

## Why

The desktop host that [SPEC-0029](./0029-usage-by-task-and-close-markers.md) served adopted 0.1.6 and reported three things.

- **A:** its usage page prices cache writes at two rates: Anthropic charges a write that lives five minutes and one that lives an hour differently. The host read the two counts from each usage record's `raw`, so it kept reading `usage.get` once per task. `usage.byTask` has only the sum of both.
- **B:** a task's `deliveredAt` and the `occurredAt` of the event that delivered it could differ by a millisecond. The engine stamped a task with the process clock and events with its own clock (`EngineClock`), in two readings. With a clock passed in `EngineConfig`, the two differed by that clock's whole offset.
- **C:** registering a retired rule again under the idempotency key of its first registration reactivated nothing and reported success. The engine returned the first registration: a key names one request, and a replay returns that request's result and changes nothing ([SPEC-0001](./0001-foundation.md) AC02). Retiring a reactivated rule under the key of an earlier retirement does the same. This is the contract, but the guide did not say so for rules.

## Acceptance criteria

### A: Cache writes by duration

- **A01** The Claude adapter reads the result's `usage.cache_creation`. When `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` are both non-negative integers and add up to `cache_creation_input_tokens`, its usage observation also holds `cacheWrite5mInputTokens` and `cacheWrite1hInputTokens`. Otherwise it holds neither, and its other counts are unchanged.
- **A02** The engine accepts the two counts on any runtime's usage observation, both or neither. Each is a non-negative safe integer, and together they equal `cacheWriteInputTokens`. Any other combination fails with `INVALID_RUNTIME_CONTRACT`, and nothing is stored, as for other malformed usage.
- **A03** The usage record holds the two counts, and the event `usage.recorded` carries them, only when the observation reported them. A repeated report of an observation is compared on them too.
- **A04** The totals of `usage.summary` and `usage.byTask`, overall and per model, hold `cacheWrite5mInputTokens` and `cacheWrite1hInputTokens`: each the sum over the records that report it. `cacheWriteInputTokens` minus both is the cache writes of the records without a split: records written before this version, and records of runtimes that do not report one.
- **A05** A read-only view returns the same totals. Both SDKs return the counts; Python names them `cache_write_5m_input_tokens` and `cache_write_1h_input_tokens`. The schema's `UsageRecord` and `UsageRecordedData` gain them as optional fields, and `UsageTotals` and `UsageModelTotals` as required ones.

### B: One time per commit

- **B01** The engine reads its clock once for each transaction, when the transaction begins, and gives the change it writes there that reading. This covers:
  - a task's `createdAt`, `updatedAt` and `deliveredAt`;
  - a dispatch's `createdAt`;
  - a handoff request's `createdAt`, and its `expiresAt`, which is derived from it;
  - every event's `occurredAt`;
  - the other times and deadlines the engine computes from its clock in that transaction.

  A task's `deliveredAt` therefore equals the `occurredAt` of the `task.waiting_approval` or `task.completed` event of the same change, and its `updatedAt` equals the `occurredAt` of the event that its change committed. A handoff request's `createdAt` equals the `occurredAt` of its `handoff.requested` event.
- **B02** No time on a task, dispatch, handoff request or event comes from the process clock: a clock passed in `EngineConfig` governs all of them. Before, a task's `updatedAt` and a dispatch's `createdAt` did not follow it. Two times describe a moment before their transaction and keep their own reading of the engine clock: an execution budget's `enteredAt`, which is read with its monotonic start (SPEC-0003-A2), and the time of an internal failure (SPEC-0025 F01). Archive manifests and the control plane's records of stores keep their own times.
- **B03** Events committed in one transaction share one `occurredAt`, and `occurredAt` never decreases in cursor order while the clock does not go back.

### C: Keys for rule changes

- **C01** Registering a retired rule under the key of its first registration returns that registration's operation and leaves the rule retired. Retiring a reactivated rule under the key of its earlier retirement returns that retirement's operation and leaves the rule effective. Both are replays, as SPEC-0001 AC02 requires.
- **C02** The guide's section on retiring rules and the concepts' section on idempotency say that a key names one request. Reactivating a version, or retiring it again, takes a new key, for example one that names the retirement it undoes.

## Timing invariants

- **B01** Transactions run one at a time on the engine's thread, and each takes its reading after `BEGIN`. A transaction that commits after another therefore has a reading that is not earlier, unless the clock itself went back.
- **B01** A time read outside a transaction takes its own reading, as before. Outside a transaction the engine reads its clock to compare with deadlines, to arm timers, and for the two times that B02 names.
- **A03** A record's counts and its `usage.recorded` event are written in one transaction, as before.

## Tests

- Claude adapter: a result whose split adds up; one that does not; one without `cache_creation`; one whose counts are not integers (A01).
- Engine: observations with both counts, one count, counts that do not add up, a negative count, and a split without a cache-write count (A02). The record, the event and a repeated report (A03). Totals of records with and without a split, per model, through `usage.summary` and `usage.byTask` (A04). A read-only view (A05).
- SDK and schema: real payloads over a Unix host and from Python, and refusals of payloads without the new totals (A05).
- Engine, with a clock one day ahead of the process clock, and with a clock that advances at each reading:
  - a human task's delivery, a checks task's completion and a handoff request (B01);
  - the times of tasks and dispatches (B02);
  - the events of a task in cursor order (B03).
- Engine: both replays (C01).

## Not in this increment

- Registered prices keep one rate for cache writes, so the engine's cost estimates remain approximate for writes that live an hour.
- Records written before this version are not rewritten, and the engine does not read `raw`.
- Other pricing dimensions in Anthropic's `usage`, such as `service_tier`.
