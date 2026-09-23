# TDD-0020: Checking context references before submitting

Date: 2026-09-23. Base: `e6bb1c6`, the source of the rc.13 candidate. Branch `context-check`. rc.13 and earlier candidates do not include it; nothing is published. Specification: [SPEC-0020](../specs/0020-context-check.md).

## RED

Tests:

- `tests/engine/context-check.test.ts`
- the K04 additions to `tests/contract/protocol-schema.test.ts`
- `python/tests/test_context_check.py`

The final versions were run against a clean copy of `e6bb1c6`, extracted with `git archive`:

- `node --test tests/engine/context-check.test.ts tests/contract/protocol-schema.test.ts`: 7 of 11 failed.
- `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=python/src python3 -B -m unittest discover -s python/tests -p test_context_check.py -v`: 3 of 3 failed.

Failures that show missing behavior:

| Test | Failure at `e6bb1c6` |
| --- | --- |
| 0020-K01 admission and the check report a reference whose file is gone as ARTIFACT_UNREADABLE | Admission failed with the raw `ENOENT`, whose message named the state directory |
| 0020-K05 the router leaves out collected and damaged results, and the proposal submits | The collected and the damaged result were carried |
| 0020-K06 without the capability the router keeps checking sizes only and says so | No `CONTEXT_UNCHECKED` reason |
| Python K05 the router leaves out damaged results | The damaged result was carried |
| Python K06 the router without the capability says it did not check | No `CONTEXT_UNCHECKED` reason |

The other failures only show that the new method did not exist yet: `checkRefs is not a function` in TypeScript, and `'_Context' object has no attribute 'check_refs'` in Python. That is expected for a new interface, and it is not counted as evidence of a defect. These tests are:

- 0020-K01 the check agrees with task admission for each kind of reference;
- 0020-K02, 0020-K03;
- the contract test AC-W02/W03/W05;
- Python K01.

The four other tests in the contract file passed at `e6bb1c6`.

How the test files were corrected before the final RED:

- The first K03 run failed because the helper read events with a non-zero cursor but no `storeId`. The helper now passes the store id.
- The K01 case for a missing file was added after a probe at `e6bb1c6` showed that admission let the raw `ENOENT` escape.

## Implementation

- **Engine:**
  - `contextRefText` reads a context reference with the limit `CONTEXT_REF_MAX_BYTES` (32,768). Admission and the prompt now use it, and turn a read failure that is not an engine error into `ARTIFACT_UNREADABLE`.
  - `context.checkRefs` validates its parameters with the `contextRefs` function it now shares with `contextPlan`. It calls `contextRefText` for each reference and returns `{ artifactRef, admissible, code?, bytes? }`, reading only.
  - `initialize` reports `workflow.contextCheck: true`.
- **Schema:** `WorkflowCapability.contextCheck` and the `ContextRefCheck` definition were added, and `npm run generate:protocol` regenerated five files, now with 69 definitions.
- **SDKs:**
  - TypeScript: `orch.context.checkRefs` fails with `UNSUPPORTED_CAPABILITY` against a host that does not report the capability, like the other workflow features.
  - Python: `orch.context.check_refs`, with `contextCheck` mapped to `context_check`.
- **Routers:**
  - After the judge answers, both collect the results they might carry that passed the SPEC-0019 size check. They send them to the engine, 20 per call, and give refused results a `CONTEXT_OMITTED` reason from the engine's code.
  - Without the capability they carry as before, and add `CONTEXT_UNCHECKED`.
  - A failed check fails `route()`.

## GREEN

- `node --test tests/engine/context-check.test.ts tests/contract/protocol-schema.test.ts tests/engine/routing-corrections.test.ts tests/engine/routing-layer.test.ts`: all passed.
- `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=python/src python3 -B -m unittest discover -s python/tests -p 'test_*context*.py'`: 3 of 3 passed; the 17 routing tests passed too.

## Mutation checks

Each part was undone in turn, and the matching focused tests were run:

| Mutation | Result |
| --- | --- |
| E1 the check ignores the inline limit | caught |
| E2 raw read failures escape unclassified | caught |
| E3 every reference is reported admissible | caught |
| E4 an empty list is accepted | caught |
| E5 the capability is not advertised | caught |
| R1, P1 the router ignores the engine's verdict (TypeScript, Python) | caught |
| R2, P2 the router does not report unchecked results | caught |
| R3, P3 the router checks without the capability | caught |

## Load

Twelve TypeScript and twelve Python runs of the new files, in parallel: 0 failures.

## Full checks

- `npm test`: 557 passed, 0 failed, cancelled or skipped.
  - The count covers the six new tests and two new sample checks in the contract test.
  - `0014-X02` pins the whole workflow capability object, so its expectation now includes `contextCheck: true`.
- `PYTHONDONTWRITEBYTECODE=1 npm run test:python`: 79 passed, none skipped.
- `npm run typecheck`, `npm run format:check` and `git diff --check`: passed. The new, untracked files were checked separately for trailing whitespace.
- `npm run check:generated`: passed; 5 generated files, 69 definitions.
- Loopback HTTP and the Unix socket were permitted; no test was skipped for permissions.

## Not verified

- A reference whose state changes between the check and the submission is covered by admission's own check (TDD-0019); this change adds no atomicity.
- The check reads each result that fits the limit and verifies its digest: up to 20 × 32 KiB per call. Its time with many large results was not measured.
