# SPEC-0023: Corrections before 0.1.2

Date: 2026-09-23. Status: approved by the owner on 2026-09-23 and implemented: F, E01, E02 and W with D-known-1 = 1, D-known-2 = 1 and D-known-3 = 2; E03, found while testing E02, with D-known-6 = 1; and P, implemented before the release (D-known-4 = 1), with its design approved as D-known-7 = 1. The owner decided that 0.1.2 is released only after every known issue is solved, and that the verification gaps that the README lists as not verified do not block it (D-known-5 = 1). Evidence: [TDD-0023](../tdd/0023-corrections-before-0.1.2.md).

## Why

Besides the work already on branches (issues #12 to #14, one version number in SPEC-0021 P08 and P09, the 0019-C04 flake and stale documentation), four known issues remained:

- **F:** a CI flake. The lifecycle-wire tests give a stdio host 5 seconds to answer `initialize`, and a loaded runner can take longer to start it. It failed the first CI run of the rc.10 pull request; delaying the host start by 6 seconds reproduces it.
- **E:** the Python SDK hides why its host did not start. It raises `CONNECTION_CLOSED` with empty `data`, while the host printed `{"code":"INVALID_CONFIG",...}` on its error output.
- **W:** every CI job warns that its actions run on Node.js 20, which GitHub deprecates. The offline workflow also names actions by tags that can move.
- **P:** a host's stop observer cannot tell which operating-system processes belong to a dispatch.

## Acceptance criteria

### F: Stdio fixture waits (tests only)

- **F01** The lifecycle-wire stdio fixture waits up to 10 seconds for each response, as the CLI shutdown fixtures do (D-R03-2), and each lifecycle-wire test that starts a host allows 60 seconds. Product bounds stay asserted as they are, such as the 5-second cleanup after an owner disconnects (SPEC-0003-A).
- Timing invariants: a fixture's wait only detects a host that hangs; it does not require a host to start quickly. A test's own timeout is longer than the fixture waits it can spend one after another, so a stall is reported as the step that stalled.

### E: Why a host did not start (Python SDK)

- **E01** When a host that `Orchestrator.local` started ends before it answers `initialize`, the SDK raises the same code as before, `CONNECTION_CLOSED` or `PROTOCOL_ERROR` for a partial frame. The message ends with the host's last error output, and `error.data["stderrTail"]` holds all of it that the transport kept, at most 16 KiB. When the host wrote nothing, the error is unchanged.
- **E02** Closing the connection to an owned host whose process has exited waits at most 1 second for its error output to reach end of file before it stops reading, so the last lines are kept. A live process is terminated first, as before; its error output is never awaited while it runs. Once the host's process has exited, the SDK also closes its ends of the host's pipes, which a process the host left behind could otherwise keep open; a host that still runs is never stopped this way.
- Timing invariants: the added wait starts only after the process exited, lasts at most 1 second and happens once per connection. Socket connections have no host error output and do not change. No wire field, method or error code changes. The TypeScript SDK starts no host of its own, so it does not change.
- **E03** When an owned host's process exits while another process still holds its standard output, pending requests fail at most 1 second later with `CONNECTION_CLOSED`, as when the output ends, and a start error carries the host's error output (E01). Today the transport notices a host's end only by the end of its standard output. A process that the host left behind and that inherited that output keeps it open, so a pending request waits for its timeout, 30 seconds by default, and fails as a timeout. A test found it: a host that exited at once left a process holding its standard output, and the start failed after 30.0 seconds.
  - While an owned host runs, the transport checks every 100 ms whether its process has exited. After an exit, it keeps reading for at most 1 second, so answers written before the exit still arrive, and then fails every pending request and stops reading.
  - Timing invariants: the end of the output is still handled first. The check runs only while an owned process is alive and stops when the connection closes. It adds at most 1.1 seconds between a host's exit and the failure of its requests. Socket connections do not change.

### W: Workflow actions

- **W01** Every action in `.github/workflows` that is not local is named by a full 40-character commit SHA, followed by its version as a comment. A test checks it.
- **W02** The actions are the latest major versions, each running on Node.js 24 according to its `action.yml` at the pinned commit (checked on 2026-09-23): `actions/checkout` v7.0.1, `actions/setup-node` v7.0.0, `actions/setup-python` v7.0.0, `actions/upload-artifact` v7.0.1 and `actions/download-artifact` v8.0.1. `pypa/gh-action-pypi-publish` stays at v1.14.2, a composite action. [manual] The pull request's CI shows no Node.js 20 deprecation annotation, and its release dry run passes. The 0.1.2 release is the first npm publish through setup-node v7 and trusted publishing.

### P: Process identity for the stop proof

With extended Claude options or a writable profile, the adapter's terminal does not cover the whole execution, so the engine releases the dispatch's execution lease automatically only when the host's `observeExecutionStop` returns true (SPEC-0007). The observer receives the task, session, dispatch, generation and native IDs, but no operating-system process. The adapter owns spawning (`spawnClaudeCodeProcess` is reserved), so a host cannot know which processes a dispatch started. In a shared workspace with dispatches running at the same time, a host can only return false, and then every such dispatch waits for the owner, or return true without evidence, which defeats the proof.

- **P01** On macOS and Linux, the Claude adapter starts each Claude Code process as the leader of a new process group. Every descendant that does not create its own session or group stays in that group.
- **P02** The stop context gains an optional, read-only `processes: { pid: number; processGroupId: number }[]`: every process that the adapter started for this dispatch, including those that already exited. An adapter that starts no process, and every adapter on Windows, leaves it out. It is neither stored nor sent on the wire.
- **P03** `@orchvia/adapter-claude` exports `processGroupsStopped(context): boolean`. It returns true only when `processes` lists at least one process and none of the listed groups has a member left; any error other than "no such process group" counts as not stopped. A host calls it in its observer, together with its own checks for remote work.
- **P04** When the adapter must end a Claude process that did not stop by itself, it signals the whole group, first SIGTERM, then SIGKILL when the cleanup window ends, so descendants do not outlive a forced cleanup. Today only the Claude process itself receives SIGTERM.
- **P05** `orchvia host` handles SIGHUP like SIGTERM. Processes in their own group no longer receive the signals that a terminal sends to its foreground group, so closing the terminal must still shut the host and its dispatches down.

Timing invariants:

- The observer is called only after the adapter matched the native terminal, as today.
- The check can err only toward "not stopped". A group exists while any member exists, so its ID cannot be reused while one of our processes remains. A reused ID can only make a group look alive.
- A descendant that leaves the group, for example a daemon that calls `setsid`, is not seen. Hosts that need more add their own checks; the benchmark harness scans the workspace (D-bench-1).
- A host that crashes leaves its dispatches' processes running, as today.

Alternatives considered:

- The adapter checks the group itself and reports it as its own evidence, without a host observer. Host options can add remote execution that the adapter cannot see, so the host stays the authority and gets the check as a tool.
- Following the process tree with `ps` during the turn. A process whose parent exits is re-parented, so the tree loses it; the approach is also platform-specific and racy.

Tests: an offline query whose Claude process starts a grandchild that sleeps. The observer's context lists the Claude process and its group; `processGroupsStopped` is false while the grandchild lives and true after it ends, and false without `processes`. A forced cleanup leaves no member of the group. `orchvia host` shuts down on SIGHUP. Errors of the group check are injected to show they count as not stopped.

Environments: macOS and Linux. Windows is unchanged and stays unverified. The downstream host is told to call `processGroupsStopped` in its observer.

Rollback: `processes` is optional, and `processGroupsStopped` returns false without it, so reverting the adapter change leaves hosts that use it conservative.
