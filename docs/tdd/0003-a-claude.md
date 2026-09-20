# SPEC-0003-A: Claude bounded execution and cleanup evidence

Date: 2026-09-19. Scope: Claude Agent SDK adapter and `tests/contract/claude-deadlines.test.ts` only. No paid models, credential changes, or shared-engine type changes. The deadlines/cleanup interpretation below record the historical A increment; A2 later revised budget semantics.

## Behavior and boundaries

- `requestTimeoutMs` defaults to 30,000 ms from execute start to upstream acceptance with session ID. Historical `turnTimeoutMs` defaults to 300,000 ms from acceptance to terminal, an absolute deadline not renewed by ordinary messages. `cleanupTimeoutMs` defaults to 1,000 ms. All require safe integer values in 1..2,147,483,647 ms.
- Already-cancelled input reports interrupted before `query()`, proving non-submission. After query invocation, timeout, disconnection, cancellation, or local close reports unknown even without acceptance acknowledgment. `AbortController.abort()` is not upstream interruption evidence.
- Each query owns an AbortController. Consumer stop, errors, timeout, and adapter.close trigger cleanup. Prefer public Query.close and also make a bounded iterator.return call. This baseline treats normal close return or completed return as cleanup confirmation; that is an implementation interpretation, not an OS-level exit measurement. If neither confirms, execution returns error(outcome="unknown"), adapter.close rejects, and the handle stays retained. A late completed return may permit a later close. Attach rejection handlers to late next/return results to avoid unhandled rejections.
- Deliver successful results/usage only after cleanup confirmation, avoiding success while local cleanup is unconfirmed. `capabilities().interrupt` remains false.
- Use `performance.now()` so clock rollback does not extend acceptance/terminal waits. Attach next() success/failure handlers before cancellation/expiry checks. Register a Query as active immediately; iterator-construction failure still calls Query.close.
- `hasActiveResources(sessionId)` finds owned queries with unconfirmed cleanup even after execute returns unknown, letting reconciliation reject false stopped-resource declarations. In this baseline, only completed Query.close or iterator.return with `done:true` clears occupancy. `done:false`, rejection, and no response do not; late done:true may clear it later.

The published SDK declaration includes [`Options.abortController`](https://app.unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.220/files/sdk.d.ts) and `Query.close(): void`, whose API comment describes process/resource cleanup. Query.interrupt control is for streaming input/output; the current string-prompt path does not depend on it. Tests inject query fixtures without installing the SDK. Actual SDK-version behavior and real process exit require independent acceptance.

## TDD record

First add seven contract tests and run `node --test tests/contract/claude-deadlines.test.ts`: **0/7, RED**. Five exceeded the 300 ms test deadline due to unbounded next/return; the others exposed missing adapter.close and timeout validation. Add regressions for messages not extending terminal deadlines, handled late next rejection, late return enabling repeated close, and success withheld during unconfirmed cleanup: **27/27, GREEN**.

Review added cancellation-before-wait-registration, clock rollback, and iterator-construction failure: **3 RED** against the previous implementation. The runner reported late rejection, rollback exceeded the 300 ms limit, and Query.close was not called. The old timer grew with rollback; that test process was terminated after failure evidence was collected. After fixing and adding expired-deadline late-rejection coverage: **31/31, GREEN**.

Two later RED cases targeted reconciliation bypass: missing hasActiveResources after cleanup timeout and return done:false not releasing occupancy. The focused suite produced **14/16**, two failures from the missing hook. After implementation, `node --test tests/contract/claude-deadlines.test.ts tests/contract/adapters.test.ts` reached **32/32, GREEN**, and `npx tsc --noEmit --pretty false` passed. The primary task reran the full engine suite.

Coverage includes pre/post-acceptance hangs, consumer stop, adapter close, Query.close confirmation, refusal when iterator cleanup is unconfirmed, pre-submission cancellation, invalid durations, and late rejection. A synchronously blocked JavaScript event loop cannot run timers. Fixtures cannot prove a real SDK process exited on a given machine or substitute the SDK close contract for OS-level PID evidence.
