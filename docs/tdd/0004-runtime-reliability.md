# SPEC-0004: Runtime reliability verification

Date: 2026-09-20. Pre-fix baseline: `dbad085`, originally `bba83e5` before author correction with the same file tree. See the [acceptance specification](../specs/0004-runtime-reliability.md). Scope is R01–R04 only, excluding other P2 items, GC, archival, and real-model acceptance. Counts below record successive increments, not one combined test run.

## 1. AC-R01: Scheduling work with historical tasks

Add tests/engine/scheduler-history.test.ts and first run:

```sh
node --test tests/engine/scheduler-history.test.ts
```

Actual RED: with 30/60 waiting_approval records, one creation decoded 1051/3901 dispatch records and 30/60 nonqueued historical tasks, exceeding the linear scan budget. FIFO/capacity regressions already passed. After implementation, dispatch decodes were 152/302 and nonqueued task decodes were zero for both sizes.

The fix reads queued candidates through a SQLite state index and recomputes outer admission only after an actual dispatch. The dispatch transaction still checks A/Q/R and conflicts. Turn counts use a taskId index rather than decoding the dispatch table for each candidate. Rebuild new indexes on existing schema 2 stores without changing business schema.

The final file passed 6/6, covering a first candidate that lost adapter capability, FIFO, concurrency limits, exact per-task turn boundaries and later candidates, and index reconstruction/history preservation in populated schema 2. Later coverage was regression testing, without fabricated RED.

## 2. AC-R02: Signal shutdown configuration

Add tests/contract/cli-shutdown.test.ts. Before the fix, 14 tests yielded 5 pass / 9 fail: Unix/stdio ignored explicit drain, stdio ignored a custom budget, incomplete shutdown lacked operationId, or stdio exited prematurely. Existing defaults and unexpected EOF behavior already passed.

After the fix, this targeted command passed 28/28:

```sh
node --test tests/contract/cli-shutdown.test.ts tests/contract/host-cli.test.ts tests/contract/host.test.ts tests/contract/lifecycle-wire.test.ts
```

Tests launch real Node hosts with fake turns, send SIGINT/SIGTERM, and read persisted outcomes. Explicit configuration works for both transports. Incomplete drain retains control and operationId for continuation without automatic interrupt escalation. Defaults remain interrupt with 1000ms for Unix and 30000ms for stdio; unexpected owner EOF separately retains the original 30000ms interrupt policy.

## 3. AC-R03: TypeScript RPC deadlines

Add tests/contract/request-timeouts.test.ts. Actual RED was 3 pass / 5 fail out of eight: ordinary requests did not time out, default/per-mutation overrides were ineffective, invalid limits were accepted, and CLI status kept waiting past the deadline. initialize, explicit wait, and owner-close budget tests already passed.

After implementation, all eight passed; together with SDK, lifecycle-wire, and execution-isolation-wire coverage, 20/20 passed. Actual Unix fixtures verify pending cleanup, ignored late receipts, and continued connection usability. Actual SQLite verifies that lookup and idempotent retry of a timed-out mutation retain the same task. An actual CLI child returns TIMEOUT and exit code 1. Virtual time covers the 30-second boundary without a real 30-second wait.

Ordinary requests default to 30000ms. Connection requestTimeoutMs and per-request timeoutMs accept integers 1..2147483647. Connection establishment and initialize's 5000ms remain independent. Explicit wait uses its remaining total budget; owner close retains the shutdown budget plus 1000ms for a receipt. Timeout does not imply remote cancellation.

One intermediate regression hung in cleanup because virtual time froze the test fake-runtime timers. It completed after switching to a timer-free offline unknown fixture. This test hang was neither product RED nor a passing result.

## 4. AC-R04: Claude process-exit evidence

Read-only inspection of the declared minimum [SDK 0.3.241 source](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.241/sdk.mjs) found that Query.close calls cleanup and returns immediately, while cleanup includes asynchronous work and bounded waitForExit. Return is not exit confirmation. The public [type declarations](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.241/sdk.d.ts) expose spawnClaudeCodeProcess.

The initial three tests in tests/contract/claude-cleanup.test.ts produced 1 pass / 2 fail: a live child and a query without process observation incorrectly delivered result instead of error. After implementation, the file grew to nine tests; combined Claude/lifecycle coverage passed 65/65.

The public spawn callback now records actual ChildProcess handles. Only actual exit or failed spawn without a PID establishes local completion. Cleanup seals late spawning and requires all handles to end. close/return/abort are not exit evidence. Actual-engine regression verifies live handles block owner reconcile and later work; late exit releases A while retaining Q/blocked without replay. Exit without matching terminal evidence still cannot automatically release.

Full integration also found an old dynamic SDK fixture in execution-isolation-wiring.test.ts that used return(done:true) as cleanup proof. It was replaced with an actual child while preserving the 17ms cleanup-budget assertion; that file passed 6/6. Production evidence was not weakened to accommodate the old fixture.

## 5. Performance samples and initial final verification

Both versions used the same machine and tests/fixtures/scheduler-benchmark.ts workload: create the next fake task only after the previous one reaches waiting_approval. The old version was extracted with git archive into an isolated temporary directory and cleaned afterward. The historical command used bba83e5; the equivalent current baseline is dbad085. Values are means of the last five creation calls, excluding time waiting for fake turns:

| Historical task count | Before fix | After fix |
| --- | --- | --- |
| 50 | 8.59ms | 1.25ms |
| 100 | 36.30ms | 2.05ms |
| 150 | 74.61ms | 2.89ms |
| 300 | Not measured | 5.52ms |
| 1000 | Not measured | 21.02ms |

Reproduce against the current checkout:

```sh
node tests/fixtures/scheduler-benchmark.ts . 50,100,150,300,1000
```

These samples support eliminating repeated historical tasks × dispatches scans, not a latency SLA. Admission snapshots, approval scans, and other historical queries still have linear costs. Durable data is not automatically collected; long-term capacity acceptance remains unverified.

| Command | Actual result at this increment |
| --- | --- |
| npm run typecheck | Passed |
| npm run format:check | Passed |
| npm test | 194/194; 0 failed, cancelled, or skipped; about 2.69 seconds |
| npm run test:python | 40/40; about 4.18 seconds |
| git diff --check | Passed |

Tests used temporary directories, offline fixtures, local IPC, and owned children only. No login credentials, installed real SDK, or paid-model requests. Sandbox EPERM was excluded from behavior acceptance; IPC tests ran where local sockets were permitted. Schema 2 indexes/database behavior were verified only in temporary databases, without touching existing user runtime state.

## 6. R04 follow-up: Owner reconciliation and stalled shutdown

Date: 2026-09-20. Continue from the 194/40 baseline. Add AC-R04.1–R04.4 first, then AC-R04.5 after a real Python-host test found that owner reconciliation was blocked during shutdown. Scope remains R04, excluding 0003-B and other P2 items.

### RED

```sh
node --test tests/contract/claude-cleanup-recovery.test.ts
```

The initial seven tests yielded **0 pass / 7 fail**. Typecheck passed after narrowing the test JSON-result types; the retained RED was behavioral:

- Pending close, no-op close, and cleanup without matching terminal evidence failed to reap actual children using an independent AbortSignal; resources remained active.
- In the multiple-process case, an otherwise cooperative child received no fallback cleanup, while the other child ignoring EOF/SIGTERM remained alive.
- Two unknown records occupied A and owner reconciliation was rejected with RUNTIME_STILL_ACTIVE, so conflicting declarations and injected SQLite commit failures had not yet reached their intended checks.

After implementing the narrow interface, add an observation-state regression: while execution observation was suspended and cleanup had begun, prepare incorrectly returned a retirement function rather than null. `node --test --test-name-pattern='cleanup preparation' tests/contract/claude-cleanup-recovery.test.ts` produced **0 pass / 1 fail**. It passed after requiring observationEnded. Target identity, idempotent finalizers, and later dispatches in the same session were added as regression coverage without invented RED.

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p test_claude_cleanup_reconcile.py -v
```

The first actual Python-to-Node stdio run produced **1 pass / 1 error**. Ordinary owner attestation, scheduling recovery, and restart passed; after active shutdown returned SHUTDOWN_INCOMPLETE, reconcile was rejected with HOST_STOPPING. Add AC-R04.5 plus continued refusal of creation/resume/messages and reproduce the same failure. Then permit only sessions.reconcile after entry into owner shutdown through the stopping write gate, retaining authorization, target, process, and evidence checks.

### Implementation and observed behavior

- RuntimeAdapter.prepareUnobservedCleanup({sessionId,dispatchId,generation}) is an optional internal adapter interface without new wire parameters. Claude returns a preparation result without side effects only when observation ended, spawning is sealed, no process was ever observed, and every record matches the target. Old adapters and actual live processes retain the guard.
- At this increment, the engine saved the owner declaration, owner_attested_unobserved disposition, and session.resources_reconciled event before retiring memory records after transaction commit. A SQLite trigger rejecting the final operation write, exceeded deadlines, terminal conflicts, and persistent resource conflicts all retained the original records/leases. Same-key retries neither duplicated events nor retired other records. Section 7 subsequently separates cleanup preparation from its completion event.
- With two unknown records occupying A, reconciling one retained the other's held lease and admitted queued work. Original Q/blocked remained. Local stopped with remote unknown did not release A. Confirmed completed first entered paused, without automatic approval or replay.
- Owner declarations did not emit automatic resource_observation. After an actual Python-driven restart, SQLite still recorded executionState.localResources=unknown on the original dispatch; lease release used owner_attestation. The receipt and unique audit event persisted.
- Cleanup first lets the SDK use half the original budget, then independently applies owned EOF/SIGTERM and observes exit for the remainder. Missing/failed close triggers immediate fallback. Pending/invalid returns and independent signals do not skip cleanup. Ignored SIGTERM/EOF remains bounded unknown until actual late exit. An unrelated observer process stays alive.
- Embedded TypeScript can attest and close; actual Unix SDK clients remain UNAUTHORIZED. Python reconciles after SHUTDOWN_INCOMPLETE, continues with the original shutdown operationId, and observes actual Node-host exit. Creation, resume, and messages remain HOST_STOPPING.

### Integration regression and final GREEN

Fallback makes the old "wait for stdin" fixture exit normally, so it no longer represents refusal to clean up. Replace it with an actual child that ignores EOF/SIGTERM, waiting for readiness before the tested path. Keep the assertion that genuinely live processes block reconciliation.

An intermediate full run produced 205 pass / 2 fail: one old lifecycle fixture was not yet replaced; another late-terminal test's 20ms limit expired under parallel load before child startup and before its second next call. The latter also exposed missing fixture cleanup after assertion failure. Terminate only the child confirmed to belong to that run and preserve the failure report. Use readiness handshake/injected remaining budget plus failure cleanup hooks; do not extend production deadlines or weaken exit evidence.

| Command | Actual result |
| --- | --- |
| node --test tests/contract/claude-cleanup-recovery.test.ts | 13/13, including real Unix sockets, SQLite rollback, and children |
| Python targeted command above | 2/2, actual owner stdio, restart, and shutdown continuation |
| npm test | **207/207**; 0 failed, cancelled, or skipped; about 2.68 seconds |
| npm run test:python | **42/42**; about 4.48 seconds |
| npm run typecheck | Passed |
| npm run format:check | Passed |
| git diff --check | Passed |

No real SDK/paid model, commit, or push was used during this increment. Async cleanup budgets cannot preempt synchronous JS blocking. Owners still independently verify the real environment; offline fixtures establish neither upstream-version acceptance nor real business outcomes.

## 7. AC-R04.6: Invalid finalizers and post-commit cleanup receipts

This increment addresses reproducible third-party adapter violations at prepare/finalizer boundaries. Preserve resolveConflict's existing guard without adding a bypass for its currently unreachable path. 0003-B and other P2 items remain excluded.

Add AC-R04.6 and tests/engine/reconcile-finalizer.test.ts first, then run:

```sh
node --test tests/engine/reconcile-finalizer.test.ts
```

Initial **0 pass / 7 fail**: three truthy non-function results threw TypeError only after commit; prepare/finalizer exceptions lacked recoverable errors; no pending cleanup receipt supported same-key retry after finalizer/completion-persistence failure; restart could not distinguish committed attestation from unfinished cleanup. Typecheck passed after explicit unknown casts in contract-violation tests; the retained RED was actual runtime behavior.

After the initial implementation, three added Promise/invalid-return cases produced **7 pass / 3 fail**: Promise.reject, pending Promise, and no-op finalizers still incorrectly reported completion. Observe both Promise outcomes without unbounded waits or concurrent reinvocation, and check resource state before acknowledgement. The final file passed **10/10**. These inject adapter contract violations and do not claim the built-in Claude adapter produced them.

Observed implementation:

- Non-function prepare results and thrown prepare errors are rejected in the initial transaction with INVALID_RUNTIME_CONTRACT. Retain leases/records without successful reconciliation receipts.
- The first transaction commits the owner declaration/business decisions and session.resource_cleanup_prepared. The operation is persisted, resourceCleanup.status=pending, and unobservedResourcesReconciled=false. If owner attestation already released the lease, later cleanup failure does not pretend the transaction rolled back.
- Retain the original finalizer. RESOURCE_CLEANUP_INCOMPLETE carries operationId/auditCommitted. Pending cleanup adds RESOURCE_CLEANUP_PENDING and blocks new dispatches. Ordinary clients and same-key requests with different payloads cannot retry it.
- The same owner's explicit same-key retry continues only this cleanup. On success, a second transaction changes the receipt to completed/true, writes the unique session.resources_reconciled and operation.updated events, and resumes scheduling. Repeated successful requests do not rerun prepare/finalizer, change business state, or duplicate events.
- A real SQLite UPDATE trigger injects failure in completion-receipt persistence. After memory retirement succeeds, retry only acknowledgement; finalizer invocation remains one. This second-transaction failure differs from the previous increment's initial-attestation rollback.
- A contract-violating pending Promise does not block RPC or permit concurrent same-key invocation. Fulfillment/rejection updates memory progress only; the owner still explicitly retries to complete the receipt. A returned finalizer with resources still active remains pending.
- After an actual Node-owner restart, unfinished operations enter outcome_unknown under existing recovery rules. If the original finalizer is unrecoverable, report its operationId and RESOURCE_CLEANUP_INCOMPLETE. Do not call a new adapter or interpret empty memory as successful original cleanup.

Two additional real Python stdio regressions verify error fields, receipt lookup, same-key continuation, and unknown receipts after stopping/restarting the original host. Existing SQLite read-only assertions now use explicit closing to close connections, eliminating test-resource warnings found when expanded coverage triggered GC.

| Command | Actual result |
| --- | --- |
| New finalizer and existing claude-cleanup-recovery tests | 23/23 |
| PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p test_claude_cleanup_reconcile.py -v | 4/4 |
| npm test | **217/217**; 0 failed, cancelled, or skipped; about 2.74 seconds |
| npm run test:python | **44/44**; about 4.83 seconds |
| npm run typecheck | Passed |
| npm run format:check | Passed |
| git diff --check | Passed |

All runs used temporary state and offline fixtures, without paid models, commits, pushes, or merges during this increment. Cleanup receipts distinguish committed declarations from retired records; they are not a general force flag, automatic retry, or real-provider acceptance.
