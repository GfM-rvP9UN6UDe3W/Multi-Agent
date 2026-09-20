# SPEC-0003-A: Lifecycle delivery and TDD evidence

Date: 2026-09-19. Covers the A increment of the [implementation contract](../specs/0003-a-lifecycle.md) and [SPEC-0003](../specs/0003-policy-retention-deadlines.md): engine deadlines, unknown isolation, owner attestation, bilingual wiring, and adapter cleanup. B retention/GC/storage-failure policy and C routing/cost accounting remain unimplemented.

## RED and fixes

Write eight engine behavior tests, then run:

```sh
node --test tests/engine/lifecycle.test.ts
```

Actual **0/8, exit 1**. Failures: no durable operation lifecycle; acceptance/drain/interrupt timeout left running or persisted state; late results entered waiting_approval; sessions.reconcile was missing; deadline configuration was not validated. Original output was saved locally at `/private/tmp/dsh-0003-a-red.log`; this document retains key results without depending on that temporary log as a deliverable.

Implementation expanded to 14 engine regressions. Independent review found/fixed two races:

- The observation loop ended while Claude retained an unconfirmed Query. Checking only engine flights allowed false stopped-resource declarations. Add adapter resource checks; actual adapter+engine integration returns RUNTIME_STILL_ACTIVE without a second dispatch. The independent reproduction also confirms refusal and incomplete close after the fix.
- An overdue terminal Promise could settle before its timer callback, incorrectly completing pause. New RED expected outcome_unknown but got completed. Check monotonic deadlines during event handling and before terminal commit; timers only wake the loop. The original reproduction now stays blocked/outcome_unknown with expiredAt saved.

Those review tests initially passed **1/2**: the timer race was RED; active-resource coverage was already GREEN after the adapter fix. Already-passing behavior was not recorded as a historical failure.

Other modules have separate [Claude](./0003-a-claude.md), [Codex](./0003-a-codex.md), [TS/CLI](./0003-a-wiring.md), and [Python](./0003-a-python.md) evidence.

## Behavior and coverage

| Criterion | Implementation and offline proof |
| --- | --- |
| AC-A01 | Durable enteredAt/deadlineAt, policy version, exact control target; finite integer configuration; rollback/delayed-callback tests; repeats preserve deadlines; real host SIGKILL/restart reads original deadlines without replaying pause or dispatch |
| AC-A02 | Definite pre-submission failure releases capacity; possible submission without confirmation atomically blocks task and marks session/dispatch/messages/outbox/controls unknown. Iterator end/restart do not release unreconciled dispatch slots |
| AC-A03 | Drain timeout never implicitly interrupts. Signals, iterator end, and process exit cannot fabricate business interruption. Superseded timers do not affect later controls |
| AC-A04 | Late results remain original-dispatch terminalEvidence without automatic task completion. Conflicting declarations fail. Reconciled output needs resume for acceptance; events prove no second dispatch |
| AC-A05 | Full owner_attestation audit artifact; ordinary Unix sockets rejected. Historical A keeps isolation for local-only stop or any unknown. Active handles block release. Exact targets/idempotency and restart-persistent resolution are covered |
| AC-A06 | close/continue reuse operationId and return bounded SHUTDOWN_INCOMPLETE. Claude hanging next/return retain unconfirmed handles. Codex closes hanging RPC connections, escalates TERM/KILL, observes exit, retains failed cleanup for retry. Actual CLI EOF kills owned fixtures while unrelated test processes survive; restart preserves failed/unknown without replay |

Reconciliation is an explicit owner declaration, not automatic Claude/Codex history lookup. Completed attestation requires the complete result. Historical A business release requires reconciled local resources, remote execution, and side effects. not_executed stays paused until explicit requeue; completed saves output and stays paused until acceptance-only resume; failed/interrupted fails the task. Original unknown controls retain history and gain resolution.

## Full verification

After adding actual EOF wiring regressions, Node increased by 45 (57 → 102), Python by seven (25 → 32):

| Command | Actual result |
| --- | --- |
| `npm test` | 102/102 passed; 0 failed, 0 skipped |
| `npm run test:python` | 32/32 passed |
| `npm run typecheck` | exit 0 |
| `npm run format:check` | Initially flagged two changed files; formatting only those files yielded exit 0 |
| `python3 -m compileall -q python/src/agent_orch python/tests` | exit 0 |

The first sandbox baseline run had three local Unix listen EPERM failures among 57 Node tests; new socket tests met the same limit. Full results above came from an environment permitting local IPC, without skipping cases or calling environment failures product RED.

Tests used temporary workspace/stateDir, separate SQLite databases, real Node/Python subprocesses, and offline protocol fixtures. At this historical increment, the directory had no Git metadata, so initial file hashes bounded changes. The increment did not initialize Git, commit, publish, or delete existing files.

## Unproven boundaries

- No real Claude/Codex model, cache-hit, cost, or production-task acceptance. Claude cleanup uses public Query contract interpretation/fixtures, not observed real SDK PIDs.
- No post-restart scan/termination of leftover processes. Only handles spawned by this instance are controlled, never persisted PIDs. PID reuse/shared external-runtime takeover is unsupported; no real PID-reuse experiment is claimed.
- Bounded responses require JavaScript event-loop scheduling. Timers cannot preempt permanently blocked synchronous code. Deadline checks prevent overdue results being counted on time once scheduling resumes.
- GC, tombstones, disk-full policy, contextPlan, automatic cost routing, and compact/rotate/fork remain unimplemented. Restore old records conservatively without replay; model permissions/network listeners were not broadened.
