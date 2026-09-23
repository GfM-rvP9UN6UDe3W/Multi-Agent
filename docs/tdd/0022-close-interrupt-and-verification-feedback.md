# TDD-0022: Interrupting close and verification feedback

Date: 2026-09-23. Base: `8351a43`. Branch `close-interrupt-proof`. Specification: [SPEC-0022](../specs/0022-close-interrupt-and-verification-feedback.md).

## RED

### C: Interrupting close

`tests/contract/claude-close-interrupt.test.ts` runs the Claude adapter configured like the downstream host: extended native options, so the adapter needs the host's stop proof, and an `observeExecutionStop` that answers true. An offline query stands in for the SDK and starts a real child process, which the adapter observes and cleans up.

- **0022-C01** failed. After `close({mode:'interrupt', timeoutMs: 10000})` and a restart on the same state directory, the task was `blocked` with reason `outcome_unknown: previous owner exited during a dispatch`; its dispatch was quarantined with `lastEvidence: terminal_error`. The adapter's wait for the next SDK message had been aborted by the adapter close, which the engine started right after asking the turn to interrupt, so the turn ended as `Claude terminal aborted` with an unknown outcome.
- **0022-C02** failed twice: with `timeouts.interruptMs: 300` and a turn that ignores the interrupt, the close returned after 25 ms; with a 1-second `timeoutMs`, after 23 ms. Neither waited.
- **0022-C04** passed before the change: pausing the session with `mode: 'interrupt'` and then closing with `mode: 'drain'` already paused the task with reason `runtime_interrupted` and asked for the host's stop proof. It stays as regression coverage and is the workaround for hosts on earlier versions.
- **0022-C05**: the first implementation of C02 made two existing tests fail, `0003-A real owner EOF reaps its Codex initialize child` and `… turn-start child`, with `Owner EOF exceeded test cleanup deadline` after 6.7 seconds. Their Codex fixture ignores the interrupt, and the host's cleanup after its owner disconnects now waited the configured 10 seconds. The owner chose D-rc15-3 option 1: that cleanup passes `interruptWaitMs: 0`.

### V: Verification feedback

`tests/engine/verification-feedback.test.ts` wraps the fake runtime to record every prompt. The feedback module first returned the old line, so that the failures come from behavior rather than a missing module.

- **0022-V01** failed: the retry prompt had no line of JSON, only the evidence references.
- **0022-V03** failed: without readable evidence the prompt did not say that the details are unavailable.
- **0022-V04**, first version, failed: the event had no `rules`.
- The first versions of V02 and V04 assumed that every rule runs. Implementing them showed that a verification stops at its first failed rule, so the evidence holds only the rules that ran. V02 now checks a large output through the engine and the list limits through the module; V04 checks the rules that ran. Their rewritten forms were not observed failing on their own; the mutations below show what they detect.

## Changes

- `LocalEngine.close`: with `mode: 'interrupt'`, after asking the running dispatches to interrupt, it waits for them before it closes the adapters: `interruptWaitMs`, by default the smaller of `timeouts.interruptMs` and half of `timeoutMs`. `EngineCloseOptions` adds `interruptWaitMs` at the engine level only; `host.shutdown` still accepts only `mode`, `timeoutMs`, `operationId` and `idempotencyKey`.
- `packages/cli/src/host.ts`: the cleanup after the owner disconnects passes `interruptWaitMs: 0`.
- `packages/engine/src/verification-feedback.ts`: the retry prompt's account of the failed rule, and each rule's summary for `verification.completed`. The engine reads the evidence artifact it wrote last for the task, with a limit derived from the task's frozen rules.
- The guide's close and verification sections, the status table, `.claude/CLAUDE.md` and the changelog.

## GREEN

- `node --test tests/contract/claude-close-interrupt.test.ts tests/engine/verification-feedback.test.ts`: 9 of 9. The two Codex owner-EOF tests pass again, in 0.3 to 0.5 seconds.
- `npm test`: 585 passed (576 before, plus the nine SPEC-0022 tests), none failed or skipped. `npm run test:python`: 81 passed. Typecheck, formatting, the generated-contract check and `git diff --check` passed.

## Mutation checks

| Mutation | Result |
| --- | --- |
| The close does not wait | caught (C01, C02) |
| The wait ignores half of `timeoutMs` | caught (C02) |
| The wait ignores `timeouts.interruptMs` | caught (C02, C03) |
| The owner-EOF cleanup waits too | caught (C05) |
| `verification.completed` has no `rules` | caught (V04) |
| The retry prompt keeps the old line | caught (V01, V02) |
| The output tail is not bounded | caught (V02) |
| Evidence of another task is used | caught (V03) |
| Rules that do not fit are dropped without a count | caught (V02) |

## Not verified

- Real Claude interruption timing: the tests use an offline query and a real child process.
- The Codex adapter under an interrupting close against a real App Server.
- Whether real models repair better with the feedback; no model was called.
