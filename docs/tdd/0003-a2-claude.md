# SPEC-0003-A2: Claude execution budget and stop evidence

Date: 2026-09-19. Scope: `packages/adapter-claude/src/index.ts` and `tests/contract/adapter-claude-a2.test.ts`. Based on [A2](../specs/0003-a2-execution-isolation.md) and internal [shared engine types](../../packages/engine/src/types.ts). No paid-model calls.

## Behavior

- Capability metadata reports explicit requestTimeoutMs/turnTimeoutMs as caps and unspecified values as null, rather than treating old defaults as user caps. Supports budget v2 and evidence v1. Standalone execution shares a default 1,800,000 ms total deadline from execute entry, without resetting on acceptance. Host mode uses engine monotonic remaining-time functions and rechecks after terminal arrival. Acceptance waiting is bounded by both acceptance and total remaining time.
- Pre-submission close, permission refusal, cancellation, load failure, or exhausted budget reports pre_submission with both resources stopped. After submission, only a result matching the current Claude session reports remote stop. Generic exceptions, disconnection, timeout, and wrong-session terminals do not.
- Matched terminal evidence first reports runtime_terminal synchronously while local resources remain unknown. After baseline Query.close/iterator.return cleanup confirmation, report resource_observation. Retained handles keep the original callback and report late cleanup even after execute ends. Per-execution sequences increase; repeated cleanup does not duplicate reports. RuntimeEvent semantics stay unchanged; unconfirmed cleanup withholds success as unknown.

## TDD evidence

Add six behavior tests; `node --test tests/contract/adapter-claude-a2.test.ts` gives **0/6, RED**: missing capability fields, renewed full deadline after acceptance, absent evidence callback, no late-cleanup notification, wrong-session success, and no pre-submission stop evidence. After implementation, `node --test tests/contract/adapter-claude-a2.test.ts tests/contract/claude-deadlines.test.ts tests/contract/adapters.test.ts` gives **38/38, GREEN**.

Add exhausted-host-budget-before-send: **6/7**, new RED because query was called. Pre-submission budget checks yield **39/39 GREEN** across the three files. Review found discarded late matched terminals could retain slots after execution ended. Add late terminal: **7/8**, new RED; fix yields **40/40 GREEN**. Late terminals add stop evidence without converting timed-out business results to success. `npx prettier --check packages/adapter-claude/src/index.ts tests/contract/adapter-claude-a2.test.ts` passed.

Further review found host remaining values passed directly to local setTimeout could expire before the host clock. A constant host 20 ms remainder with SDK response at 30 ms gave **8/9 RED**. Host-owned expiry fixed it, but a never-returning SDK with decreasing budget gave **9/10 RED** at the 200 ms guard. Final timers only wake within 50 ms to reread host remaining time; zero triggers expiry. Standalone mode keeps local monotonic deadlines. Claude A2, existing deadline, and old lifecycle suites reached **40/40 GREEN**, including retained cleanup.

Initial npm run typecheck found seven shared-wiring errors while Orchestrator.scheduler was absent, with none in Claude code/tests. After shared wiring completed, typecheck passed. The primary A2 task ran full engine/Python/cross-language verification. Fixtures prove offline contracts and controlled cleanup only; real SDK subprocesses and terminal coverage still require SPEC-0002 provider acceptance.
