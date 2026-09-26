# SPEC-0022: Interrupting close and verification feedback

Date: 2026-09-23. Status: approved by the owner on 2026-09-23, with D-rc15-1, D-rc15-2 and D-rc15-3 each set to option 1. Evidence: [TDD-0022](../tdd/0022-close-interrupt-and-verification-feedback.md). It corrects the behavior that [SPEC-0016](0016-session-after-task-end.md) S02 documents for `close({mode:'interrupt'})`, and adds to the verification of owner-registered rules ([SPEC-0014](0014-host-workflow-controls.md)). Wire 2.0, storage schema 3 and event schemaVersion 1 do not change.

## Why

A downstream host reported two problems.

1. **`close({mode:'interrupt'})` left a running Claude turn `outcome_unknown`.** The guide says the task pauses with reason `runtime_interrupted`. The host extends Claude's native options, so the Claude adapter needs the host's stop proof (`observeExecutionStop`). The engine asked every running turn to interrupt and then closed the adapters at once. Closing the Claude adapter aborts its wait for the next SDK message, so the structured interrupted result never arrived: the turn ended as `Claude terminal aborted` with an unknown outcome, its dispatch was quarantined, and the task was blocked. The same happens without extended options, because no native terminal arrives. The guide's statement had been checked with the deterministic fake runtime only. Pausing each session with `mode: 'interrupt'` and then closing with `mode: 'drain'` pauses the task as documented, because the session pause waits for the structured result.
2. **A verification retry does not say why the check failed.** The retry prompt names the evidence artifacts by reference only. The agent cannot read them, and no wire method returns an artifact of the current store: `archives.readArtifact` reads archived stores and fails with `ROLLOVER_UNSUPPORTED` without an archive configuration. In the host's tests, three retries in a row did not know why the check had failed.

## Acceptance criteria

### C: Interrupting close

- **C01** `close({mode:'interrupt'})` first asks every running dispatch to interrupt, once, as before. It then waits for the dispatches to end on their own before it closes the adapters. A turn whose runtime reports its interrupted terminal in that time ends like a session pause with `mode: 'interrupt'`: the adapter asks for the host's stop proof when it needs one, the task is paused with reason `runtime_interrupted`, and its session is paused and not quarantined.
- **C02** The wait before closing the adapters lasts at most `timeouts.interruptMs` (default 30 seconds) and at most half of the call's `timeoutMs`. It ends earlier when no dispatch is left.
- **C03** After that wait the engine closes the adapters, which ends turns that did not answer. They keep today's conservative outcome: unknown and quarantined, blocked after the next start. The call's `timeoutMs` still bounds the close's wait for the dispatches and the adapters, from the start of that wait, and dispatches still running at its end still produce `SHUTDOWN_INCOMPLETE`. It does not bound the synchronous durable writes before and after that wait, such as closing the database; this sentence said "the whole close" until [SPEC-0023](0023-corrections-before-0.1.2.md) F03 corrected it.
- **C04** Pausing a running session with `sessions.control` `{action:'pause', mode:'interrupt'}` and then closing with `mode: 'drain'` keeps pausing the task with reason `runtime_interrupted`.
- **C05** When the owner of a stdio host disconnects, the host's cleanup closes the adapters without the wait of C02, so it keeps ending within [SPEC-0003-A](0003-a-lifecycle.md)'s bound and a restarted owner can take the state lock. Running turns stay unknown there, as before. The engine-level option `interruptWaitMs` (0 in that cleanup) sets the wait; `host.shutdown` and the SDKs do not accept it.

### V: Verification feedback

- **V01** When a task with `acceptance.mode: 'checks'` is dispatched again after a failed verification, the prompt lists each failed rule of the latest verification as one line of JSON. Rules run in order and a verification stops at its first failure, so this is one rule today. Each line has `ruleId`, `argv`, `exitCode`, `signal`, `timedOut`, `error`, `outputBytes`, `outputTruncated` and `outputTail`. The prompt still names the evidence artifacts.
- **V02** `outputTail` is the end of the captured output, cut at a character boundary, whose JSON encoding is at most 4 KiB. All lines together, should a verification ever report several failed rules, are at most 16 KiB, counted in UTF-8 bytes after JSON encoding. A rule line that would pass that limit drops its `outputTail` and says `"outputOmitted": "limit"`; rules that do not fit at all are counted in a final line `{"omittedRules": n}`. The output is labeled untrusted.
- **V03** The evidence is the artifact that the engine wrote for the latest verification of the same task. If it cannot be read, or it is not that task's failed verification, the prompt says the details are unavailable and names the artifacts as before.
- **V04** The event `verification.completed` adds `rules`: for every rule that ran, `ruleId`, `passed`, `exitCode`, `signal`, `timedOut`, `error` (a string or `null`), `outputBytes` and `outputTruncated`. It carries no output text.

  Superseded in part by [SPEC-0028](./0028-host-queries-and-lifecycle.md) E03: a failed rule now also carries the output tail that the retry prompt shows, so the event contains what a check printed, which may include workspace paths or secrets.

## Owner decisions (2026-09-23)

- **D-rc15-1, interrupting close:** the engine waits for interrupted dispatches before it closes the adapters (option 1). The alternatives were documenting the close as a resource shutdown, and changing only the Claude adapter.
- **D-rc15-2, verification feedback:** a summary in both the retry prompt and the event (option 1). The alternatives were the prompt only, and a new method to read artifacts.
- **D-rc15-3, owner disconnect:** the cleanup after an owner disconnects keeps closing the adapters at once, and only explicit closes wait (option 1). Implementing C02 showed that the wait broke SPEC-0003-A's bound for that cleanup: its Codex fixture ignores the interrupt, so the host waited the configured 10 seconds. The alternatives were a fixed 3-second cap on every wait, and relaxing SPEC-0003-A.

## Timing invariants

- Every running dispatch receives one interrupt request per close, as before.
- The adapters close only after every dispatch has ended or the wait of C02 has passed, whichever comes first; after an owner disconnects, at once (C05).
- The close ends no later than its `timeoutMs`, as before.
- The verification feedback is computed when the task is dispatched again, from the immutable evidence; it does not change what is stored.

## Boundaries

- The command output of a failed check reaches the model on retry. A rule author who prints secrets exposes them to the agent; the guide says so.
- No new wire method. Hosts learn why a check failed from `verification.completed`; the output text stays in the evidence artifact.
- Real Claude interruption timing is not verified here. The tests use the Claude adapter with an offline query and a real child process.
- A degraded store still closes by releasing resources at once (`closeDegraded`), unchanged.

## Rollback

Each part is a separate code change: revert the close wait, or the prompt and event fields. The event field is additive, and no stored data changes shape.
