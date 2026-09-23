# SPEC-0006 TDD evidence

Date: 2026-09-20. Base commit: `4aa2b44`. Scope: [host runtime contract and offline conformance](../specs/0006-host-runtime-contract.md). Implementation and the offline verification below are complete.

## Order and observed RED

1. Updated the design document (now `docs/design.md`) sections 7.3–7.6 and the integration guide before creating the specification. The design distinguishes the generic contract/offline slice from the later concrete host bridge, durable journal/projection, packaging, and capacity work.
2. Wrote SPEC-0006 with AC-H01–AC-H09 before implementation.
3. Added capability behavior tests and a negative TypeScript fixture, then ran RED before changing engine code.

`node --test tests/contract/runtime-capabilities.test.ts`: **31 failed, 0 passed, 0 skipped** in the initial suite. The failures included accepted malformed declarations, raw/mutable capability snapshots, and a second host submission after a queued task's read-only capability had been removed (`2 !== 1`). Missing/old budget rejection already existed; those cases failed the added capability-query validation assertion, not the existing admission check. This does not claim every admission failure is newly implemented.

`npm run typecheck`: failed with three `TS2578` unused `@ts-expect-error` directives. Missing required budget, old budget version, and string evidence coverage were all accepted by the original broad JSON extension type. A test-only annotation issue was fixed before recording this isolated type RED; no implementation had changed.

`node --test tests/contract/runtime-input.test.ts`: **2 failed, 0 passed, 0 skipped** because the new preflight API was absent (`undefined` rather than `function`). This is an API-absence RED, not a reproduced malformed-input side effect. The subsequent tests exercise preservation/rejection of actual values.

## Implementation and regression boundary

- Added named budget/evidence capabilities and required engine-input narrowing without removing standalone provider input compatibility.
- Added capability snapshots and validation, reused at admission, capability inspection, and dispatch. Queued work is rechecked and each dispatch uses one validated snapshot for its budget/coverage decisions. Invalid queued contracts pause that task instead of invoking the host or stopping unrelated scheduling.
- Added an optional reusable Node conformance suite and a controlled offline host. It retains background resources after iterator completion and follows the original remaining budget. Neither module is imported by normal engine startup.
- Added a runnable TypeScript example, a real owned host-process crash/restart test, and a real Python socket client reading the recovered state. Added a deliberately incorrect bridge in a subprocess to prove the suite rejects main-turn/full-stop conflation.
- Existing A2 unknown-outcome, late-stop, reconciliation, and result-acceptance behavior received regression coverage; no new RED history is claimed for those already-correct engine semantics. Two existing negative fixtures now use explicit casts to represent untyped legacy capability declarations rejected by the stronger TypeScript type.

While constructing the test harness, corrected macOS canonical temporary paths, the existing nested `approvals.decide.decision` wire shape, and an incorrect assumption that engine deadline expiry aborts the adapter signal. The host fixture enforces the shared remaining budget itself; engine timeout persistence and adapter observation/cleanup remain distinct.

## Final verification

| Command / check | Observed result |
| --- | --- |
| `node --test tests/contract/runtime-capabilities.test.ts tests/contract/runtime-input.test.ts tests/contract/host-runtime.test.ts` | 56 passed, 0 failed/cancelled/skipped |
| `npm test` | 290 passed, 0 failed/cancelled/skipped; 2.663 seconds |
| `npm run test:python` | 44 passed; 4.353 seconds |
| `npm run typecheck` | Passed, including the three negative compile fixtures |
| `npm run format:check` | Passed |
| `node examples/typescript/hosted.ts` | Queued native ID null; waiting_approval before simulated review; completed afterward; one dispatch; zero execution occupancy |
| Documentation file-link audit | 30 Markdown files, 118 relative file links, no missing targets |
| `git diff --check` | Passed |

The complete Node run includes real local Unix-socket and owned subprocess tests, including the new crash/restart/Python case and a negative-suite self-test. Local IPC tests ran with the required sandbox permission; no permission failure was counted as a pass. Python was rerun in its own complete suite. The normal SQLite experimental warning is not a test failure.

The negative-suite child initially inherited `NODE_TEST_CONTEXT` from its parent Node test worker and did not execute the intended fresh test run. The self-test detected this as a missing rejection. Its child environment now removes only that worker-context variable. A standalone negative run executed exactly one failing case, and the final complete run confirms the self-test receives exit code 1 with `Runtime contract timed out: background work retention`. This expected failure is evidence that the reusable suite detects an incorrect bridge, not a failing final regression.

The original 231-test Node baseline and 44-test Python baseline remain green. The final Node total adds 59 tests/subtests. Production provider adapters, the Python implementation, protocol schema, dependency lock, and storage schema were not changed. Repository source remains uncommitted; no publication, push, or deployment was performed for this increment.

## Unverified boundaries

No credentials, model calls, real application bridge, production host permissions, durable cross-store journal/projection, published packages, application bundle/hot update, multi-tenant isolation, or performance/long-running capacity acceptance were exercised. Fixture stop evidence describes only controlled offline work. Real application integration must run the suite through its own host boundary and obtain separate real-model acceptance.
