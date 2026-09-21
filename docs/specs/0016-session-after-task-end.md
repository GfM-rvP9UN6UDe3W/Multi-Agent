# SPEC-0016: Sessions after their task ends

Date: 2026-09-21. Status: approved by the owner; implemented on branch `axion-rc10` for rc.10. Evidence: [TDD-0016](../tdd/0016-session-after-task-end.md). Origin: an embedding host found that a session could not be used again after its interrupted dispatch was reconciled. The host also asked how closing or losing the host affects running work.

## Problem

[SPEC-0003-A](0003-a-lifecycle.md) says a failed or interrupted reconciliation fails the task, and a separate task continues the work. In that case the engine left the session `paused`, and `sessions.control` refused every command for a session whose associated task had ended (`STALE_TARGET`, `Task is terminal`). Tasks that reuse the session stayed `queued`, because only an `idle` session accepts work. The same state followed a client pause of a session whose task was waiting for acceptance, once the task was approved or denied. The session and its native history were stranded; the host could only stop it and open another session.

Hosts also had no guide to what closing or losing the host does to running and queued work, or to the cost of an unresolved attestation.

## Acceptance criteria

- **S01 — Resume a session whose task ended:** `sessions.control` with `action: "resume"` on a `paused` session whose associated task is `completed`, `failed` or `cancelled` returns the session to `idle` and clears its `pauseOrigin`.
  - It reruns and resends nothing. The next task that reuses the session continues its native history, and queued tasks that reuse it dispatch on the next scheduler pass.
  - The call uses the same exact target as other controls.
  - It succeeds only when no dispatch or runtime resource of the session remains active; otherwise it fails with `RUNTIME_STILL_ACTIVE`.
  - A bound runtime may still resume only a runtime pause (`UNAUTHORIZED`).
  - Resuming a session that is not paused is a no-op.
  - Other commands on a session whose task ended still fail with `STALE_TARGET`.
  - Sessions awaiting reconciliation still fail with `OUTCOME_UNKNOWN`, and closed sessions with `SESSION_CLOSED`.
- **S02 — Close, crash and reconciliation guide:** The wiring guide states:
  - `close({mode: "interrupt"})` pauses running tasks with reason `runtime_interrupted`, and pauses their sessions without a `pauseOrigin`. It pauses queued tasks with `owner_shutdown`. `tasks.resume` continues them. `close({mode: "drain"})` waits for running turns until its timeout.
  - A client pause records `pauseOrigin: "client"`. A host that resumes interrupted work after a restart must skip sessions whose `pauseOrigin` is `client`.
  - If the host process ends before `close` completes, running tasks become `blocked` with reason `outcome_unknown: previous owner exited during a dispatch`. Their sessions become `outcome_unknown`, and each holds an execution slot and a quarantine slot. At the next start, queued tasks are paused with `owner_restart`.
  - Reconciling with an unknown outcome or unknown side effects releases only the execution slot. The dispatch keeps its quarantine slot until a later attestation resolves it. Once `limits.maxQuarantinedDispatches` (default 32) slots are held, no new work is admitted.
  - A resolved attestation with `outcome: "interrupted"` releases both slots, fails the task and leaves the session paused. Resume the session (S01), then create a task that reuses it to continue with its history.
- **S03 — Intel macOS evidence:** The CI native job also runs on an Intel macOS runner. The Claude binary, the writable profile's sandbox and the Codex binary then have real-binary evidence on x86-64 macOS.

## Verification

Record an observed RED for S01 against `7c9e922` before changing the engine. Cover a dispatch whose owner process was killed and then reconciled as interrupted; a session paused before its task was approved; the same before a denial; and the Python SDK. S02 is documentation; S03 is shown by the CI native job. No credentials or paid models are used.
