# TDD-0023: Corrections before 0.1.2

Date: 2026-09-23. Base: the last tree of the branch `one-version`, which sits on `community-12-13-14`. Specification: [SPEC-0023](../specs/0023-corrections-before-0.1.2.md). The owner approved the designs of E03 and P on 2026-09-23 (D-known-6 = 1, D-known-7 = 1), and those of S and F03 on 2026-09-24 (D-known-9 = 1, D-known-10 = 1), before any of their code was written.

## F: Stdio fixture waits

### RED

The CI failure itself cannot be replayed: GitHub serves the logs of the failed first run of the rc.10 pull request only to signed-in users. A test-only preload, used for the reproduction and not committed, delayed the start of every `orchvia host` by 6 seconds, as a loaded runner can. `node --test tests/contract/lifecycle-wire.test.ts` then failed all five tests that start a host after 5.01 to 5.04 seconds: four with `No stdio response for initialize` and the socket test with `Timed out waiting for wire state: ""`. Without the delay they pass in about 0.3 seconds each. On this machine a host answers `initialize` 90 ms after it starts, and 0.9 seconds with 54 starting at once.

### Changes

`tests/contract/lifecycle-wire.test.ts` waits 10 seconds for each response and for a socket host to listen, and the five tests allow 60 seconds. The owner-EOF tests still require the host to exit within 5 seconds of the disconnect (SPEC-0003-A).

### GREEN

- With the host start delayed by 6 seconds: 5 of 5 passed. Delayed by 11 seconds: all five failed with the fixture's own messages, so a host that stalls is still reported at the step that stalled.
- Twelve runs of the file at once, next to 18 busy loops on 18 cores: 12 of 12 passed; the slowest took 4.3 seconds.

## F02: Claude deadline tests

### RED

The push CI run of `one-version` ([35886905684](https://github.com/masonlee39/orchvia/actions/runs/35886905684)) failed `Claude cleanup timeout stays bounded and adapter.close rejects unconfirmed resource` on macOS 14 with Node 22: `'failed' !== 'unknown'`. The test allowed the request 20 ms, which also covers the adapter's preparation before it submits, and on that runner the preparation took longer, so the adapter reported a timeout before submission. The branch did not change this file; the test had been timing-sensitive before. Thirty-six busy loops next to 24 runs did not reproduce it on this machine. A test-only preload that made every `realpathSync` 30 ms slower did: 10 of the file's 16 tests failed, 8 of them with `'failed'` where `'unknown'` was expected. The four other test files with small deadlines passed with the same preload.

### Changes

`tests/contract/claude-deadlines.test.ts` adds `PREPARE_MS = 500` to the twelve deadlines, in ten tests, that must outlast the preparation, and `within` allows 2.5 seconds instead of 300 ms. The tests of pre-submission outcomes, the one driven by an injected execution budget and the validation of deadline values are unchanged.

### GREEN

- 16 of 16 without a delay, with `realpathSync` 30 ms slower, and with it 100 ms slower.
- Ten runs at once next to 18 busy loops: 10 of 10.
- The file takes 6.2 seconds instead of 1.7.

## F03: The half-budget close test

### RED

The push CI run of `release-0.1.2` ([35890483232](https://github.com/masonlee39/orchvia/actions/runs/35890483232)) failed `0022-C02 the close waits at most half of its timeoutMs` on macOS 14 with Node 22: `closed after 1225.98 ms`, where the test required less than 1,000 ms for a 1-second budget. The branch differs from `known-issues` only in its version. The test timed the whole `close()`, but the engine starts its deadline after it has written the shutdown receipt, and after the wait it writes the final receipt and closes the database, synchronously and without a bound, as TDD-0011 found for 0011-R03. Load alone did not reproduce it: ten runs of the old file at once, next to four busy loops on this machine's four cores, passed 10 of 10. A new test that makes every SQLite database close 600 ms slower during the call failed at once with the old measurement: `closed after 1716.08 ms`.

### Changes

`tests/contract/claude-close-interrupt.test.ts` records when the engine starts to close the Claude adapter, by wrapping the adapter's `close`. The half-budget test requires that moment, not the end of `close()`, to come at least 490 ms and less than 1 second after the call. The new test, `0022-C02 a slow database close does not count against the half-budget wait`, checks that the slowed close took at least 1.1 seconds and requires the same wait. SPEC-0022 C03 now says that the budget bounds the wait, not the whole close.

### GREEN

- 5 of 5 in the file; the slowed close took about 1.7 seconds and the wait still ended in time.
- Ten runs at once next to four busy loops on four cores: 10 of 10.

### Mutation checks

| Mutation | Result |
| --- | --- |
| The engine waits the whole budget instead of half | caught by both tests: the close runs out of its budget and reports `SHUTDOWN_INCOMPLETE` |
| The database close is not slowed | caught by the check that the close took at least 1.1 seconds |

A wait between half and the whole budget still passes: the upper bound leaves the rest of the budget for the receipt before the wait and for timers on a loaded runner (SPEC-0023 F03).

## E: Why a host did not start

### RED

`python3 -m unittest python/tests/test_host_start_errors.py` failed 4 of 5 before the change:

- `test_0023_e01_the_host_error_output_ends_the_message`: the message was only `Engine connection ended before the next complete response`.
- `test_0023_e01_a_real_host_with_an_invalid_configuration`: `'INVALID_CONFIG' not found in 'Engine connection ended before the next complete response'`, although the host printed `{"code":"INVALID_CONFIG","message":"Configure at least one provider explicitly; fake is never enabled by default"}`.
- The two E02 tests stopped with `KeyError: 'stderrTail'`.
- `test_0023_e01_a_host_without_error_output_keeps_the_error` passed; it guards the unchanged case.

The first version of the test for an error output held open by a leftover process took 30.0 seconds: that process had also inherited the host's standard output, so the start waited for the request timeout. That is a separate defect, E03 below; this test now leaves only the error output open.

### Changes

- `python/src/orchvia/transport.py`: after an owned host's process exited, closing the connection waits at most 1 second for the reader of its error output to finish.
- `python/src/orchvia/client.py`: a start that fails with `CONNECTION_CLOSED` or `PROTOCOL_ERROR` on an owned host appends the host's last error output, at most 2,000 characters, to the message and puts all of it that the transport kept into `error.data["stderrTail"]`.

### GREEN

- `python/tests/test_host_start_errors.py`: 6 of 6, in about 1.2 seconds; the test with an error output held open finishes about 1 second after the host exits.
- The test in which a leftover process writes its line 0.3 seconds after the host exits was added after its mutation below went unnoticed by the first five tests. Without the wait it failed five times out of five, with only the first line kept; with the wait it passed three times out of three.

### Mutation checks

| Mutation | Result |
| --- | --- |
| No wait for the error output after the exit | caught, 5 of 5 runs (the late line) |
| An unbounded wait for the error output | caught (the error output held open) |
| The output only in `data`, not in the message | caught (two E01 tests) |
| An empty output still appended | caught (the unchanged case) |

## E03: A host that exits while its output stays open

### RED

`python3 -m unittest -k e03 python/tests/test_host_start_errors.py` failed both tests after 30.0 seconds, the request timeout: a start whose host exits at once, and a request pending when the host exits after it answered `initialize`. In both, a process that the host left behind held its standard output.

### Changes

`python/src/orchvia/transport.py`: while an owned host runs, a task checks every 100 ms whether its process has exited. After an exit it waits at most 1 second for the reader, so answers written before the exit still arrive; if the output has not ended by then, it fails every pending request with `CONNECTION_CLOSED` (`Engine process exited`) and stops reading. Closing the connection stops the task.

### A leak found on the way

With these tests the SDK printed `ResourceWarning: unclosed transport`: after a failed start, its ends of the pipes that the leftover process held stayed open until garbage collection. A test that compares `/dev/fd` before and after the start found two descriptors left, `8` and `10`. Once the host's process has exited, closing the connection now closes the subprocess transport. It is never closed while the host runs, because that would kill it; `test_0023_e02_disconnect_leaves_a_host_that_still_runs_to_finish` covers that already-correct behavior. The descriptor test then passed, and the warnings were gone.

### GREEN

- `python/tests/test_host_start_errors.py`: 10 of 10 in about 9 seconds, three runs in a row.
- The leftover processes of these tests sleep 10 seconds, longer than every bound under test.

### Mutation checks

| Mutation | Result |
| --- | --- |
| No exit check | caught (both E03 tests took 10 seconds) |
| The transport closed while the host still runs | caught (the host was stopped before it finished) |

The 1-second allowance for answers written just before an exit has no test of its own: the reader has read such an answer long before the next 100 ms check.

## W: Workflow actions

### RED

Every job of the CI run on `main` at `5d95079` carried the annotation `Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/checkout@v4, actions/setup-node@v4, actions/setup-python@v5, actions/upload-artifact@v4`. `node --test tests/contract/workflows.test.ts` failed with 21 problems: eight actions in `offline.yml` named by movable tags such as `actions/checkout@v4`, and 13 pinned actions in `release.yml` older than the first major version that runs on Node.js 24.

### Changes

Both workflows name `actions/checkout` v7.0.1, `actions/setup-node` v7.0.0, `actions/setup-python` v7.0.0, `actions/upload-artifact` v7.0.1 and `actions/download-artifact` v8.0.1 by their commits. Each commit's `action.yml` says `node24`, and each of the 31 inputs that the workflows pass exists in it. setup-node v7 no longer exports a placeholder `NODE_AUTH_TOKEN`; `npm view` of a public package worked with a placeholder token, with an unset one and without one, so the npm job's check for published versions is not affected.

### GREEN

`node --test tests/contract/workflows.test.ts`: 1 of 1. W02 is checked on the pull request's CI: no deprecation annotation, and the release dry run passes.

### Mutation checks

| Mutation | Result |
| --- | --- |
| An action named by a movable tag again | caught |
| download-artifact pinned at v6, which runs on Node.js 20 | caught |
| A pinned action without its version comment | caught |
| A shortened commit | caught |

## P: Process identity for the stop proof

### RED

`node --test tests/contract/claude-process-groups.test.ts` failed 5 of 5 against a stub of `processGroupsStopped` that always returned false, with the optional `processes` field declared but never filled:

- `0023-P01 0023-P02`: the observer's context had no `processes`, and the grandchild of the Claude stand-in shared the test runner's process group.
- `0023-P03`, with real processes: the check stayed false after the grandchild ended. With an injected error, `ESRCH` did not count as stopped.
- `0023-P04`: a Claude stand-in and its grandchild that ignore SIGTERM were both alive 3 seconds after a cleanup with a 300 ms window.
- `0023-P05`: `orchvia host` died of the signal (`{ code: null, signal: 'SIGHUP' }`) instead of shutting down.

### Changes

- `packages/adapter-claude/src/index.ts`: on macOS and Linux each Claude Code process is spawned `detached`, so it leads a new process group. The observer's context lists `processes: [{ pid, processGroupId }]`. A forced cleanup signals the group with SIGTERM and, when the cleanup window ends, SIGKILLs what is left of it.
- `packages/adapter-claude/src/process-groups.ts`: `processGroupsStopped`, and the group signals. SIGKILL goes only to a group that still has a member, whose ID cannot have been reused.
- `packages/engine/src/types.ts` and `stop-observation.ts`: the optional, frozen `processes` of `RuntimeStopContext`.
- `packages/cli/src/main.ts`: `orchvia host` handles SIGHUP as it handles SIGTERM.
- The guide's paragraph on `observeExecutionStop`, with an example, and the changelog.

### GREEN

`node --test tests/contract/claude-process-groups.test.ts`: 5 of 5.

### Mutation checks

| Mutation | Result |
| --- | --- |
| The Claude process does not lead its own group | caught |
| The context lists no processes | caught |
| An EPERM from the check counts as stopped | caught |
| No SIGKILL when the cleanup window ends | caught |
| The host has no SIGHUP handler | caught |

Checking the group before its SIGKILL guards against a reused group ID, which no test can bring about.

### A regression that CI found

The push CI run of `known-issues` failed `0003-A05 retained adapter cleanup blocks attestation after the observation loop ends` on macOS 14 with Node 24: `Missing expected rejection`, where `RUNTIME_STILL_ACTIVE` was expected. P04 caused it. The test keeps a process that ignores SIGTERM alive after a forced cleanup, and P04 now SIGKILLs that process's group when the cleanup window ends; once the kill landed, the owner's attestation was no longer refused. Run alone, the test passed 7 of 20 times with P04 and 20 of 20 without it; the full local suite had passed by chance. Logging every group SIGKILL across the test files of the Claude adapter found three more tests that rely on a process outliving its cleanup: `AC-R04 all observed child processes must exit before cleanup is confirmed`, `AC-R04 a live Claude child blocks owner release and queued dispatch until late exit`, which failed 3 of 20 runs, and `A2 Claude keeps a late matching terminal as resource evidence without reviving the business result`.

These tests describe a process that the adapter cannot end. With P04 that happens only when signalling its group fails, so a new fixture, `refuseGroupSignals(t)`, makes every group signal fail with EPERM until the test ends. The four tests use it, and P04's own tests cover a group that is ended. Each of the three files then passed 30 of 30 runs, and 10 of 10 next to 18 busy loops.

## S: Stop signals while a socket host starts

### RED

The push CI run of `known-issues` ([35890482938](https://github.com/masonlee39/orchvia/actions/runs/35890482938)) failed `0023-P05 orchvia host shuts down in order on SIGHUP` on Ubuntu with Node 24: the host wrote `orchvia listening on ...` and then died of the signal, `{ code: null, signal: 'SIGHUP' }`. `packages/cli/src/main.ts` wrote that line and only then registered its signal handlers, and `startUnixHost` accepted connections before it returned, while it set the socket's permissions.

`node --test tests/contract/host-signals.test.ts` failed 4 of 4 against that code, each in about 0.2 seconds:

- `0023-S01 0023-S02`, with a preload that stalls the host for 300 ms right after its ready line: SIGHUP, SIGTERM and SIGINT each killed the host, `{ code: null, signal: 'SIGHUP' }` and likewise for the other two.
- `0023-S03`, with a preload that stalls the host's startup for 300 ms once its socket accepts connections: SIGTERM killed it, `{ code: null, signal: 'SIGTERM' }`.

### Changes

- `packages/cli/src/main.ts`: `hostSignals()` registers the SIGTERM, SIGINT and SIGHUP handlers as soon as the engine has opened its state, before the socket exists. A signal that arrives before the host has started is kept; `attach` gives the handlers the host's close and runs it at once when a signal is waiting. The ready line is written after `attach`, and not at all when a signal is waiting. The stdio host registers the same way, before it reads any input.
- `tests/fixtures/stall-after-ready.ts` and `tests/fixtures/stall-before-ready.ts`: the two test-only preloads.
- The guide says from when the host handles the signals, and the reference lists SIGHUP with the others.

### GREEN

- `node --test tests/contract/host-signals.test.ts`: 4 of 4. With `tests/contract/cli-shutdown.test.ts` and `tests/contract/claude-process-groups.test.ts`: 25 of 25.
- Ten runs of the new file at once next to four busy loops on four cores: 10 of 10.

### Mutation checks

| Mutation | Result |
| --- | --- |
| The handlers are registered after the ready line, as before | caught by all four tests |
| The handlers are registered once the host has started, before the ready line (moving only the line) | caught by `0023-S03`; the three `0023-S01` tests pass |
| A signal that arrives while the host starts is dropped | caught by `0023-S03`, after its 30-second watchdog |
| The ready line is written although a signal is waiting | caught by `0023-S03` |

## Not verified

- W02 until the pull request's CI runs, and the npm publish through setup-node v7 until the 0.1.2 release.
- F on GitHub's runners: the reproduction delays the host start on this machine.
- P with a real Claude Code process and on Linux: the tests use a stand-in process on macOS; CI runs them on Linux too. A descendant that leaves its group, such as a daemon, stays invisible to the check, as the specification states.
- P on Windows, where the adapter does not create groups and leaves `processes` out.
- S and F03 on GitHub's runners until their next CI run: here the preloads and the slowed database close stand in for a loaded runner. S on Windows, where the socket host does not run.
