# SPEC-0007 verification evidence

Historical evidence: [SPEC-0008](../specs/0008-claude-interruption.md) subsequently implements Claude interruption. Counts and unsupported-interruption observations below describe the SPEC-0007 checkpoint.

Date: 2026-09-20. Scope: [host policy injection and durable usage](../specs/0007-host-policy-and-usage.md), implemented only in Multi-Agent. No Axion source/configuration/documentation, credentials, real model calls, external ledger, package publication, commits, or pushes are part of this increment.

## Order and observed RED

The specification and AC-P01–P09 were written before the first tests and production edits. Tests use temporary private directories, deterministic messages, and owned offline child processes. The following are observed failures, not inferred failures:

| Command / stage | Actual result before the corresponding fix |
| --- | --- |
| `node --test tests/contract/host-usage.test.ts` (initial four cases) | 0 passed / 4 failed. Failed Claude result discarded usage; durable usage notifications, exact-record reads, and retained reporting callback were absent. |
| `node --test tests/contract/host-policy.test.ts` (initial nine cases) | 2 passed / 7 failed. Native options/extension were ignored, ownership validation absent, write profile unavailable, false/late host stop observations did not gate release. |
| `node --test tests/contract/codex-policy.test.ts` | 0 passed / 6 failed. Real offline child observed missing policy/search changes; write profile and JSON network/search controls were unsupported, invalid policy was not rejected at construction. |
| Extended `host-usage.test.ts` session-mismatch case | 6 passed / 1 failed. A resumed Claude query accepted a different native session's terminal and published its usage. Initial session identity and acceptance matching now preserve the expected native session. |
| `node --test tests/contract/protocol-schema.test.ts` after adding usage notification payloads | 11 passed / 4 reported failures, including the enclosing test. Missing UsageRecordedData schema and Python `usage_record_id` mapping. |
| `node --test tests/contract/usage-recovery.test.ts tests/contract/protocol-schema.test.ts` | 15 passed / 2 failed. Forwarding example was absent; restart fixture initially reused its own stale socket. The latter was a harness error: remove only the fixture socket after observing its owner exit, not a product change or product RED claim. |
| `node --test --test-name-pattern='ownership overrides and malformed' tests/contract/host-policy.test.ts` | 0 passed / 1 failed. A throwing native-option accessor leaked its error instead of producing a sanitized configuration failure. |
| `node --test --test-name-pattern='suppress the dispatch deadline' tests/contract/host-usage.test.ts` | 0 passed / 1 failed. With timer callbacks delayed and monotonic budget elapsed, a usage event left the task running until the iterator ended. Usage persistence now precedes the existing per-event deadline/state checks; later observations are still retained. |

The initial policy tests that already passed were sandbox rejection (the old adapter rejected all write profiles) and positive main-result completion. They are not claimed as new RED coverage. Late usage, missing token fields, malformed raw JSON, option-container isolation, rejection/cancellation before submission, absent/throwing stop observers, and local-exit separation also received regression coverage without fabricated failure history. The compile fixture was added after the generic API implementation; its positive/negative typecheck is validation, not an independently observed type RED.

An initial schema run failed with local Unix-socket EPERM. It was rerun with IPC permission before recording behavioral failures or GREEN. No skipped IPC test is counted as passed. The deadline test initially assumed an expired iterator should be forcibly ended; it was corrected to assert durable deadline state while retaining late observations, matching A2, before the final RED above.

Local run logs were captured under `/private/tmp/multi-agent-spec0007-*.log`; these are disposable local evidence, not repository artifacts or CI results.

## Implemented behavior and acceptance coverage

| Criteria | Verified path |
| --- | --- |
| P01–P02 | Generic native-shaped hooks/MCP/confirmation/environment compile without `any`; forbidden cwd/resume fail negative compilation. Runtime ownership/malformed options reject before query. Async extension uses original identity/budget, timeout/rejection/abort does not submit, arrays/hook containers do not cross-contaminate dispatches. Private accessor/extension errors are sanitized. |
| P03 | Actual composed guard calls permit workspace files and deny outside/symlink/state/malformed targets and unsafe Bash flags. Write sandbox mapping rejects widening/fallback flags. Host hooks and confirmation callback remain present. |
| P04 | A real offline app-server process reads new/resumed thread/turn policy for both profiles, roots, temporary exclusions, isolated home, and independent network/search options. JSON configuration validation covers supported controls and rejected callbacks/write. |
| P05 | Engine tests observe A held for absent/false/throwing/timed-out host observers; exact positive proof plus local exit permits review. Late positive proof releases A while blocked/Q remain. Positive remote observation cannot replace a still-live local child. Existing Claude unsupported-interruption and Codex interruption/lifecycle suites remain green. |
| P06 | Successful/failed Claude results preserve identical native usage. Cleanup uncertainty and delayed matching terminals retain it; resumed/initialized session mismatch excludes it. Unknown fields remain null. |
| P07 | Callback/yield duplicates persist one row/event. Conflicting content rejects without overwrite. Injected event-write failure rolls back the row. Invalid/cyclic/oversized/non-JSON raw payloads reject, and stored raw data is detached. Late records preserve task/scheduler state. Deadline checks still occur between usage observations. |
| P08 | Parent SIGKILLs only the owned fixture host after persistence, observes actual exit, restarts the same state, then TypeScript and a real Python subprocess resume the saved cursor and retrieve the same record. No new submission occurs. Wrong storeId and missing/invalid record IDs produce stable errors. |
| P08 replay | Standalone forwarding example commits SQLite outbox/checkpoint together, writes to a separate idempotent fixture ledger, loses acknowledgment, reopens stores, resumes/replays events, and produces one ledger row from two attempts. |
| P09 | Updated README, design, wiring guide, Python README, historical adapter-spec supersedence, current spec, schema, and these results. |

`terminalCoversExecution` for extended execution denotes the adapter's combined proof with a configured observer. Matched native terminal evidence alone reports remote execution unknown; the engine additionally requires observed stop and independent local exit. Callback presence is not stop evidence.

## Final GREEN

Environment: Node.js 24.14.0, Python 3.14.6, macOS. No native-runtime version matrix or minimum-version run is claimed.

| Command | Final result |
| --- | --- |
| `npm test` | **321 passed / 0 failed / 0 skipped / 0 cancelled**, 2826.677125 ms. Includes actual subprocess, Unix-socket, Python parity, restart, and negative conformance checks. |
| `npm run test:python` | **44 passed**, 4.597 seconds. |
| `npm run typecheck` | Passed, including generic positive/negative option fixture. |
| `npm run format:check` | Passed. |
| `git diff --check` | Passed. |
| `node examples/typescript/usage-forwarding.ts` | Passed standalone and as a subprocess test. |

Standalone example output:

```json
{"runtime":"fake","replayed":true,"deliveryAttempts":2,"ledgerRows":1,"inputTokens":7}
```

The earlier full run passed 320 Node / 44 Python cases. A final source review added the deadline regression test/fix, then reran both full suites to produce the counts above. Only documentation was completed afterward.

## Unverified boundaries

- These are protocol/guard/engine fixtures, not native Claude/Codex tool execution, platform sandbox enforcement, application UI, packaged Electron behavior, or real-model acceptance. Host native SDK types/options are version-coupled; the repository peer range does not prove all releases support every extension.
- Custom/MCP tool authority and host-shared native objects remain the trusted application's responsibility. Native scratch directories, symlink races, hook precedence, and exhaustive per-request audit need actual host/runtime acceptance.
- JSON CLI remains read-only. Native callbacks and expanded execution need an embedded host. Claude active interruption remains unsupported and explicitly rejected; task acceptance is separate from native tool confirmation.
- Durable replay covers received observations only. Historical rows receive no backfilled notifications. Unreported crash-time usage remains unknown, and aggregate turn usage is not a record for every native model request. The example's destination supports idempotency; no distributed transaction or Work Nexus delivery has been established.
