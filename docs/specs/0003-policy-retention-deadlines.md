# SPEC-0003: Routing responsibility, retention, and transition deadlines

Date: 2026-09-19. Status: A lifecycle and A2 execution isolation are implemented and verified with offline fixtures; B/C are implemented under SPEC-0009; see its [completion matrix](0009-complete-design.md#completion-matrix) and [evidence](../tdd/0009-complete-design.md). See [historical A evidence](../tdd/0003-a-evidence.md) and [A2 wiring evidence](../tdd/0003-a2-wiring.md). Real-model acceptance is pending. Basis: [main design](../../AGENT_ORCHESTRATION_DESIGN.md), sections 4.5, 5.1, 5.4, 6.1, 6.2, 9.1, and 12.1. Foundation acceptance remains in SPEC-0001/0002 and its original evidence.

[A2](./0003-a2-execution-isolation.md) sets the new-turn default total budget to 1800 seconds and counts execution leases separately from business quarantine. The next B recovery contract is [archiving and namespace rollover](./0003-b-archive.md), implemented under SPEC-0009. The bilingual, dual-runtime first-version commitment remains; providers may be developed/accepted separately without weakening joint release gates.

## 1. Problems, scope, and implementation sequence

The earlier design did not assign a clear decision-maker for independent work/shared context. Compaction estimates omitted TTL rebuilds and history growth; retention and transitional states such as pausing lacked unified exit rules. These contracts make behavior observable rather than determined by arbitrary implementation constants.

A/A2 are the current baseline; B/C follow:

1. **A: deadlines and reconciliation, implemented.** Durable execution/control deadlines, monotonic time, unknown isolation, retained late evidence, bounded adapter observation/owned-resource cleanup, and owner attestation. Fork/compact/rotate and automatic upstream history inspection are excluded.
2. **A2: execution occupancy and outcome quarantine, implemented with offline fixtures.** Release execution only after both execution and resource stop are confirmed. Keep unknown business outcomes in bounded quarantine; reserve capacity for in-flight work. Engine/adapters share a finite budget, default 1800 seconds for new turns. Stop evidence, recovery, and diagnostics have independent A2 acceptance; real models remain unaccepted.
3. **B: retention and storage failures, implemented offline.** Protected references, idempotency tombstones, GC, atomic snapshots/cursor floor, storage backpressure, explicit archive/new-namespace rollover, and recovery. Back up before schema upgrade; do not immediately delete old data on startup. Namespace switching must not replay old-store requests.
4. **C: declared routing and accounting, implemented offline.** contextPlan, candidate queuing/fallback, unique cost ownership, and per-request estimates. Native fork protocol handling is implemented; real native-history acceptance and automatic economic optimization remain behind capability/benefit gates.

This specification does not authorize publication, deployment, Git initialization, paid experiments, or real-user-data deletion. It does not narrow the bilingual/dual-runtime product scope. Ordinary tests use owned temporary directories and fault fixtures. MCP-tool sandboxing, performance support matrices, package publishing, and upstream compatibility have separate gates.

## 2. Contracts and configuration

Current host JSON/TS `timeouts` defaults: `acceptanceMs=30000`, `turnMs=1800000`, `drainMs=300000`, `interruptMs=30000`, `reconcileMs=60000`, each an integer in 1..86400000 ms. Python writes `LifecycleTimeouts` snake_case fields through `to_wire` to host JSON and passes `--config` via `engine_command`; `local()` gains no timeouts parameter. SDK wait budgets remain independent. SPEC-0009 implements the B/C rules. Compact is bounded by a 300-second maintenance turn; rotate is a quiet-session transaction. No separate recover/rotate timeout setting is accepted. Model tools cannot change retention/control policy.

| Area | Contract |
| --- | --- |
| Routing | contextPlan includes requestedMode, independent, dependencyTaskIds, contextRefs, candidateSessionId?, snapshotRef?, fallbackModes, maxQueueWaitMs. Do not infer independence from prose. With a primary session and no explicit mode, continue |
| Queueing | Default 30 seconds, configurable with `limits.defaultMaxQueueWaitMs`; at most seven days; 0 means no wait. Only time spent queued counts: dependency waits and pauses do not, and each entry into the queue restarts the wait (SPEC-0015). Retry does not refresh the enqueue time. Fallback defaults empty. Every expiry atomically removes the unstarted old queue entry; without fallback, persist blocked/failed operation |
| Control | Implemented: acceptance 30 s, drain 300 s, interrupt 30 s, reconcile 60 s; operation.lifecycle enteredAt/deadlineAt, policyVersion, generation/dispatch, may-have-sent, last evidence. Compact maintenance turn at most 300 s; rotate requires a quiet session and completes transactionally |
| Execution | A2 new turns default 1800 s including startup/acceptance, without renewal on acceptance/output. Shared remaining monotonic budget; shorter explicit caps apply, longer provider caps cannot extend host limits, upgrades do not renew persisted deadlines |
| Execution/quarantine | Default execution slots 2; maxQuarantinedDispatches 32, range 1..1024 and at least maxActiveSessions. A=held leases, Q=business unknown, R=unquarantined in-flight reservations including cleanup. Admission requires A below execution limit and Q+R below quarantine limit; releasing A does not reduce Q |
| Close | Each close/continue waits 30 s by default. Expiry retains stopping + SHUTDOWN_INCOMPLETE and valid handles, without implicit interrupt escalation. EOF runs bounded emergency close, at most 30 s, for confirmed owned resources only |
| Retention | Events at least 30 days; terminal operation/message detail and unprotected terminal artifacts at least 90 days; raw usage at least 180 days. Starting points/protection are in main-design section 4.5 |
| Deduplication | Minimal tombstones last for the store lifetime. Expired details return OPERATION_HISTORY_EXPIRED and original ID, never a new request. Changed payloads still conflict |
| Storage | Implemented policy defaults, not measured capacity: 10 GiB quota, 80% warning, 90% backpressure; backpressure below 1 GiB free; 256 MiB emergency file; one million minimal snapshots/tombstones |
| GC | After sole-host startup recovery and hourly; batches at most 500 records or 8 MiB candidates, target transaction time 50 ms. Reference protection, quarantine files, and deletion outcomes recover durably |
| Cost | Bind costOwnerTaskId/rootTaskId before dispatch send. Do not mix billable tasks in one batch. Preserve unknown missing metrics; deduplicate repeated requests and parent/child aggregation |

Implemented `sessions.reconcile` requires host-owner `CallContext.owner=true`: embedded TS and managed-stdio Python may call it; ordinary sockets return UNAUTHORIZED. Negotiate lifecycle v1 owner-attestation/durableDeadlines on current wire 2.0 (original A used wire 1.0). New SDKs reject before sending if capability is absent. Evidence is an owner declaration after investigation, not a model decision or automatic history inspection; exact fields are in A.

Resource stop and business reconciliation are separate. Local process exit does not resolve remote uncertainty. Unknowns stay isolated; active owned consumer/cleanup handles or conflicting terminal evidence block release. completed saves output and pauses, with explicit resume requesting acceptance only; not_executed pauses and permits explicit requeue; failed/interrupted fails the original task. Unknown operations retain status and gain resolution; reconciliation does not automatically complete tasks. Risk approval for independent recovery tasks is a future product flow, not a bypass.

A2 separates resource release: if localResources and remoteExecution are attested stopped with no active handles/conflicting evidence, release the execution lease while unknown sideEffects/outcome yields `result.executionReleased=true,result.resolved=false`. Business quarantine remains and resume is forbidden. Python operation.result retains raw camelCase keys.

Read-only `scheduler.get` returns consistent A/Q/R, limits, reasons, and up to 16 occupancy/conflict references; `scheduler.getConflict` reads one conflict. Contradictory evidence after release durably closes admission. Owners submit stop evidence by conflictId/revision to `scheduler.resolveConflict`, resolving each conflict without rewriting business/acceptance history. SDKs strictly negotiate executionIsolation v1/budgetVersion 2. Ordinary sockets can query but not resolve. Idempotency scope is conflictId.

The original A2 implementation used storage schema 2 and wire 1.0. Current SPEC-0009 uses schema 3 and wire 2.0, with event schemaVersion 1. Upgrades create and verify a complete managed backup before transactional migration. Unknown/missing-field records recover conservatively without renewed deadlines. Custom adapters need executionBudget v2 and shared remaining-time semantics; unspecified provider caps are null. Missing capabilities fail before task submission/dispatch. A capability flag alone is not a safe-release guarantee. Reconciling side effects after restoring old backups differs from B's complete archive/identity rollover.

Implemented `state.snapshot` returns visible tasks/sessions/approvals, retentionFloorCursor, storeId, and snapshot cursor from one database view. Page using fixed snapshotId/cursor within frame limits. Default lease 60 seconds; expiry yields SNAPSHOT_EXPIRED while the active view/resume baseline is protected. Read exclusively after the completed snapshot cursor. retentionFloorCursor is the last cursor in the collected continuous prefix: equality may resume, lower cursors expire. After GC, old 0 cannot silently skip history. Bind mutations/retries to confirmed storeId and negotiate new fields/methods; old clients cannot silently ignore them. Unsupported capabilities/protocols fail before model submission.

## 3. Numbered acceptance criteria

### A: bounded deadlines and recovery

- AC-A01: Controlled-clock checks around every supported control boundary. SDK wait timeout does not cancel control; retries/restarts do not renew operation deadlines. Clock rollback cannot create unbounded waits.
- AC-A02: Cover definitely-not-submitted and possibly-submitted paths for each timeout. Only the former is definite failure. The latter transactionally settles operation, Session, dispatch, messages/outbox, and Task as unknown/blocked without resend or incorrect capacity release.
- AC-A03: Drain timeout does not call interrupt automatically. Interrupt receipt, iterator end, or process exit alone cannot fabricate terminal stop. Unsupported actions fail before send.
- AC-A04: Correlate late terminal evidence to original identity/generation. Reconciliation may append resolution without duplicating results/bills, pausing new generations, or automatically accepting tasks.
- AC-A05: Restart reads expired deadlines without model calls. Owner reconciliation records evidence/actor/result. Process exit alone does not resolve business unknown. Pause only after resources and dispatch/messages/side effects are reconciled. Resume does not replay executed requests; insufficient evidence leaves unknown.
- AC-A06: Incomplete close retains valid handles/operationId for owner continuation or explicit escalation. Real subprocess fixtures cover EOF, owned-process exit, and unconfirmed exit. PID reuse/shared processes with other sessions must not cause unrelated kills. Permanently pending iterator next/return cannot block bounded SDK close responses.

### A2: implemented execution isolation

AC-A2-01–12 are in the [A2 specification](./0003-a2-execution-isolation.md), appended to A history rather than rewriting old RED/GREEN with new defaults. First prove possibly running unknowns retain capacity; then prove stopped unknowns can release it. Do not remove blocking by inflating actual concurrency.

### B: retention, recovery, and backpressure

- AC-B01: Inject time around retention boundaries. Protect active tasks, unknown dispatches, pending approvals, unprocessed outbox, recovery checkpoints, and pins. Shared-digest artifacts require checking every protecting reference.
- AC-B02: Same key/payload within 90 days returns the original receipt. After detail collection/restart, retain original operation identity and explicit expiry without another dispatch. Changed payloads still conflict; message-consumption deduplication follows the same rule.
- AC-B03: Atomically collect a continuous event prefix and advance retentionFloorCursor. Concurrent snapshot pages/commits/resume must not silently omit data or exceed frames. Never combine an expired snapshot with a new one. Expired cursors, including 0, return CURSOR_EXPIRED; wrong storeId fails.
- AC-B04: Crash at artifact candidate marking, reference checks, quarantine move, deletion, and result registration. Recovery leaves no unmarked dangling references and does not delete concurrently referenced artifacts. GC invokes no model.
- AC-B05: Thresholds block new work while preserving queries/settlement. Tombstone capacity cannot be freed by deleting deduplication history. Owner quota changes are auditable; model tools cannot change them.
- AC-B06: Inject SQLITE_FULL/ENOSPC/I/O before operation persistence, after send, and at terminal commit. No durable receipt before commit. If even unknown persistence fails, stop dispatch and reconcile old dispatch records after restart; do not assume compensating writes succeed or fall back to an in-memory work queue.
- AC-B07: Migration preserves keys/unknown evidence and does not immediately collect old data. Backup rollback/independent import allocates a fresh storeId with provenance; normal restart does not. Reproduce backup → execute K → restore old backup → retry K without automatic duplicate dispatch from lost tombstones. SDKs reject transparent old-identity retry; post-backup side effects need separate reconciliation.

[B's archive specification](./0003-b-archive.md) adds AC-B08–B18. Together they require settlement reserves, original request identity, no unresolved execution at switch, queryable archives, corruption refusal, old-writer fencing, and crashes at every phase. Permission to archive is not implementation evidence.

### C: declarations, queueing, and accounting

- AC-C01: Equal authorization, capability snapshot, state, and contextPlan yield equal candidates/reasons. Changing only goal prose does not open another session. Declared independence cannot bypass dependency, permission, budget, or write-conflict checks. No undeclared fallback.
- AC-C02: Waiting for a busy session consumes no execution slot and does not block ready sessions. Keep initial enqueue time stable; atomically remove unstarted expired entries. Without fallback, persist blocked/failed and never dispatch later; with fallback, dispatch at most one path. If submission began, return actual dispatch state/unknown rather than a definite non-executed queue failure.
- AC-C03: Per-request keep/compact fixtures cover continued hits, TTL rebuilds, partial retained prefixes, and H_i/K_i growth. Count compaction once, use correct price units, and normalize overlapping cumulative fields. Missing key metrics/unknown future intervals yield a range/unknown, not automatic savings claims.
- AC-C04: For serial session reuse by A/B/C/D, charge D for its reads/rebuilds. Parent delegation/aggregation belongs to parent; child execution to child; root totals deduplicate billing records. Failed attempts and host_overhead belong in experiment totals. Zero successes does not mean zero cost.
- AC-C05: Record runtime/profile/evidence per capability. Falsifying A01–A08 assumptions must disable the feature, reject support, preserve unknown, or disable optimization as appropriate. Do not bypass gates by broadening permission, silently changing model/session, or claiming false success.

## 4. TDD and delivery evidence

Each increment selects ACs, writes tests, records actual RED, then implements GREEN. Already-correct behavior gets regression coverage without invented failures. Use controlled time for retention/deadlines; real temporary subprocesses/databases for process/storage crashes and bilingual protocol paths, not only mocked engine methods.

For shared wire, migration, or lifecycle changes, run `npm test`, `npm run test:python`, `npm run typecheck`, and `npm run format:check`. A evidence is separate: [summary](../tdd/0003-a-evidence.md), [wiring](../tdd/0003-a-wiring.md), [Python](../tdd/0003-a-python.md), [Claude](../tdd/0003-a-claude.md), and [Codex](../tdd/0003-a-codex.md). Old foundation counts do not cover new ACs. B/C implementation evidence is recorded in SPEC-0009. Real native runtime evidence is extended in SPEC-0011; model quality, caching economics and production capacity still require separate experiments.

Update the main design, SDK guide, README, capability table, and schema to actual delivery, preserving unimplemented labels. Record reasons/affected behavior for changed deadline/quota defaults; do not tune constants merely to bypass a failing test.
