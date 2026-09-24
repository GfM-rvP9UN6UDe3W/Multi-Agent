# SPEC-0025: A crashed host's socket, in-process errors and a failed scheduler

Date: 2026-09-24. Status: approved by the owner on 2026-09-24, who accepted the review's recommendation to correct these three findings together after SPEC-0024. Evidence: [TDD-0025](../tdd/0025-operability-and-sdk-errors.md).

## Why

The same review of 0.1.2 found three problems that each leave a user without a clear next step.

- **S:** a socket host that ended without closing, after SIGKILL, an out-of-memory kill or a power loss, leaves its socket file behind. The next `orchvia host --socket` then refuses to start with `SOCKET_IN_USE: Socket path already exists; refusing to replace it`, and neither the message nor the documentation says that the file may be removed.
- **E:** the embedded orchestrator of `createOrchestrator` rejects a failed read, such as `tasks.get` of an unknown task, with the engine's own `OrchestrationError`, whose details are in `details`. A socket client gets `OrchestratorError`, whose details are in `data`. Code that checks `error instanceof OrchestratorError` or reads `error.data` works over a socket but not in-process, although both are the same API. Mutations were already wrapped.
- **F:** when the engine stops accepting work after an internal failure, such as a result it cannot write, `scheduler.get` reports `HOST_STOPPING` and writes are refused with `HOST_STOPPING: Engine is stopping`, exactly as while it shuts down on request. Only the host's error output says what failed.

## Acceptance criteria

### S: A crashed host's socket

- **S01** When `orchvia host --socket` finds a socket at its path on which no process accepts connections, it removes that socket and starts. It checks this only after the engine holds the state's owner lock, and the socket's directory must already be a directory that only the current user can use.
- **S02** It still refuses with `SOCKET_IN_USE`, and removes nothing, when a process accepts connections on the path, or when the path is anything but a socket: a file, a directory or a link. The message says which of the two it is.

### E: In-process errors

- **E01** The embedded orchestrator rejects every error of a call as an `OrchestratorError` built as a socket host builds it: the error's code, or `INTERNAL_ERROR` when it has none, its message, and `data` holding its details and the code. The original error is its `cause`, so a programming error keeps its stack. Mutations already did this.
- **E02** An error that the SDK raises itself before a call reaches the engine, such as `ABORTED` for an aborted signal, is rejected unchanged.

### F: A host stopped by a failure

- **F01** When the engine stops accepting work after an internal failure, it keeps the first failure's step, error code (`INTERNAL_ERROR` for an error without one) and time. The steps are the scheduler pass, the storage collection, and persisting deadlines, execution evidence, usage, runtime observations and execution releases.
- **F02** `scheduler.get` then lists `SCHEDULER_FAILED` besides `HOST_STOPPING`. Clients must already tolerate new reason strings.
- **F03** Writes are still refused with `HOST_STOPPING`. The message names the failed step and its code, and the error's details (`data` in both SDKs) hold `failure: {step, code, at}`. A stop on request keeps the message `Engine is stopping`, without `failure`.

No other behavior changes: a stopped engine dispatches nothing, and a restart recovers as before.

## Tests

- Contract: a socket host killed with SIGKILL leaves its socket, and a second host with the same configuration starts on it and serves a client. A host refuses to start, and leaves the path as it was, when another process listens on it and when a regular file is there (S01, S02).
- Contract: `tasks.get` of an unknown task fails with the same error type, code, message and data in-process and over a socket (E01). A read with an aborted signal still fails with the SDK's own `ABORTED` (E02).
- Engine: evidence and results that cannot be written stop the engine; `scheduler.get` lists `SCHEDULER_FAILED`, and `tasks.create` is refused with `HOST_STOPPING` and `failure` naming the step that failed first, the execution evidence of the turn. While a close runs, `tasks.create` is refused with `Engine is stopping` and `scheduler.get` has no `SCHEDULER_FAILED` (F01 to F03).
