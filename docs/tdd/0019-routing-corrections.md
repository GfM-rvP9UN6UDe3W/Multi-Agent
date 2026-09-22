# TDD-0019: Routing layer corrections

Date: 2026-09-22. Base: `370085f`, the source of the rc.12 candidate. Branch `routing-corrections`; nothing is merged, packaged or published. Specification: [SPEC-0019](../specs/0019-routing-corrections.md).

## Reproduction before the specification

An external assessment of `370085f` reproduced four defects in the SPEC-0018 routing layer. It used probe scripts kept outside the repository, with a real engine, fake runtimes and a local HTTP stand-in for Jev:

- F01: a judge answered `confidence: 0.2` with `A1: 0.95, fresh: 0.05`. The proposal reported `confidence: 0.95` and `needsConfirmation: false`.
- F02: a finding from a root-A session with `rootTaskId` set to root B produced a B recipient, and `notify` wrote the message to B's task.
- F03: a fresh proposal carried a 32,769-byte result without asking for confirmation, and `submit` failed with `ARTIFACT_TOO_LARGE`.
- F04: a Python `JevJudge` with `timeout_ms=100`, against a body sent a few bytes every 25 ms, returned a successful answer after 267 ms.

The tests below turn each finding into assertions. While checking the TypeScript side of F04, two more defects were found: the retry pause ignored the deadline, and a caller's abort during the body read was reported as a protocol error.

## RED

Tests: `tests/engine/routing-corrections.test.ts` and `python/tests/test_routing_corrections.py`. The final versions of both files were run against a clean copy of `370085f`, extracted with `git archive` so that the repository was not touched:

- `node --test tests/engine/routing-corrections.test.ts`: 9 of 12 failed.
- `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=python/src python3 -B -m unittest discover -s python/tests -p test_routing_corrections.py -v`: 9 of 11 failed.

Every failure is a failed assertion on observable behavior. None of them comes from a missing module, a permission error or the test code itself.

| Test | Failure at `370085f` |
| --- | --- |
| 0019-C01 a low judge confidence requires confirmation although its choice is probable | `needsConfirmation` was `false` |
| 0019-C01 dropping read-only candidates never raises the confidence of what remains | `needsConfirmation` was `false` for an agent the judge gave 0.45 |
| 0019-C01 the confirmation threshold applies to every branch that asked for a best agent | `needsConfirmation` was `false` with a judge confidence of 0.849 |
| 0019-C02 notifications stay in the source root and refuse another group before the judge | No rejection for a `rootTaskId` of another root |
| 0019-C02 engine scope still notifies members of other roots and needs a member source | Delivery across roots passed; no rejection for a source outside the members |
| 0019-C03 results over the 32 KiB inline limit are left out with a reason and the rest submit | The 32,769-byte results were carried |
| 0019-C03 a busy agent whose own result is too large still yields a submittable fresh plan | The busy agent's 40,000-byte result was carried |
| 0019-C04 the Jev judge waits for its retry only while its deadline lasts | A 50 ms deadline ended after 215 ms |
| 0019-C04 a caller abort while the Jev body arrives surfaces as that abort | `JudgeError: Jev returned a body that is not JSON` |
| Python C01 confirmation uses the judge confidence | `needs_confirmation` was `False` |
| Python C02 notifications stay in the source group | No exception for a `root_task_id` of another root |
| Python C02 engine scope notifies other roots | Delivery passed; no exception for a source outside the members |
| Python C03 oversized results are left out | The 32,769-byte results were carried |
| Python C04 slow body cannot extend the deadline | A successful answer instead of `JUDGE_TIMEOUT` |
| Python C04 slow headers cannot extend the deadline | A successful answer instead of `JUDGE_TIMEOUT` |
| Python C04 the retry shares the deadline | A successful answer instead of `JUDGE_TIMEOUT` |
| Python C04 cancellation stops the request | The request kept reading after the cancellation; the server saw no disconnect within 1 s |
| Python C04 the request stops at its deadline while the loop is busy | The request was still reading 0.6 s after a 100 ms deadline |

Passing at `370085f` and kept as regression coverage:

- TypeScript: a result damaged on disk after routing fails the submission with `ARTIFACT_CORRUPT`; a result collected after routing fails it with `ARTIFACT_HISTORY_EXPIRED`; the Jev deadline covers slow headers and a slow body.
- Python: late response headers time out; a slow answer within the deadline succeeds.

How the test files were corrected before the final RED:

- The TypeScript judge helper first answered unscripted relevance questions with the `writes` default of 0.9. One branch of the threshold test then expected `NO_RELEVANT_AGENT` and failed during GREEN. The helper now answers 0.1, like the Python one.
- The collection test first ran three GC passes. Under parallel load a 50 ms batch did not always reach the artifact, and six of eight loaded runs failed. It now repeats passes until two in a row collect nothing.
- The busy-loop test was added after mutation P9 below survived.

## Implementation

TypeScript, `packages/sdk-typescript/src/routing.ts`:

- **C01:** the ranking keeps `judgeProbability` next to the share among eligible options. `confidence` is the lower of the judge's `best.confidence` and the decision's own figure, and `LOW_CONFIDENCE` compares it. The proposal adds `judgeConfidence` and per-alternative `judgeProbability`. `NARROW_MARGIN` still compares shares.
- **C02:** `notifications` checks that the source is a member, derives the source's root as the engine does, and refuses a different `rootTaskId`, all before the judge. It throws the new `RoutingError`.
- **C03:** `resultOf` measures the snapshot result with `TextEncoder`. `carry` walks candidates in priority order and skips results over `MAX_CONTEXT_REF_BYTES` (32,768) with one `CONTEXT_OMITTED` reason each; skipped results take no place. All four carrying paths use `carry`.
- **C04:** the retry pause waits on the combined signal, so it ends with the deadline or the caller's abort. A body read that ends because the caller aborted rethrows that abort.

Python, `python/src/agent_orch/routing.py`:

- **C01–C03:** the same rules. UTF-8 bytes are counted with `surrogatepass`, which counts a lone surrogate as three bytes, as the engine's replacement character does. `RouteProposal` gains `judge_confidence`, alternatives gain `judge_probability`, and `RoutingError` is added.
- **C04:** `_Exchange` runs one request on a daemon thread. It uses urllib connection classes that register their socket and check the deadline before connecting. The body is read with `read1`, with the socket timeout set to the time left before each read. `JevJudge._post` waits on a future with `asyncio.wait` until the deadline. At the deadline or on cancellation it cancels the future and calls `abort`, which shuts the socket down. The thread delivers its outcome with `call_soon_threadsafe` only if the future is still pending. A refusal's body is not read, and `http.client.HTTPException` counts as a network failure.

## GREEN

- `node --test tests/engine/routing-corrections.test.ts tests/engine/routing-layer.test.ts`: 24 of 24 passed.
- `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=python/src python3 -B -m unittest discover -s python/tests -p 'test_routing*.py' -v`: 17 of 17 passed.
- `python3 -X dev` on the Python deadline tests reported no `ResourceWarning`, no unretrieved future and no ignored exception.

## Mutation checks

With all tests passing, each part of a fix was undone in turn and only the matching focused tests were run:

| Mutation | Result |
| --- | --- |
| T1 `confidence` ignores the judge's confidence | caught |
| T2 the renormalized share is checked | caught |
| T3 oversized results are carried | caught |
| T4 characters are counted instead of bytes | caught |
| T5 a result left out takes a place | caught |
| T6 a declared `rootTaskId` is trusted | caught |
| T7 source membership is not checked | caught |
| T8 the retry pause ignores the deadline | caught |
| T9 a caller's abort during the body is read as a protocol error | caught |
| P1–P8, the Python counterparts of T1–T7, plus: the abandoned request is not aborted; the wait has no deadline | caught |
| P9 the thread keeps no deadline of its own between body reads | caught |

P9 first survived, in a weaker form that still set a 1 ms socket timeout. The coroutine's abort already stops a slow body, so the thread's own deadline mattered only while the event loop could not act. The test "the request stops at its deadline while the loop is busy" now covers that case, and P9 removes the thread's whole deadline.

## Load

- Eight Python and eight TypeScript runs of both new files in parallel: 0 failures after the collection-test correction. Before it, six TypeScript runs failed only the collection test.
- Twelve Python and twelve TypeScript runs in parallel: 0 failures.
- Eight parallel runs each of the TypeScript and Python deadline tests: 0 failures.

## Full checks

The owner's commands, run from the branch:

- `npm test`: 549 passed, 0 failed, 0 cancelled, 0 skipped.
- `PYTHONDONTWRITEBYTECODE=1 npm run test:python`: 76 passed, none skipped.
- `npm run typecheck`, `npm run format:check` and `git diff --check`: passed. The new, untracked files were checked separately for trailing whitespace, tabs and CR characters.
- `npm run check:generated`: passed; 5 generated files, 68 definitions, the schema unchanged.

Loopback HTTP and the Unix socket were permitted in this environment; no test was skipped for permissions.

## A pre-existing CI flake fixed on this branch

The first push run of this branch, CI run 35749328231 on `c462405`, failed one job, contracts on Ubuntu with Node 24.14.0. The only failing test was `AC-F07 runtime permission expire is distinct from result acceptance` in `tests/engine/runtime-approval.test.ts`: it expected an approval with purpose `runtime_permission` and read `task_acceptance`. Rerunning that job passed, and the pull-request run of the same commit passed 7 of 7. The owner chose to fix the test on this branch.

- Cause: the test set an 80 ms real-time lifetime for the permission and polled every 5 ms for it. When the first read came later than 80 ms, the permission had already expired and the task was waiting for result acceptance.
- RED, reproduced with two CPU-bound processes per core and `node --test --test-name-pattern "AC-F07 runtime permission expire" tests/engine/runtime-approval.test.ts`, 24 runs in parallel at a time:
  - 16 of 120 runs failed at `370085f`, where this test and the engine are byte-identical to this branch;
  - 6 of 120 runs failed on this branch before the fix.
  - Every failure showed the CI symptom, or the next assertion of the same race: the permission already reported as denied.
- Fix, in the test only:
  - The engine schedules the permission expiry through its clock seam. The test now passes an `EngineClock` that runs every timer on real time except the permission expiry, recognized by its unique lifetime of 61,234 ms. That one is held until the test fires it, after it has observed the pending permission.
  - The approve, deny and cancel variants never fire it, so no expiry can race their decisions either.
  - The wait bound grew from 2 to 10 seconds. It only matters on a slow machine; every wait still ends as soon as its state appears.
- Timing invariant: the test observes the pending permission strictly before it expires, on any machine.
- GREEN under the same load: 0 of 240 runs of the expire variant and 0 of 48 runs of the whole file failed.
- Mutation: without firing the held expiry, the expire variant fails; the permission is never answered (`granted` stays `undefined`, not `false`).

## Parity

| Rule | TypeScript | Python |
| --- | --- | --- |
| Judge confidence and raw probability decide `LOW_CONFIDENCE` | `judgeConfidence`, `judgeProbability` | `judge_confidence`, `judge_probability` |
| Group checks before the judge | `RoutingError` with `ROUTING_SOURCE_NOT_MEMBER` or `ROUTING_ROOT_MISMATCH` | the same class and codes |
| Oversized results left out | `CONTEXT_OMITTED` `{sessionId, artifactRef, reason, bytes?, maxBytes}` | the same, snake_case keys |
| One deadline per evaluation | `AbortSignal` covers fetch, body and retry pause | daemon thread, deadline wait, socket shutdown |

## Not verified

- No live Jev call and no real network: HTTPS to a real server and requests through a proxy were not exercised. A TLS handshake against a local plain server failed cleanly as `JUDGE_UNAVAILABLE`.
- A name lookup that hangs cannot be interrupted in Python; that case was reasoned about, not tested.
- Before submitting, the router cannot see whether a result was collected or damaged. That needs a new read-only engine query, which this change does not add.
- The rc.12 package and every earlier candidate are unchanged and still contain the defects.
