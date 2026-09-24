# TDD-0025: A crashed host's socket, in-process errors and a failed scheduler

Date: 2026-09-24. Base: `f9aaa07` (SPEC-0024 on `main` at `40d2afe`). Specification: [SPEC-0025](../specs/0025-operability-and-sdk-errors.md).

## RED

`tests/contract/host-socket-recovery.test.ts`, `tests/contract/sdk-errors.test.ts` and `tests/engine/host-failure.test.ts` against the base: 5 of 7 tests failed.

- `0025-S01`: after the first host was killed with SIGKILL, the second exited at once with `{"code":"SOCKET_IN_USE","message":"Socket path already exists; refusing to replace it"}`.
- `0025-S02`, a listener on the path, and `0025-S02`, a regular file there: the host refused and removed nothing, but both times with the same message, which says neither that another process accepts connections nor that the path is not a socket.
- `0025-E01`: the embedded orchestrator rejected `tasks.get` of an unknown task with `{ isOrchestratorError: false, name: 'OrchestrationError', code: 'NOT_FOUND', message: 'tasks object not found', data: undefined }`; a socket client got `{ isOrchestratorError: true, name: 'OrchestratorError', code: 'NOT_FOUND', message: 'tasks object not found', data: { id: 'missing-task', code: 'NOT_FOUND' } }`.
- `0025-E02`, the SDK's own `ABORTED`: passed.
- `0025-F01` to `F03`: the artifact write that the test's storage fault fails stopped the engine, whose `scheduler.get` reported only `HOST_STOPPING`; the test's 5-second watchdog ended with `No SCHEDULER_FAILED: HOST_STOPPING`.
- `0025-F03`, a stop on request: passed.

## Changes

- `startUnixHost` (`packages/cli/src/host.ts`) looks at what is at the socket path. A socket on which no process accepts connections, which it learns by connecting and getting `ECONNREFUSED`, is removed. A socket that accepts, or answers neither way within a second, and anything that is not a socket, are refused with `SOCKET_IN_USE` and a message that says which.
- The embedded orchestrator's caller in `packages/sdk-typescript/src/index.ts` rejects every error of an engine call as `OrchestratorError`, built as the host's `errorData` builds the error it sends, with the original error as `cause`. Its abort check stays before the engine call.
- The engine keeps the first internal failure that stops it (`stopAfterFailure`, at the seven places that stopped it before), lists `SCHEDULER_FAILED` in `scheduler.get`, and refuses writes with `HOST_STOPPING`, a message that names the step and code, and `failure` in the details. `schemas/protocol.schema.json` names the new reason; `npm run generate:protocol` rewrote the generated copies.

Found on the way:

- The test first expected the result write to fail first. The fake runtime reports execution evidence, which is also stored as an artifact, before its result, so the evidence write fails first, and the engine keeps that failure. The test now expects it.
- The listener in `0025-S02` wrote to the host's probe connection after the probe had closed it, and the test failed with `EPIPE`. The listener now ignores errors on its connections.
- `hostError` first returned an `OrchestratorError` unchanged. The mutation check showed that no path reaches it: the SDK raises its own errors before it calls the engine, and the engine never raises the SDK's error class. The guard was removed, and E02 now states that boundary.

## GREEN

- The three files: 7 of 7.
- `npm test`: 617 of 617. `npm run test:python`: 91 of 91. Typecheck, formatting and the generated-contract check passed.

## Mutation checks

| Mutation | Result |
| --- | --- |
| Every socket at the path counts as abandoned | caught by `0025-S02`, listener: the host removed the other process's socket |
| The path is not checked to be a socket | caught by `0025-S02`, regular file |
| In-process errors are not wrapped | caught by `0025-E01` |
| The abort check moves into the wrapped part | caught by `0025-E02`: `ABORTED` got a `cause` |
| No failure is kept | caught by `0025-F01` to `F03` |
| A stop on request is kept as a failure | caught by `0025-F03`, stop on request |

## Not verified

- A listener that accepts no connection and refuses none within a second is taken for a live host; the test does not produce one.
- Socket paths on network file systems.
