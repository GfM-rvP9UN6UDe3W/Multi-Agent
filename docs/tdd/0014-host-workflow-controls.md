# TDD-0014: Host workflow controls

Date: 2026-09-21. Base: `2ef400e` (SPEC-0013), the branch of pull request #2. Implementation `4baa15b` with test fix `405d8f6`; local verification and remote CI are complete. Nothing has been published.

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
- rc.9 adds real-binary evidence for P02: two more Claude adapters, `claude-read` and a writable `claude-write`, completed and released their leases in the same engine ([TDD-0015](0015-queue-waits.md#native-evidence-for-spec-0014-p02)).

## Remote CI

- The push of `4baa15b` ran [35593314024](https://github.com/masonlee39/Multi-Agent/actions/runs/35593314024): **5/6 jobs passed**. On macOS 14 with Node 24.14.0, `0014-G02 only tasks.resume releases a gated child and restarts its routing wait` failed at its wait after `tasks.resume` (test line 786): the child did not reach `waiting_approval`.
- Reproduction: 24 parallel local runs of that test failed 12 times. The improved wait message showed each child `blocked/SCHEDULING_BLOCKED`, with `enqueuedAt` reset at approval and `deadlineAt` 50 ms later. Instrumentation showed the `tasks.resume` call itself taking 85–384 ms under load, most of it committing the transaction, so the test's 50 ms routing window elapsed before the scheduler could dispatch. The gate and the deadline restart behaved as specified; the test window was shorter than one loaded commit.
- Fix (test only): the approval delay is simulated on the engine clock (10 s of review against a 2 s routing wait) instead of a real 120 ms sleep against 50 ms. The rewritten test passed 24/24 parallel runs, failed as expected when the deadline restart was removed, and the four new test files passed 32/32 parallel runs.
- The push of `405d8f6` ran [35594099807](https://github.com/masonlee39/Multi-Agent/actions/runs/35594099807): **6/6 jobs passed**, including Node 22.18 and 24.14 on Ubuntu and macOS and the real Claude/Codex scripted-gateway jobs with the new read-fence case. This is one sample, not a repeated stability measurement.

## Remaining boundary

Scripted gateways do not show real-model behavior with injected dependency results or revision requests. The Bash sandbox check has not run on Linux. Eight concurrent sessions were exercised with the fake runtime only; memory and CPU on user machines are unmeasured. Handoff and delegation-gate user interfaces belong to the host.

## Review corrections after rc.8

Date: 2026-09-21. Base: `58db94f`, the source of the rc.8 packages. A code review of rc.8 found four defects, now specified as D05, H05, W04 and W05. New tests reproduced each defect before the engine changed. The fixes are not in the rc.8 packages.

### RED

All nine new tests were run against the engine at `58db94f`: `node --test --test-name-pattern "0014-(W04|W05|D05|H05)" tests/engine/host-workflow.test.ts` failed **9/9**. The first eight were written and run before any engine change. The restart-resume test was added later; it was run against the unchanged engine in a separate worktree at `58db94f`.

| Criterion | Test | Failure at `58db94f` |
| --- | --- | --- |
| D05 | the 32 KiB bound counts each encoded block | `ctrl0 block is 196773 bytes`: a 32,768-byte result of control characters was injected whole |
| D05 | the 96 KiB bound counts every block, omission records included | `dependency blocks total 98478 bytes` |
| W04 | a rollover carries runtime rules into the new store and a restart agrees | After the restart the list was `lint/1/config` only; `lint@2` was gone |
| W04 | a backup import restores exactly the backup rules and a restart agrees | Right after the import the list still held `lint/3/runtime`, which the backup does not contain |
| W04 | an import whose rules conflict with the configuration is refused before switching | `Missing expected rejection`: the import committed |
| W04 | a switch finished by a restart carries and checks rules the same way | After a rollover finished during startup, `lint@2` was gone |
| W05 | rule identities containing @ stay distinct across restart | After the restart only `a/b@c/runtime` remained |
| W05 | rules stored under rc.8 keys still load and are never overwritten | Registering `x`/`y@c` overwrote the stored `x@y`/`c` row |
| H05 | handoff context may cite direct dependency results only | `UNAUTHORIZED` (`Context artifact is outside the delegated subtree`) for a direct dependency's artifact |

### Causes and fixes

- **W04:** The engine read registered rules only when it started. After `stores.rollover` or `stores.import` it reopened the store but kept the old in-memory rules. A rollover's new store is empty, so a restart lost the rules. An import copies the backup's rows, but memory kept rules the backup lacks. Now one function, `effectiveRules`, builds the rules from configuration plus the active store, at startup and after every completed switch. A rollover copies the old store's rule rows into the new store in the transaction that stamps the standby metadata; that phase repeats safely after a crash. An import's rules are checked against configuration before its record exists, and again when the standby is prepared.
- **W05:** Rows were keyed `${id}@${version}`, and both fields may contain `@`. Keys are now `JSON.stringify([id, version])`. Identity is read from each row's content, so rc.8 rows need no migration.
- **D05:** The bounds compared the artifact's raw size, but the prompt holds JSON-encoded text, and control characters grow up to six times. Blocks are now measured after encoding. The records of later dependencies are reserved against the total.
- **H05:** Handoff context references were checked against the subtree only, while `work_read` also allows direct dependencies. Both now use one predicate.

### Mutation checks

With all nine tests passing, each part of the fix was removed in turn and the tests rerun. The listed tests failed each time. The sources were then restored byte for byte.

| Removed part | Failing tests |
| --- | --- |
| Import check when the standby is prepared | W04 restart-resume |
| Import check before the record exists | W04 conflicting import |
| Copying rules into the rollover store | W04 rollover, W04 restart-resume |
| Rebuilding the rules after a switch | W04 import |
| Reserving later omission records | D05 total bound |
| The new key, reverted to `id@version` | Both W05 tests |

Removing the H05 predicate is the baseline, which already failed.

### GREEN

- The nine tests pass: 9/9 with the same command.
- Related suites: `node --test tests/engine/host-workflow.test.ts tests/contract/rollover-crashes.test.ts tests/contract/store-rollover.test.ts` passed 55/55. This includes the owner-crash matrix at every rollover phase.
- `npm test` on Node 24.14.0: **496/496**. `npm run test:python` on Python 3.14.6: **54/54**. Local IPC was permitted, and nothing was skipped. Typecheck, the generated-contract check, formatting and `git diff --check` pass.

### Remaining boundary

- Where two rules already collided under rc.8, the overwritten rule's content is lost. It cannot be recovered, and the engine does not detect it.
- The 96 KiB total relies on small records. A task has at most 200 dependencies with engine-generated identifiers, so all records together stay under 50 KiB. This is argued in the code, not enforced.
- Context-reference blocks still check the artifact's raw size, 32 KiB before JSON encoding, so each block can expand the same way. This was found by reading the code and was outside the review; it is not reproduced or changed.
- Only the fake runtime was used for these corrections. They were pushed as `42e2c6f` on the branch of pull request #3, whose CI results are recorded in [TDD-0015](0015-queue-waits.md#remote-ci).
