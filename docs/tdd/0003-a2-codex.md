# SPEC-0003-A2: Codex unified budget and execution-stop evidence

Date: 2026-09-19. Scope: `packages/adapter-codex/src/index.ts`, `tests/contract/codex-execution-isolation.test.ts`, and this evidence. Implements [A2](../specs/0003-a2-execution-isolation.md) against frozen internal RuntimeInput/ExecutionEvidence contracts. No engine/other-adapter changes or real-model requests in this subtask.

## RED

Add 12 behavior tests, then run:

```sh
node --test tests/contract/codex-execution-isolation.test.ts
```

Actual exit 1: 12 tests / 0 passed / 12 failed, rather than type/compile failures.

- Missing explicit provider-cap and stop-evidence capability metadata.
- Virtual time beyond 301 seconds in host/standalone modes hit the old 300-second deadline incorrectly.
- Initialization exhausting the host total budget still submitted. Acceptance renewed the deadline; explicit total caps also restarted after acceptance.
- Matched terminal, late child exit after stuck cleanup, local disconnect, wrong native identity, and definite pre-submission cases lacked independent evidence callbacks.
- Budget exhaustion during simulated evidence persistence still yielded success.

After initial implementation, add two compatibility boundaries:

```sh
node --test --test-name-pattern='longer explicit standalone' tests/contract/codex-execution-isolation.test.ts
node --test --test-name-pattern='negotiated host clock' tests/contract/codex-execution-isolation.test.ts
```

Both exited 1: 2/2 and 1/1 failed. Standalone mode incorrectly clamped explicit longer values to defaults. Host mode added a local cap clock and expired while the injected host clock retained time. Fix: standalone explicit values replace defaults; host mode uses negotiated remaining callbacks only, while static provider caps let the engine compute the minimum.

Finally check timer wake semantics:

```sh
node --test --test-name-pattern='timer wakeups|stalled stream' tests/contract/codex-execution-isolation.test.ts
```

Before the fix: exit 1, 2 tests / 1 passed / 1 failed. Constant host remaining=20 ms with a real fixture response at 30 ms exposed local timer wake being mistaken for expiry. The stalled stream with decreasing host time already expired correctly and remained a regression. Wakeups now reread authoritative remaining time, reschedule if positive, and reject only at remaining<=0.

## Implementation contract

- Standalone defaults: total 1800000 ms and acceptance 30000 ms, both fixed at execute entry. Acceptance, subsequent RPCs, and output do not renew them. Host mode uses ExecutionBudget v2 remaining acceptance/total values; RPCs respect both and terminal delivery rechecks total time. Cleanup remains independent TERM/KILL stages, each using closeTimeoutMs.
- Metadata exposes only explicit requestTimeoutMs/turnTimeoutMs, otherwise null. The read-only adapter declares terminalCoversExecution; an internal capability is not real-provider production acceptance.
- Matched native thread/turn success, failure, or confirmed interruption first reports runtime_terminal. Unconfirmed cleanup leaves localResources unknown and retains terminal evidence. Actual child exit reports independent resource_observation, preserving original dispatch/session/generation and increasing sequence even after execute ends.
- Submitted work without a matched terminal gets only localResources=stopped from child exit; remoteExecution stays unknown. Wrong thread/turn provides no stop proof. Only definite non-submission plus cleanup yields pre_submission with both stopped. Standalone generation defaults to 1.
- Callbacks do not change RuntimeEvent fields/counts. Late cleanup does not replace an earlier cleanup error with success. Callback exceptions emit stderr warnings; the host callback must stop scheduling on persistence failure.

## GREEN

```sh
node --test tests/contract/codex-execution-isolation.test.ts tests/contract/codex-lifecycle-resources.test.ts tests/contract/adapters.test.ts
npm run typecheck
node node_modules/prettier/bin/prettier.cjs --check packages/adapter-codex/src/index.ts tests/contract/codex-execution-isolation.test.ts
```

All exited 0: 39 tests / 39 passed / 0 failed / 0 skipped, comprising 17 new, six existing Codex resource, and 16 existing adapter tests. Type/scoped-format checks passed.

All Codex protocol interactions use real local fixture subprocesses. Injected monotonic clocks/host callbacks cover 301 seconds, longer caps, and clock disagreement without real long waits. Late-cleanup tests keep an owned fixture alive while TERM/KILL replacements fail, confirm the iterator ended without local stop evidence, then terminate only that owned PID and verify the original-dispatch notification. Tests clean only their processes/directories.

This proves Codex A2 adapter contracts and old-behavior regression. Durable leases, scheduling counts, bilingual wiring, migration, and real-model acceptance have separate evidence.
