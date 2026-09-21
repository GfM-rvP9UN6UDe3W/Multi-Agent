# TDD-0014: Host workflow controls

Date: 2026-09-21. Base: `2ef400e` (SPEC-0013), branch `axion-rc8`. Local verification is complete; remote CI has not run yet. Nothing has been published.

## RED

Each group's tests were run against the code before that group's implementation. Commands use `node --test --test-name-pattern "0014-<group>" <file>`; test files are `tests/engine/host-workflow.test.ts`, `tests/contract/host-workflow-adapters.test.ts` and `tests/contract/host-workflow-sdk.test.ts`.

| Group | Result before implementation | Observed reason |
| --- | --- | --- |
| P | 0/2 | The adapters ignored `provider`: the name stayed `claude`, so two adapters failed with `Duplicate provider`. |
| L | 0/2 | `task.created` had no `parentTaskId`/`rootTaskId`; `tasks.list` failed with `METHOD_NOT_FOUND`. |
| R | 0/4 | `approvals.decide` rejected `comment` with `Unknown field: comment`. |
| C | 0/2, plus the schema test | The engine accepted `maxActiveSessions` only through 2; the schema test failed on the new 8/8 limits. |
| D | 0/4 | No dependency block in the downstream prompt (0 of 4 expected); `work_read` of a dependency failed with `UNAUTHORIZED`; message summaries were raw. |
| G | 0/3 | Children were queued and dispatched at once; a tool's session resume hit `Cannot resume an active dispatch`. |
| W | 0/3 | `writePath` failed with `Unknown field`; `rules.register` failed with `METHOD_NOT_FOUND`. |
| F | 0/3 | A read outside the workspace was allowed; invalid read-fence options were accepted; the sandbox did not deny the home directory. |
| H | 0/4 | A reuse of an out-of-subtree session failed with `UNAUTHORIZED` (`Target is outside the delegated subtree`). |
| JSON CLI tools | 0/1 | `Unknown tools field: approveDelegation, handoffs, handoffTtlMs`. |
| X (SDKs) | 0/3 TypeScript, 0/3 Python | The SDK code was written before these tests. RED was observed afterwards by restoring the previous SDK files: `client.tasks.list is not a function`, `'_Tasks' object has no attribute 'list'`, missing `rules`. |

Tests that were wrong and were fixed before counting GREEN: a false pass in G (the switch did not exist, so an ungated child completed normally; the test now asserts the paused state before approval); D02 used identical fake results, which share one content-addressed artifact; an R03 permission fixture changed its native session ID; W fixtures created scope directories after engine start; C02 first configured an eight-slot quarantine floor that correctly refused the ninth task (kept as its own assertion); H04 needed the live store's unfinished task settled before an import; the Python paging test asserted a second page when only one task existed. Two existing tests encoded the old limit of two active sessions and now use nine as the invalid value.

## Defects found while implementing

- A model could release its own gated child by pausing and then resuming the child's idle session, because an idle-session pause rewrote the task reason. Pauses now keep `DELEGATION_APPROVAL_REQUIRED`, and only `tasks.resume` releases it (G02 test).
- A host-supplied `sandbox.filesystem.allowRead` was passed through unchecked. Because `allowRead` takes precedence over `denyRead`, it could re-open the state directory. It is now rejected when it overlaps state (F03 test).
- A probe disproved one draft documentation claim: a pending handoff does not block `stores.import`. The documentation says so.

## GREEN

- All nine groups pass: `tests/engine/host-workflow.test.ts` 23/23, `tests/contract/host-workflow-adapters.test.ts` 5/5, `tests/contract/host-workflow-sdk.test.ts` 3/3 and `python/tests/test_host_workflow.py` 3/3.
- Full Node 24.14.0 suite: **487/487**; Python 3.14.6 suite: **54/54**. Typecheck, formatting, the generated-contract check (68 definitions) and `git diff --check` pass.

## Native evidence

- `node scripts/native-gateway-smoke.mjs claude` (Claude Code 2.1.274, loopback scripted gateway, synthetic credentials, no paid model) passed eight cases, including the new read-fence case: the gateway asked the real binary to `Read` a file in the home directory and one in the workspace. The home read came back as an error with the adapter's denial reason and its content never reached the gateway; the workspace read returned its content ([evidence](0014-native-claude.json)). This case runs in CI.
- `node scripts/native-read-fence-smoke.mjs` ran the writable profile's OS sandbox on macOS (darwin-arm64). Scripted Bash `cat` of a home-directory file and of a `denyRead` path inside the workspace failed with `Operation not permitted`; a workspace file was readable ([evidence](0014-native-read-fence.json)). It needs an available OS sandbox, so it is a local check and not part of CI. A first attempt replaced `process.env` wholesale, which does not change `os.homedir()`; the script now sets environment properties individually.
- The Codex smoke with local codex-cli 0.153.4 still passes its six cases.

## Remaining boundary

Scripted gateways do not show real-model behavior with injected dependency results or revision requests. The Bash sandbox check has not run on Linux. Eight concurrent sessions were exercised with the fake runtime only; memory and CPU on user machines are unmeasured. Handoff and delegation-gate user interfaces belong to the host.
