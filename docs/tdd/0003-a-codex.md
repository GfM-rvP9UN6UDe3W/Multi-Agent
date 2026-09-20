# SPEC-0003-A: Codex owned-resource cleanup and monotonic-clock evidence

Date: 2026-09-19. Scope: `packages/adapter-codex/src/index.ts`, new Codex lifecycle-resource tests, and this record. Tests run local protocol-fixture subprocesses without reading login state, launching real Codex, or calling paid models. Process inspection/cleanup targets only fixtures started by the test that report their own PID.

## RED

First add six tests, then run:

```sh
node --test tests/contract/codex-lifecycle-resources.test.ts
```

Actual exit 1: 6 tests / 0 passed / 6 failed.

- Four initialize/turn-start hang, ignored SIGTERM, and failed-cleanup isolation cases found adapter.close undefined rather than a function.
- Request/terminal cases exceeded the 700 ms test limit under a 60-second wall-clock rollback with continuous unrelated frames, despite configured 180 ms limits.

## Implementation

- Register each spawned AppServerConnection by session. Clear hasActiveResources only on actual child exit or failed-spawn error confirmation. No process scanning, name-based killing, or post-restart persisted-PID cleanup.
- adapter.close actively closes retained connections, wakes waiting RPCs, and prevents new requests/execution. Unconfirmed exit yields SHUTDOWN_INCOMPLETE. Resources remain queryable and close may be retried until exit is observed.
- Preserve closeTimeoutMs as the limit for each TERM/KILL stage, not a new total budget. Initialize failure with confirmed exit and no submitted turn is failed; written turn/start without terminal evidence remains unknown. Cleanup itself produces no interrupted/completed business terminal state.
- RPC and terminal deadlines use performance.now; noise plus wall-clock rollback cannot extend them. Set turn may-have-been-sent only after the request is actually written.

## GREEN

```sh
node --test tests/contract/codex-lifecycle-resources.test.ts tests/contract/adapters.test.ts
npm run typecheck
node node_modules/prettier/bin/prettier.cjs --check packages/adapter-codex/src/index.ts tests/contract/codex-lifecycle-resources.test.ts
```

All exited 0. 22 tests / 22 passed / 0 failed / 0 skipped: six new cases and 16 existing adapter cases. Type and scoped formatting checks passed.

New coverage includes active close during real fixture initialize/turn-start hangs, KILL after ignored TERM with observed exit, per-session occupancy, and clock rollback with continuous noise. The unconfirmed-exit path replaces ChildProcess.kill in the test with a false return, keeping the real fixture alive. First close fails and the hook stays true. Restore signaling, close again, confirm the owned PID disappears, then the hook becomes false.

This verifies offline protocol/process lifecycle, not actual Codex business-model acceptance. Host EOF and engine resource-hook reconciliation wiring are recorded in the corresponding engine evidence.
