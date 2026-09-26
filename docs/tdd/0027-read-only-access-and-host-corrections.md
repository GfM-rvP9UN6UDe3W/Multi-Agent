# TDD-0027: Read-only access, task labels and host-facing corrections

Date: 2026-09-26. Base: `6aac1ae` (0.1.3 and its release record on `main`). Specification: [SPEC-0027](../specs/0027-read-only-access-and-host-corrections.md).

## RED

The new tests were copied onto a clean checkout of the base and run there.

- `tests/engine/cursor-errors.test.ts`, 3 of 3 failed.
  - `0027-C01`: a cursor without its `storeId` failed with `CURSOR_EXPIRED` ("Cursor must belong to this store and retained log") instead of `VALIDATION_ERROR`.
  - `0027-C02`: `CURSOR_EXPIRED` had empty details, where the test expects `reason`, `retentionFloorCursor`, `lastCursor` and `currentStoreId`. The embedded SDK's error had no `data.reason`.
- `tests/engine/fatal-notice.test.ts`, 4 of 4 failed.
  - `0027-F01` and `F02`: with the storage fault of 0025-F01, `onFatal` was never called; each test's 10-second watchdog ended it.
  - `0027-F03`: a failed storage collection emitted no warning.
- `tests/engine/labels.test.ts`, 7 of 7 failed. `initialize` listed no `workflow.labels`, and `tasks.create` refused `label` with `VALIDATION_ERROR: Unknown field: label`, in the engine and through the TypeScript SDK.
- `tests/engine/read-only.test.ts` failed to load: `@orchvia/sdk` exported no `openOrchestratorReadOnly`, and the engine no `openReadOnlyEngine`.
- `tests/contract/read-only-host.test.ts`: `0027-R09` failed with `INVALID_ARGUMENT: Unknown argument: --read-only`. The test of refused argument combinations passed, since the base refused them all.
- `tests/contract/adapter-stop-proof.test.ts`, 3 of 3 failed: `createClaudeAdapter({ options: {} })`, the other combinations without an observer, and a writable Codex adapter were all accepted.
- `tests/contract/idempotency-cache.test.ts`, 3 of 4 failed.
  - `0027-K01`: after `sessions.open` with an unlisted model failed with `VALIDATION_ERROR`, the same key with a listed model failed in the SDK with `IDEMPOTENCY_CONFLICT: Retry identity or payload changed`, both in-process and for the five rejection codes tried.
  - `0027-K03`: `forgetIdempotencyKey` did not exist.
  - `0027-K02`, which checks the identities that must be kept, passed: the base kept every identity.
- `tests/contract/public-types.test.ts` ran, but `npm run typecheck` reported 33 errors in the new tests. Among them: `@orchvia/sdk` exported none of `ContextPlanInput`, `TaskSpecInput`, `CostSummary`, `ContextEstimateInput`, `ContextEstimateResult`, `StorageStatus`, `StateSnapshotPage`, `StoragePolicy`, `RolloverRecord` or `SessionControlCommand`; `costs.get`, `context.estimate` and `storage.status` returned `unknown`; and the `@ts-expect-error` on `sessions.control(target, { action: 'explode' })` was unused.
- `python/tests/test_host_corrections_0027.py`, 4 of 4 failed.
  - `TaskSpec` took no `label`.
  - The host listed no `labels` feature.
  - `CURSOR_EXPIRED` data had no `reason`.
  - The corrected `sessions.open` failed locally with `Retry identity or payload changed`.
- T03: the new check in `scripts/package-smoke.mjs`, run against packages built from the base, failed. The base SDK's declarations named `@orchvia/engine/internal/` modules 15 times: 13 times in `index.d.ts` (`types` four times, `control-plane` three, `generated/wire` twice, and `accounting`, `identity`, `storage` and `wire`), once in `transport.d.ts` and once in `routing.d.ts`.

## Changes

- **Cursor errors.** `Store.events` first checks the request and answers `VALIDATION_ERROR` for a cursor that is not decimal, or for a cursor other than `0` without its `storeId`. It then answers `CURSOR_EXPIRED` with a reason and the current cursors, for another store, a collected range or a store behind the cursor.
- **Failure notice.** `stopAfterFailure` keeps the first failure as before, and only for that one queues a microtask. The microtask commits `scheduler.failed` when the store is open, not degraded and outside a transaction, and then calls `EngineConfig.onFatal`, catching what it throws. The storage-collection and usage-persistence failures also warn now, and `orchvia host` prints `SCHEDULER_FAILED` with the failure.
- **Adapters.** `requireStopProof` in `engine/src/stop-observation.ts` is shared by both adapters. It refuses a configuration that cannot prove that a dispatch stopped unless the host passes an observer or `executionStop: 'owner-reconcile'`, and it refuses both together.
- **SDK idempotency.**
  - Both SDKs note whether a call claimed its key: the key held no identity before, and no retry identity was passed.
  - Such a call's identity is forgotten when the engine rejects the call. An engine error carries its code in its data too; the SDK's and the transport's own errors do not. Codes that can follow a commit are excluded.
  - Identities are re-inserted when used and capped at 10,000, oldest first.
  - `forgetIdempotencyKey` / `forget_idempotency_key` remove a key's identities.
- **Types.**
  - `types.ts` defines the input and result types. `StoragePolicy` moved there from `storage.ts`, which re-exports it.
  - `storage.status`, `state.snapshot`, `CostLedger.summary` and `estimateContext` are annotated with those types; `estimateContext` builds a typed result instead of `Json`.
  - The SDK imports only from the engine's public modules.
  - `scripts/build-packages.mjs` maps an import of an exported module to its public name, such as `@orchvia/engine/types`, and only other modules to `internal/`.
- **Labels.**
  - `taskSpec` validates `label` and `metadata`. `sessions.open` accepts them.
  - `newSession` takes labels. The engine passes a task's labels to the sessions it opens for the task, a source's labels to its fork, and a parent's labels to the `work_delegate` child.
  - `tasks.list` filters by `label` through the new index `tasks_label`.
  - `task.*` and `task.created` events carry the label.
  - `RuntimeInput` gets the task chain, the labels and deep-frozen copies of the metadata.
  - The schema gains `label`, `metadata`, `TaskListParams.label`, `workflow.labels` and `capabilities.readOnly`, and `npm run generate:protocol` rewrote the generated files. The Python `TaskSpec` gains the fields, and `to_wire` passes `metadata` without renaming its keys.
- **Read-only access.**
  - `Store.openReadOnly` opens `store.sqlite` with `readOnly: true` and `query_only`, after the same path checks as the engine. It skips everything the writable constructor does, and `assertWritable` refuses with `READ_ONLY`.
  - `engine/src/reads.ts` holds the fourteen reads that the engine and a read-only view share. The engine calls it with its handoff expiry at the same points as before.
  - `engine/src/recovery.ts` selects the rows that recovery changes; `recover()` now acts on these selections, and `recoveryPending` reports whether any exist.
  - `engine/src/read-only.ts` serves `initialize`, `store.info`, `rules.list`, the shared reads, each in one read transaction, and `host.shutdown`, which closes it.
  - The SDK's `ReadOnlyOrchestrator` wraps the read-only engine, and `orchvia host --read-only --state-dir DIR --stdio` serves it.

Found on the way:

- The first version of `0027-R02` compared the reads after the engine closed with the reads while it ran. `close` writes its own events, so `events.read` now compares the earlier page as a prefix.
- `task.created` is written directly, not by `taskEvent`, so it had no label until it got one too.
- `0027-F01` first failed a second time through the hourly storage collection, but that timer returns at once on a stopped engine, so the mutation that calls `onFatal` for every failure survived. The test now reports the second failure through `stopAfterFailure` directly.
- Existing tests that build a Claude adapter with options or the writable profile and no observer now choose `executionStop: 'owner-reconcile'`. They test option handling and the read fence, or, in `AC-P05 missing`, the conservative path without a proof, so owner reconciliation keeps what they tested before. `0014-X02` lists `labels` among the workflow features.
- The spec first named the owner's decisions by an ID that contains the downstream product's name, which `0021-R09` refused.

## GREEN

- The eight new test files: 31 of 31. `test_host_corrections_0027.py`: 4 of 4.
- `npm test`: 658 of 658 (627 before). `npm run test:python`: 95 of 95 (91 before).
- `npm run typecheck`, `npm run format:check` and `npm run check:generated` (69 definitions) passed.
- `npm run build:packages`, `scripts/build-python.py` with the pinned build tools and `npm run test:packages`: nine installation and bundle modes passed, and the SDK's declarations name no internal module.

## Mutation checks

| Mutation | Result |
| --- | --- |
| A cursor without its `storeId` is `CURSOR_EXPIRED` again | caught by `0027-C01` |
| `CURSOR_EXPIRED` without `reason` | caught by `0027-C02` |
| `onFatal` for every failure, not the first only | caught by `0027-F01` |
| `onFatal` before the event is committed | caught by `0027-F01` |
| No `scheduler.failed` event | caught by `0027-F01` |
| No warning for a failed usage write | caught by `0027-F03` |
| The Claude adapter's stop-proof check removed | caught by `0027-A01` |
| The Codex adapter's check removed | caught by `0027-A03` |
| An observer and `owner-reconcile` together | caught by `0027-A02` |
| The SDK never forgets a rejected key | caught by `0027-K01` (TypeScript), `test_0027_k01_k03` (Python) |
| Keys forgotten after the codes that can follow a commit | caught by `0027-K02` |
| A key held before the call is forgotten | caught by `0027-K02` |
| Keys forgotten after transport errors | caught by `0027-K02` |
| No recency refresh in the cache | caught by `0027-K03` |
| A delegated child does not inherit labels | caught by `0027-L02` |
| A fork does not inherit labels | caught by `0027-L02` |
| No `tasks_label` index | caught by `0027-L03` |
| `RuntimeInput` metadata not frozen | caught by `0027-L04` |
| Task events without the label | caught by `0027-L05` |
| Metadata 17 levels deep accepted | caught by `0027-L01` |
| The TypeScript SDK sends labels to a host without the feature | caught by `0027-L01 0027-L03` |
| Python `to_wire` renames metadata keys | caught by `test_0027_l01_l03` |
| A read-only view passes other methods to the shared reads | caught by `0027-R06` |
| `recoveryPending` always false | caught by `0027-R04 0027-R05` |
| No schema check when reading | caught by `0027-R07` |
| A linked `store.sqlite` accepted | caught by `0027-R07` |
| The reader takes the owner lock | caught by `0027-R02 0027-R03`: the running engine's store was busy |
| A missing state directory is created | caught by `0027-R01 0027-R07` |
| `--read-only` accepted with `--config` | caught by `0027-R09` |
| Cross-package imports all mapped to `internal/` (the base build) | caught by the package smoke check (T03) |

Equivalent mutations, not listed as caught: writing `scheduler.failed` to a degraded store changes nothing, because such a store refuses the write itself; and reading without a read transaction gives the same results in these tests, which have no writer between the two statements of one read.

## Not verified

- A real embedding application, such as an Electron main process, and real models.
- A read-only view of a store on a network file system, or of a store whose engine runs in another process while it reads, beyond the in-process check of R08.
- Stores older than schema 3 are refused, not read.
