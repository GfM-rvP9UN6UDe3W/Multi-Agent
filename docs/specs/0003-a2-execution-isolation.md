# SPEC-0003-A2: Execution occupancy, outcome quarantine, and unified deadlines

Design date: 2026-09-19; implementation acceptance: 2026-09-20. Status: A2 is implemented and has passed offline TDD and real local subprocess integration; see [A2 verification evidence](../tdd/0003-a2-evidence.md). Real-provider model acceptance remains separate. The chosen sequence was to fix N1 before [0003-B](./0003-policy-retention-deadlines.md). This specification revises [0003-A](./0003-a-lifecycle.md) scheduling counts and deadline policy without rewriting its historical implementation/test evidence.

## 1. Problem, scope, and success criteria

Before A2, the A baseline counted every non-null activeDispatchId against the maximum two execution slots. The default turn deadline was 300 seconds, and each adapter also retained its own 300-second terminal limit. An offline reproduction left two timed-out tasks blocked/outcome_unknown and a third queued. Even after the first two returned terminal evidence, further dispatch required human reconciliation.

The objective is a consistent, finite deadline for long tasks. An unknown outcome whose execution and resource cleanup are confirmed complete should consume only quarantine capacity, allowing other eligible tasks to proceed. Unknown work that may still execute must continue occupying an execution slot; status changes cannot inflate actual concurrency. Business results, side effects, and acceptance remain separate checks.

Scope includes scheduling, both adapters, internal RuntimeInput/RuntimeEvent contracts, TS/Python SDKs, CLI configuration, read-only diagnostics, and upgrade recovery. Add only necessary resource evidence. Automatic upstream history inspection, GC, cross-task session reuse, dependency scheduling, concurrent workspace writes, automatic acceptance, and fork/compact/rotate are excluded.

Success does not mean progress under every failure. Uncertain execution, retained resources, or full quarantine capacity must stop the affected admission path with a reason. Two late, complete stop certificates should release execution slots without first converting unknown business outcomes into successes.

## 2. Occupancy and admission formula

Count dispatches. Because each session has at most one in-flight dispatch, execution count corresponds to session execution slots. `activeDispatchId` retains the identity of an unreconciled dispatch; it no longer determines occupancy by itself and must not be cleared just to free capacity.

| Quantity | Definition | Development default / range |
| --- | --- | --- |
| A: execution occupancy | Dispatches admitted without a durable complete stop certificate, including normal in-flight work and unknown work that may still run | `limits.maxActiveSessions=2`, still 1..2 |
| Q: outcome quarantine | Dispatches with outcome_unknown, whether or not their execution slot has been released | `limits.maxQuarantinedDispatches=32`, integer 1..1024, at least maxActiveSessions |
| R: quarantine reservation | Dispatches with a held lease that are not yet quarantined or conclusively settled; initialization, execution, and terminal-but-cleaning phases each reserve one possible quarantine entry | Derived from durable dispatches; not a separate configuration value |

Admission requires both `A < maxActiveSessions` and `Q + R < maxQuarantinedDispatches`, plus existing task, session, permission, and turn-count checks. Check eligibility, acquire the execution lease, and reserve quarantine capacity in one transaction. Queued tasks consume no A/R. Normal settlement releases A/R. Timeout converts R into Q without increasing `Q + R`. Complete stop evidence for unknown work releases only A; business reconciliation releases Q.

Q and A may overlap: unknown work that could still run consumes both. Quarantine is not extra model concurrency. Two normal sessions plus 32 still-running unknown sessions must never bypass the execution limit. The default 32 is a pilot bound on the human-reconciliation backlog, not a measured capacity conclusion.

At execution capacity, new tasks queue normally. At the `Q + R` bound, retain the queue and stop dispatch. New tasks, messages.send calls that add pending work, and resumes requiring execution return `QUARANTINE_CAPACITY_EXCEEDED` without new business operation/message records. Check original idempotency keys first: identical requests still recover the original receipt, and changed payloads still conflict. New capacity state must not rewrite either behavior. Queries, reconciliation, cancel, approvals, and close remain available. A saved-result resume only requests acceptance again and is allowed as settlement. Approval-triggered mailbox work queues without bypassing admission.

Only the owner configures limits; ordinary clients/models cannot enlarge them. No hot-update API is added. Restart configuration may raise limits while preserving old records/deadlines. If valid configuration is below recovered Q/R, start for diagnostics and settlement, refuse new work, and do not delete, evict, or auto-resolve unknown records. Structurally invalid configuration, or maxQuarantinedDispatches below maxActiveSessions, still fails before startup.

## 3. Evidence required to release an execution slot

Prove both that the dispatch's execution ended and that its owned local resources were cleaned up. None of these alone releases A: timeout, AbortSignal, interrupt acknowledgment, iterator end, Promise return, PID disappearance, `hasActiveResources=false`, absence of in-memory handles after restart, or model text claiming completion.

Allowed sources:

1. **Definitely not submitted:** the adapter proves it did not submit the business request and local resources are cleaned up. Deterministic failure may follow existing rules without inventing an unknown business outcome.
2. **Matched runtime terminal state plus cleanup confirmation:** correlate provider, native session/turn, dispatch, and generation. Terminal status may be success, failure, or confirmed interruption. Release requires a verified provider/profile contract stating that the terminal event covers all managed execution for that turn, plus local cleanup. Possible derived processes/remote jobs or an unverified capability cannot be declared safe from terminal evidence alone.
3. **Owner resource attestation:** reuse owner-only `sessions.reconcile`, exact targets, and idempotency keys. When localResources and remoteExecution are both stopped, no active execution/cleanup handles remain, and evidence does not conflict, release only A if business evidence is still unknown. With unknown sideEffects or outcome, return `resolved=false`, keep the task blocked and session outcome_unknown, and retain Q. The owner must actually investigate resources; the API does not perform that investigation.

Item 3 refines A's rule that any unknown blocks release: business release is unchanged, while resource release is recorded separately. localResources=stopped with remoteExecution=unknown still occupies A. The owner cannot force release while the runtime retains active cleanup handles.

Adapters add an explicit execution/cleanup evidence channel or query. The engine must not infer proof from generic result/error fields. The internal contract carries at least dispatchId, generation, providerSessionId, providerTurnId when available, source, observation time, localResources, remoteExecution, and raw evidence references. RuntimeEvent outcome=failed does not automatically mean definitely not submitted.

Preserve a real terminal event even when cleanup times out. Business outcome remains unknown, but terminal evidence must survive. Later cleanup must notify the engine against the original dispatch so it can reevaluate the lease. Discovery must not depend on an already-ended iterator, a model heartbeat, or another human request. Duplicate, reordered, and late notifications cannot release twice or affect a new generation.

Wake the scheduler only after complete stop evidence, lease released, and its diagnostic event commit together. Resource release does not change business outcome_unknown, message/outbox quarantine, original control state, or pending acceptance. Do not requeue that task/session or deliver its mailbox. Different taskIds do not prove semantic independence: the existing read-only profile remains the boundary, with no new dependency/write-conflict safety claim.

## 4. Persistence, recovery, and reconciliation

Each dispatch gains a versioned executionLease: `status=held|released`, acquiredAt, releasedAt?, releaseReason?, releaseEvidenceRef?. Store business-quarantine membership and entry time separately. Release evidence includes the original owner instance and exact target, distinguishing execution end from accepted results. Release does not change generation/dispatch identity.

- Transactionally update lease/quarantine state and Q/R around timeout, terminal arrival, cleanup completion, partial owner attestation, and final reconciliation. Recompute counts from database facts, not only memory.
- Durable release evidence continues freeing A after restart while Q remains. An unfinished release transaction recovers held. Old unknown records lacking new fields recover held+Q; ordinary completed records are not newly quarantined. Do not automatically treat old terminalEvidence as a complete stop certificate.
- A held record with no recoverable process handle does not prove local or remote execution ended. Never kill by persisted PID, name, or port. Recovery does not reset deadlines or resend old dispatches.
- If corrected/conflicting evidence for the same trusted target overturns a release, persist a conflict with id, revision, dispatchId, generation, original/new evidence references, and open/resolved state. Immediately stop new dispatch with `EXECUTION_EVIDENCE_CONFLICT`; preserve the gate after restart. Reject/audit wrong-target or stale-generation events without treating them as current release/conflict evidence.
- Final completed attestation still only saves output and moves to paused; resume requests acceptance again. Preserve empty/whitespace strings for human review rather than pretending no execution occurred. Result must remain a string within its length bound. not_executed, failed, and interrupted keep A's branches without automatic execution/approval.

Old-schema upgrade requires version checks and a recoverable backup. Older engines refuse newer schemas. Storage schemaVersion is separate from wire version; new lease semantics cannot be presented as already supported by old implementations.

Clear conflicts through owner-only `scheduler.resolveConflict({conflictId,expectedRevision,evidence,idempotencyKey})`, locating the original durable dispatch conflict independently of the session's current activeDispatchId. Resolution requires rechecking the original execution and affected resource occupancy, confirming local and remote execution stopped, and finding no retained handles. Preserve the full declaration and supporting evidence. Refuse resolution for running, insufficiently evidenced, or unknown states. Handle conflicts individually; resume admission only after all are resolved and ordinary capacity/close gates permit it. Do not rewrite completed business records, original unknown outcomes, or acceptance history. Business contradictions remain with the reconciliation process; resource resolution cannot fabricate success. Same-key receipts remain recoverable; ordinary socket clients, stale revisions, and conflicting evidence are rejected.

## 5. One execution budget

New dispatches default to host `timeouts.turnMs=1800000` (30 minutes). Acceptance remains 30000, drain 300000, interrupt 30000, and reconcile 60000; each remains an integer in 1..86400000 ms. The 1800-second value is a development default requiring real-task calibration, not a normal-duration or cost-benefit guarantee. Upgrade, retries, output messages, and configuration changes must not extend existing durable deadlines.

The total turn budget begins at a point established before dispatch persistence and includes adapter startup, initialization, and acceptance waiting. Acceptance does not grant a fresh turnMs. The engine and adapters share one monotonic budget; UTC deadlines are for persistence/restart diagnostics. Clock rollback, individual RPCs, and ordinary messages do not refresh it.

Internal RuntimeInput gains a host budget carrying policyVersion=2, durable start/end timestamps, and read-only remaining-acceptance/total-budget accessors on the same monotonic clock. This is an in-process capability, not JSON/Python wire data. The engine owns expiry decisions. Adapters use remaining time for each wait and check again before terminal delivery. A late event-loop timer must not make overdue evidence count as on time.

In host mode, both adapters remove their independent implicit 300-second limit and use the shared budget. Standalone adapter execution also defaults to 1800 seconds. Explicit `requestTimeoutMs` / `turnTimeoutMs` remain effective: adapters advertise configured caps in static capability metadata before dispatch. The host takes the minimum of host and explicit adapter caps, persisting effectiveAcceptanceMs/effectiveTurnMs and sources. Request waits are also bounded by remaining total time. An explicit 300-second configuration still enforces 300 seconds, visible in diagnostics.

Distinguish defaults from explicit configuration; an old adapter default must not masquerade as a user cap. Negotiate the internal budget capability. Unsupported adapters return UNSUPPORTED_CAPABILITY before submission rather than execute with hidden deadlines. Wire fake and both built-in adapters; document migration requirements for independent adapters.

Cleanup has a separate finite budget, preserving Claude's default one second and Codex's one second each for TERM/KILL. Cleanup cannot buy extra business execution time. SDK waits, control deadlines, and host close/continue wait limits remain independent of turnMs. Changing only the engine constant while leaving provider timeouts hidden does not satisfy this specification.

## 6. Observability and compatibility

This increment adds `initialize.capabilities.executionIsolation={version:1,resourceRelease:true,schedulerStatus:true,ownerConflictResolution:true,budgetVersion:2}` and retains lifecycle v1. Configuration, capabilities, public schema, and both SDKs are implemented together. Wire remains 1.0; storage schema advances separately to 2.

Read-only `scheduler.get` (`orch.scheduler.get()` in SDKs) returns maxActiveSessions, maxQuarantinedDispatches, executionOccupied=A, quarantined=Q, quarantineReserved=R, canDispatch, reasons, up to 16 occupancy examples (taskId/sessionId/dispatchId, lease state, last evidence, entry time), and `truncated`. It also returns unresolved-conflict count and up to 16 conflictId/revision/dispatch references. Trusted local clients may read this without gaining reconciliation authority. Task/session queries provide task detail; `scheduler.getConflict({conflictId})` returns a selected conflict's original evidence and revision. Stable reasons include `EXECUTION_CAPACITY_EXHAUSTED`, `QUARANTINE_CAPACITY_EXCEEDED`, `HOST_STOPPING`, and `EXECUTION_EVIDENCE_CONFLICT`. Counters/evidence form a consistent database snapshot; host stopping state also affects admission. Queries do not probe execution resources, invoke models, or mutate state.

`sessions.get` adds an optional current-dispatch lease/quarantine summary. Reconcile result adds `executionReleased`, separate from business `resolved`. Configuration/dispatch diagnostics expose effective deadlines, default/explicit sources, and policy version. Python maps new fields to snake_case under existing rules. Ordinary sockets can read; the engine still authorizes owner-only resource/business declarations.

Lease release and admission-block entry/exit emit durable events. Repeated reads do not emit duplicates. Deadline/quota events retain original targets and reasons. Guidance must distinguish waiting for execution to end, checking stop evidence, reconciling business results, and owner restart with adjusted finite limits. Never recommend deleting records, retrying under another key, or forcibly clearing activeDispatchId.

## 7. Numbered acceptance criteria

- AC-A2-01: New default turns record 1800000 ms consistently across engine, Claude, Codex, embedded TS, CLI, and Python stdio. Under controlled time, accepted work beyond 300 seconds but before the new deadline does not time out. Cover both provider protocol fixtures, not only fake.
- AC-A2-02: Shorter explicit host/provider deadlines remain effective; longer provider limits cannot extend the host deadline. Effective values/sources are queryable. Acceptance/initialization consume the total budget; acknowledgments, noise, and clock rollback do not renew it.
- AC-A2-03: Two timed-out executions still running or remotely unknown leave A=2, Q=2, and a third task unstarted. Even if both local PIDs exit, missing remote stop evidence prevents release. New quarantine slots must not inflate concurrency.
- AC-A2-04: Once both receive matched terminal evidence and cleanup confirmation, A becomes 0 while Q stays 2, and the third task starts automatically. The first two remain blocked/unknown without approval, resend, or cleared activeDispatchId.
- AC-A2-05: Terminal evidence before stalled cleanup retains A; late cleanup releases by notification without a model call. Cover Claude Query.close/iterator.return and real owned Codex fixture-process exit. Duplicate, reordered, stale-generation, and conflicting notifications cannot release incorrectly.
- AC-A2-06: Local-only stop, remote-only stop, iterator end, generic error(failed), and cancel acknowledgment are insufficient. Proven non-submission plus cleanup may fail deterministically and release. Unverified terminal capabilities remain held.
- AC-A2-07: Owner localResources/remoteExecution stopped with unknown business outcome/side effects yields `executionReleased=true,resolved=false`, releasing only A. Reject ordinary sockets, active handles, stale targets, and conflicting evidence. Same-key retries do not release twice; changed payloads conflict.
- AC-A2-08: With small quarantine capacity, simultaneous in-flight timeouts and terminal-then-cleanup timeout stay within Q+R. Cleanup still consumes R. At capacity, block admission/new work while preserving original same-key receipts. Queries, cancel, reconcile, approval, and close can settle work. Saved-result resume only requests acceptance even at capacity. Releasing A does not reduce Q; final reconciliation reducing Q restores admission.
- AC-A2-09: Actually kill/restart temporary hosts before and after release commit: before commit recover held, after commit released. Preserve business unknown with no replacement dispatch/replay. Missing legacy fields recover conservatively; reduced limits apply backpressure without losing records.
- AC-A2-10: Late callbacks, exact deadline boundaries, repeated controls, and restart configuration do not extend durable deadlines. Verify 1800 seconds with virtual time, not a real 30-minute test. Drain never automatically escalates to interrupt; continued close waiting remains supported.
- AC-A2-11: Real Node stdio/Unix and TS/Python queries agree on A/Q/R, deadlines, and reasons. New SDKs explicitly reject queries against unsupported old hosts. Ignoring added fields does not grant old clients release authority. Protocol/schema upgrade failures stop before model submission.
- AC-A2-12: Contradictory evidence for the same trusted released target durably halts later dispatch and still reports EXECUTION_EVIDENCE_CONFLICT after restart. Query/resolve by conflictId even after activeDispatchId clears. Validate owner permission, revision, same-key retry, and multiple conflicts. Wrong-target events cannot release leases or impersonate the conflict. Do not undo external actions, kill unrelated processes, or keep using suspect free-slot counts.

## 8. Implementation order and evidence

Write failing tests for AC-A2-03/04/08 and the unified deadline first; record actual RED. Then extend evidence, durable leases, scheduling, both SDKs, and diagnostics. The prior 102 Node / 32 Python results are A history, not A2 evidence. Add regression coverage for already-correct behavior without inventing RED.

Run `npm test`, `npm run test:python`, `npm run typecheck`, and `npm run format:check`. Record independent A2 TDD results and update README to actual behavior. Ordinary verification uses temporary directories, virtual time, and real local fixture subprocesses without reading credentials or invoking paid models. Real-provider stop reliability still requires separate A01/A02/A07 acceptance. Tune 1800 seconds and 32 entries separately with versions, task distributions, and measured results.

## 9. Implementation confirmation and adapter migration

A2 completed on 2026-09-20. Historical A RED/GREEN remains unchanged. New acceptance, review regressions, and complete commands appear in the [A2 TDD summary](../tdd/0003-a2-evidence.md). Archive, GC, and namespace switching remain unimplemented B work.

Third-party RuntimeAdapter implementations must declare `executionBudget={version:2,acceptanceCapMs,turnCapMs}`, using null for caps not explicitly configured. In host mode, derive expiry only from `RuntimeInput.executionBudget` remaining-time accessors. Timers wake and reread the budget rather than establish a second clock. Standalone execution must establish its own monotonic total budget at execute entry. Reject new work/execution-producing resume for legacy adapters before submission, without rejecting saved-result acceptance resume or shutting down the host because an old provider cannot execute.

Stop proof travels through the independent `reportExecutionEvidence` callback, correlated by original dispatch/session/generation/native identity and increasing sequence. Generic RuntimeEvent cannot replace it. Terminal capability requires explicit `executionEvidence={version:1,terminalCoversExecution:true}` and independent provider/profile acceptance. Preserve terminal evidence and report again when cleanup completes, even after the iterator ends. Unknown observations do not overwrite confirmed stopped state; an active correction does, producing a durable conflict if already released. Release certificates persist terminal/local/remote references and original targets.

Reconciliation checks both business terminal evidence and the adapter's retained terminal certificate. Cleanup errors cannot overwrite real results, and sideEffects=unknown cannot bypass checks for a contradictory explicit outcome. Removing an old provider configuration does not prevent owner attestation from settling history. Missing process handles alone are still not stop proof.

Before schema 2 migration, create `store-schema1-<uuid>.sqlite` in the original stateDir and verify integrity, schema, workspace, and storeId. Backup/migration failures must not commit the new schema or model requests. Old engines refuse schema 2. Product flows for backup restoration/new namespaces remain unimplemented; a backup cannot be used as another automatically dispatching host.
