# TDD-0018: Optional routing layer

Date: 2026-09-22. Base: `4ba551c` (rc.11). Nothing has been published.

## Before the specification

Offline trials with TypeSafe's Jev (`jev-1.13.0`) used synthetic requests and agents; no product data was sent.

- **Interruptions.** Seven messages typed while an agent worked, five of them in Chinese, were each classified as one of: amend the running task, answer the agent's question, ask for status, stop, or start separate work. All seven were right with high confidence.
- **Writes and size.** Six new requests were judged on whether they need file changes and on how large they are. The six write judgments pointed the right way; one size judgment was uncertain.
- **A four-agent team.** 33 routing judgments came back in one call in 0.79 seconds, for about $0.0001. The clear cases were right. An ambiguous request, and a choice between a busy writable agent and a read-only reviewer, came back uncertain, which is why the policy combines per-agent relevance with deterministic filters.
- **Claims.** Checking seven claims against SPEC-0017 caught two planted contradictions and one unsupported claim. It also judged one planted error, monotonic instead of wall-clock time, as supported, although only at review confidence. The router therefore only proposes.

## RED

Tests: `tests/engine/routing-layer.test.ts` (12 tests) and `python/tests/test_routing.py` (6 tests). Both failed at `4ba551c` before any implementation, because the modules did not exist:

- The engine test file stopped with `ERR_MODULE_NOT_FOUND` for `packages/sdk-typescript/src/routing.ts`.
- The Python file failed with `ModuleNotFoundError: No module named 'agent_orch.routing'`.

The first implementation run passed 11 of 12 engine tests. The failure was in the test: its scripted judge matched the keyword `refund` in two agents' descriptions, so a second agent's result was carried. The payments agent's keyword became `rounding`, which only it contains. The first Python run passed 5 of 6. That test had submitted a proposal that reused the auth agent before routing an unrelated request, which changed that agent's latest task. The submission moved to the end of the test. Both fixes changed tests only.

## Implementation

- `packages/sdk-typescript/src/routing.ts`, exported as `@agent-orch/sdk/routing`, and `python/src/agent_orch/routing.py`, standard library only, implement the same contract.
- They share the judge interface, the Jev adapter, the candidate filter, the question ids and state shape, the policy table, the reasons and the notifications.
- Each route makes at most one judge call; a route with no question makes none.
- A reused agent keeps its provider, model, write scope and write path.
- A fresh proposal leaves the queue wait to the host default.
- The engine, the wire protocol and storage are unchanged.
- `scripts/package-smoke.mjs` now imports `@agent-orch/sdk/routing` from the installed package and routes a follow-up to the packaged task's session.
- `tests/fixtures/routing-host.ts` is the stdio host for the Python tests, with read-only and writable fake providers and an optional `allowCrossRootReuse`.

## Mutation checks

With all tests passing, each part was removed in turn:

| Removed part | Failing tests |
| --- | --- |
| The root-scope filter (TS, Python) | R02 root scope; Python findings |
| Removing read-only candidates when writes are needed (TS, Python) | R03; Python policy table |
| Parallel work when a busy agent neither clashes nor is essential (TS, Python) | R03; Python policy table |
| No fallback when the dependence is essential | R03 |
| The relevance threshold for carried results | R04 |
| Most relevant results first | R04 |
| Low confidence requiring confirmation | R05 |
| Falling back when the judge fails (TS, Python) | R06; Python judges |
| Excluding the finding's source (TS, Python) | R07; Python findings |
| Reporting ended agents as follow-ups instead of confirmations | R07 |
| No retry on client errors (TS, Python) | R08; Python Jev errors |
| One retry on overload | R08 |
| Mapping Jev's noul answer | R08 |
| Keeping a reused agent's write scope | R02 root scope |
| Keeping a reused agent's model | R02 root scope |

All 21 were caught: 15 in TypeScript and 6 in Python. In the first pass the Python judge-failure mutation was reported as missed. Rerun alone, and in a pass with bytecode caching disabled and the cache cleared before each mutation, it was caught. The miss is attributed to stale bytecode between rapid rewrites of the same file. The sources were restored byte for byte.

## GREEN

- The 12 engine tests and 6 Python tests pass.
- Parallel runs: the engine file passed 24 of 24 runs, eight at a time. The Python file passed 8 of 8, all at once.
- Packages: scratch archives of version `0.1.0-rc.99`, in the session scratchpad only, passed all nine package modes. The SDK tarball exports `./routing`, and the wheel contains `agent_orch/routing.py`.
- `npm test` on Node 24.14.0: **537/537**. `npm run test:python` on Python 3.14.6: **65/65**. Local IPC was permitted, and nothing was skipped. Typecheck, formatting, the generated-contract check (68 definitions, schema unchanged) and `git diff --check` pass.

## Remaining boundary

- No live Jev call is part of the tests. The adapter follows TypeSafe's documented `POST /v1/systemone` contract, verified against a local HTTP fake. A labelled live evaluation, run by the owner with their own `JEV_API_KEY`, is a follow-up and does not exist yet.
- The default thresholds come from small synthetic trials, not product traffic.
- The default description reflects an agent's latest task. Hosts should pass `describe` with a stable role.
- The engine does not report `allowCrossRootReuse`, so `scope: 'engine'` relies on the host's declaration. A wrong declaration surfaces as `HISTORY_REUSE_FORBIDDEN` on submit.
