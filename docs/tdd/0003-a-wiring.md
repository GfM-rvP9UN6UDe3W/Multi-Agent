# SPEC-0003-A: TypeScript / CLI lifecycle wiring evidence

Date: 2026-09-19. Scope: TS SDK, CLI configuration/local host, public wire schema, and wiring tests. All model tests use fake runtime or explicit protocol fixtures, without credentials/paid models. Engine and Python evidence are separate.

## First RED

Add `tests/contract/lifecycle-wiring.test.ts`, then run:

```sh
node --test tests/contract/lifecycle-wiring.test.ts
```

Actual exit 1: 4 tests / 0 passed / 4 failed.

- Missing/incompatible capability: client.sessions.reconcile is not a function.
- Reconcile target/evidence/key and OperationHandle: entry point absent.
- CLI timeouts: Unknown config field: timeouts.
- EOF emergency budget: actual timeoutMs 1000, expected 30000.

Later GREEN/subprocess/compatibility evidence follows; RED alone is not implementation acceptance.

## Wiring and first real-host run

TS requires exact lifecycle v1 capability before sending reconcile, passes exact target/owner evidence/key, and returns OperationHandle. CLI validates/passes all five timeouts; stdio EOF emergency close is bounded at 30 seconds. JSON Schema adds timeouts, capability, operation lifecycle/resolution, and reconcile requests. Old operations may omit optional fields.

```sh
node --test tests/contract/lifecycle-wiring.test.ts tests/contract/lifecycle-wire.test.ts
```

Actual exit 1: 7 tests / 5 passed / 2 failed.

- Original four wiring regressions were GREEN.
- Actual Node CLI stdio passed: 120 ms drain deadline → outcome_unknown → late original fake result → owner reconcile → paused → explicit acceptance-only resume. Exactly one dispatch.started event.
- Real socket test hit sandbox listen EPERM: an environment failure, neither skipped nor passed.
- New close-continuation assertion found shutdown operation lifecycle missing: kind undefined instead of shutdown. The engine then fixed it.

With local IPC permitted:

```sh
node --test --test-name-pattern='real Unix' tests/contract/lifecycle-wire.test.ts
npm run typecheck
```

Both exited 0. Real Unix host: 1/1 passed. TS reads durable deadline/expiredAt but reconcile returns server-side UNAUTHORIZED. Another client still connects and reads blocked work after the first disconnects. Typecheck passed. This is actual host/SDK wiring with an offline fake runtime.

## Final GREEN

After the engine supplied shutdown lifecycle, rerun with local IPC:

```sh
node --test tests/contract/lifecycle-wiring.test.ts tests/contract/lifecycle-wire.test.ts
node node_modules/prettier/bin/prettier.cjs --check packages/sdk-typescript/src/index.ts packages/cli/src/config.ts packages/cli/src/host.ts schemas/protocol.schema.json tests/contract/lifecycle-wiring.test.ts tests/contract/lifecycle-wire.test.ts
```

Both exited 0: 7 tests / 7 passed / 0 failed / 0 skipped; scoped formatting passed.

Real stdio shutdown with timeoutMs:0 returns SHUTDOWN_INCOMPLETE plus operationId. The connection can read the same operation/shutdown lifecycle. host.shutdown.continue reuses operationId, waits for the actual fake turn, returns closed, and CLI exits 0. Initial timeout is not stop success and does not create a replacement operation.

This covers offline wiring/public contracts. Wider engine/adapter/Python regressions are recorded separately; no real Claude/Codex model acceptance.

## AC-A06: actual owner EOF through Codex owned-process cleanup

Add two real regressions for already-implemented behavior, without source changes or invented RED:

```sh
node --test --test-name-pattern='real owner EOF' tests/contract/lifecycle-wire.test.ts
npm run typecheck
node node_modules/prettier/bin/prettier.cjs --check tests/contract/lifecycle-wire.test.ts
```

All exited 0. Two new tests / two passed / no failures or skips; type/format checks passed. Each starts actual CLI host --stdio with a Codex provider pointing to a local fixture. One hangs at initialize, the other after written turn/start. RPC timeout is 10 seconds; cleanup stages are 40 ms each.

Send actual EOF to host stdin. Each complete test took about 180 ms and asserts host exit 0 within two seconds, owned fixture PID exit, and no SHUTDOWN_INCOMPLETE on stderr. An independently started test process remains alive and is cleaned by its own handle in finally.

Start a second real CLI on the same stateDir. Pre-submission initialize work is failed with cleared activeDispatchId; submitted-but-unacknowledged turn/start remains blocked/outcome_unknown with original activeDispatchId. Both have null result/approvalId. Original-key retries return the same task. Events contain one dispatch.started and no task.completed; fixture spawn log contains only the original PID, proving no replacement dispatch. Finally closes only owned hosts, the independent test process, recorded fixture PIDs, and test temporary directories.

This completes actual EOF resource-chain evidence. Fixtures do not read real Codex identity or call models.
