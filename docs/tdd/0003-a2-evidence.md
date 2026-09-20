# SPEC-0003-A2: Execution isolation and unified-budget TDD evidence

Implementation: 2026-09-19–20. Based on [A2](../specs/0003-a2-execution-isolation.md). Only A2 was implemented; archive, GC, new-namespace rollover, and routing policy remain pending. This historical increment did not initialize Git, commit, publish packages, call real models, read credentials, or execute user business work.

## Implemented behavior

Count durable execution leases separately from business quarantine. New dispatch transactionally checks `A < maxActiveSessions` and `Q + R < maxQuarantinedDispatches`, then acquires lease/reservation; defaults are 2 and 32. Initialization, execution, and cleanup retain R; timeout converts R to Q. Confirmed execution and owned-resource stop releases only A, retaining activeDispatchId, blocked task, business unknown, and Q. Final business reconciliation releases Q. Capacity backpressure blocks new work while preserving idempotent receipts, queries, and necessary settlement.

New turns default to 1800000 ms from dispatch start, without renewal on initialization/acceptance. Fake, Claude, and Codex share the host monotonic budget. Persist effective deadlines/sources after taking the minimum of explicit provider and host caps. Timers only wake to reread time; cleanup has a separate finite budget. Legacy adapters return UNSUPPORTED_CAPABILITY before submission.

Both SDKs expose scheduler queries, up to 16 occupancy/conflict examples, owner-only conflict resolution, and partial resource attestation. Release evidence/lease commit together; cleanup errors do not overwrite real terminal certificates. Duplicate/reordered callbacks cannot release twice; wrong identity is rejected/audited. Higher-sequence unknown does not erase confirmed stop. An active correction for the same trusted target produces a durable conflict gate, resolved by conflictId independently of activeDispatchId.

Storage advances to schema 2; wire stays 1.0 and event schemaVersion stays 1. Verify a recoverable SQLite backup before schema1 migration. Historical unknown without leases recovers held+Q; durable released state and deadlines survive restart.

## Actual RED and fixes

First write six core cases in `tests/engine/execution-isolation.test.ts` and run `node --test tests/engine/execution-isolation.test.ts`: **0/6 RED** from absent budget input/1800-second default, scheduler.get, partial-resource result, and durable isolation/conflict behavior. These were behavior failures, not compile failures. Lease/capacity/budget/evidence/reconciliation/conflict/schema2 implementation made the first **6/6 GREEN**.

Add actual recovery and review regressions, recording already-correct behavior as regression rather than inventing RED. Each following boundary first failed an actual assertion:

| New failing behavior | Actual RED | Fix |
| --- | --- | --- |
| accepted impersonated a terminal stop | 11/12; A incorrectly became 0 | Strict certificate type/shape/native-identity checks |
| Cleanup unknown hid real output, permitting not_executed replay; removed old provider crashed reconciliation | 12/14; missing rejection, TypeError | Check retained certificates; allow owner settlement without the old adapter |
| Partial attestation with a contradictory explicit outcome still released resources | 14/15; missing EVIDENCE_CONFLICT | Check any explicit business conclusion; only outcome=unknown is pure resource attestation |
| Later unknown erased stop proof; capacity blocked acceptance-only resume | 15/17; third task unstarted, QUARANTINE_CAPACITY_EXCEEDED | Retain last explicit resource states; check capacity only for execution-producing resume |
| Legacy-adapter resume first completed, then asynchronously stopped the whole scheduler | 17/18; missing UNSUPPORTED_CAPABILITY | Check capability before resume; async capability failure pauses only that task |
| Empty/whitespace real output could not be reconciled | 18/19; result validation rejected empty text | Preserve exact output for human acceptance, without claiming non-execution; target/summary remain nonempty |

The root engine added 21 tests. Independent adapter/wiring RED/GREEN: [Claude](./0003-a2-claude.md), [Codex](./0003-a2-codex.md), [TS/Python/CLI](./0003-a2-wiring.md). Review also reproduced timer-wakeup-as-expiry and stalled-stream-after-timer-removal failures, each fixed after a new failing test. Existing deadline/lifecycle regressions remain.

## Acceptance coverage and boundaries

| Criterion | Current offline evidence |
| --- | --- |
| AC-A2-01/02 | Virtual 300001 ms advance and wall-clock rollback remain within new budget; shorter/longer provider caps; both protocol fixtures cover beyond 300 s, startup in total budget, no renewal at acceptance, and pre-terminal recheck |
| AC-A2-03/04 | Two potentially running unknowns keep A=2/Q=2; local exit alone does not release. Late matched terminals+cleanup start the third automatically without replay/approval of originals; activeDispatchId remains |
| AC-A2-05/06 | Cleanup retains R/A; late Claude return/close and real owned Codex exit; wrong native ID/generation, reordering, duplicates, fake terminal, unverified capability, and generic failed do not falsely release; definite non-submission may fail conclusively |
| AC-A2-07/08 | Partial owner resource attestation, active-handle refusal, terminal conflicts/idempotency, small Q+R capacity, original receipts/changed-payload conflict; acceptance-only resume invokes no model; business reconciliation releases Q |
| AC-A2-09 | execution-isolation-crash.ts actually SIGKILLs during release-event transaction: restart held; after commit: restart released. Both retain unknown/deadline/original dispatch without replay. Verify schema1 backup integrity/identity, conservative missing fields, failed backup preventing migration/submission, and 17 retained records under reduced limits |
| AC-A2-10 | Shared monotonic budget/exact boundaries; existing drain/interrupt/close continuation unchanged; unsupported resume does not stop other scheduling; no real 30-minute waits |
| AC-A2-11 | Actual Node stdio/Unix and TS/Python snapshots match field by field. Missing old-host capability fails before send; ordinary sockets cannot attest/resolve conflicts; bounded diagnostics and event-free repeated reads |
| AC-A2-12 | Trusted active correction durably stops dispatch through restart. Resolve by conflictId even after activeDispatchId clears; owner/revision/idempotency checks; all conflicts must resolve before admission |

A one-off compatibility check used the actual Store source saved before A2: create/close schema2 with the new Store, then open with the old Store and receive SCHEMA_MISMATCH. Output: `PASS: actual pre-A2 Store rejects schema 2 without opening model execution`. It used/cleaned temporary directories; a handwritten simulated version check was not presented as old-engine evidence.

Old foundation/lifecycle fake fixtures gained only explicit budget capability and evidence matching their prior semantics. Unknown branches still provide no remote-stop proof. Historical counts/results remain A evidence, not retroactive A2 acceptance.

## Final commands

```sh
npm test
npm run test:python
npm run typecheck
npm run format:check
```

| Command | Final actual result |
| --- | --- |
| `npm test` | 157/157 passed, 0 failed, 0 skipped |
| `npm run test:python` | 40/40 passed, 0 failed, 0 skipped |
| `npm run typecheck` | Passed |
| `npm run format:check` | Passed |

Environment: Node.js 24.14.0, Python 3.14.6, macOS. Unix tests ran with local IPC permitted; sandbox EPERM was neither passed nor skipped. Final CLI review found Claude's actual field is cleanupTimeoutMs while Codex uses closeTimeoutMs. After a real failing test, wire the correct fields and reject crossed names. A real adapter configured with 17 ms cleanup proves the value affects behavior.

At this increment there was no Git metadata. Initial SHA-256 inventory confirmed 21 existing files changed, 12 added, none deleted; unrelated baseline files retained hashes, and dependency manifests/lockfiles were unchanged.

Evidence covers workspace source, protocol fixtures, and actual local subprocesses, not real Claude/Codex models, provider-derived/remote execution scope, long-lived operation, or production capacity. Thirty minutes and 32 entries are development defaults requiring task-based calibration. Publishing, minimum-version matrices, archive recovery, and complete first-version delivery remain separate work.
