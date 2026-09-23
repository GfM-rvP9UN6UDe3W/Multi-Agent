# SPEC-0020: Checking context references before submitting

Date: 2026-09-23. Status: designed and approved by the owner as decision D-routing-1, with D-routing-4, D-routing-5 and D-routing-6 each set to option 1. Implemented on branch `context-check`. It is not in rc.13 or any earlier candidate. Evidence: [TDD-0020](../tdd/0020-context-check.md). It extends [SPEC-0019](0019-routing-corrections.md) C03.

It adds one read-only wire method and one capability flag. Storage schema 3 and wire 2.0 are otherwise unchanged; no existing method, result or event changes shape.

## Why

The router of SPEC-0018 cannot see whether a result's content is still readable:

- The engine collects unprotected detail every hour, and keeps it for at least 90 days after its task ends.
- The task snapshot keeps its result text, so the router keeps carrying a collected result.
- Every submission then fails with `ARTIFACT_HISTORY_EXPIRED`, and keeps failing until that agent produces a new result.
- A result damaged on disk fails the same way, with `ARTIFACT_CORRUPT`.

## The method `context.checkRefs`

- **Parameters:** `{ contextRefs: [{ artifactRef, version: 1 }] }`, with 1 to 20 entries.
  - They are validated like `contextPlan.contextRefs`, by the same function.
  - An empty list or more than 20 entries fails with `VALIDATION_ERROR`, as does an unknown field.
  - A `version` other than 1 fails with `UNSUPPORTED_CAPABILITY`.
- **Result:** `{ contextRefs: [{ artifactRef, admissible, code?, bytes? }] }`, one entry per requested reference, in request order.
  - `admissible: true`: the check that task admission applies to a context reference passes now.
  - `admissible: false`: `code` is the error that admission returns for it:
    - `ARTIFACT_TOO_LARGE`, over the inline limit of 32 KiB;
    - `ARTIFACT_HISTORY_EXPIRED`, collected;
    - `ARTIFACT_CORRUPT`, damaged;
    - `NOT_FOUND`, not registered in this store;
    - `ARTIFACT_UNREADABLE`, for any other read failure.
  - `bytes`: the registered size, when the store has a record.
  - The content is never returned.
- **One rule:** admission, the prompt and this method read a context reference through one engine function with one limit. A read failure that is not already an engine error becomes `ARTIFACT_UNREADABLE` in all three places; before, admission let it escape as an unclassified error.
- **Read-only:**
  - no store write, event or operation;
  - no idempotency key;
  - reading does not extend retention.
- **Who may call it:** any client, the owner or not. Any client can already learn the same outcome by submitting a task with that reference.
- **Capability:** `initialize` reports `capabilities.workflow.contextCheck: true`.
- **SDKs:** `orch.context.checkRefs(contextRefs, options?)` in TypeScript and `await orch.context.check_refs(context_refs)` in Python.

## The router

- After the judge answers, the router checks every result it might carry that also passed its own size check (SPEC-0019 C03):
  - the latest result of each candidate at `contextAt` relevance or above;
  - on busy paths, the chosen agent's own result.
  - It sends at most 20 references per call; that is one call for the default 16 candidates.
- A result the engine refuses is left out, with a `CONTEXT_OMITTED` reason:
  - `reason` is `too_large`, `expired`, `corrupt`, `missing` or `unreadable`;
  - `code` is the engine's code, and `bytes` is included when known;
  - it takes no `maxContextRefs` place;
  - it does not set `needsConfirmation` (decision D-routing-2).
- An engine that does not report `contextCheck` gets the SPEC-0019 behavior. When the proposal carries at least one result, the router adds one `CONTEXT_UNCHECKED` reason with the number of unchecked references. It does not set `needsConfirmation`.
- If the check call itself fails, `route()` fails with that error.

## Timing invariants

- An answer describes the moment of the call. Admission checks again. A reference collected or damaged in between fails the submission with the engine's error, and nothing is created. Routing and submitting are not atomic, and the check pins nothing.
- A call changes no state: the event cursor and the number of operations are the same before and after it.

## Acceptance criteria

- **K01** The method agrees with admission. Submitting a task with each reference then succeeds or fails with the same code:
  - a result of exactly 32,768 bytes is admissible;
  - 32,769 bytes, in ASCII or in multi-byte text, is `ARTIFACT_TOO_LARGE`, with its `bytes`;
  - a collected result is `ARTIFACT_HISTORY_EXPIRED`;
  - a result damaged on disk is `ARTIFACT_CORRUPT`;
  - an unknown reference is `NOT_FOUND`.
- **K02** Parameters are validated like `contextPlan.contextRefs`: no entries, 21 entries, `version: 2`, an unknown field.
- **K03** The method is read-only: no event and no operation is recorded.
- **K04** Clients and schema:
  - a socket client that is not the owner may call the method;
  - its result from a real Unix host validates against the schema, and corrupted copies are rejected;
  - Python reads the same result over the same socket;
  - `initialize` reports the capability.
- **K05** The router leaves out collected and damaged results with their reasons, and the proposal submits. Tested in both languages.
- **K06** Against an engine that does not report the capability, the router keeps the SPEC-0019 behavior and reports `CONTEXT_UNCHECKED`. Tested in both languages.

## Boundaries

- The method only reports. It never repairs, pins or extends the retention of a reference.
- Admission remains the authority: a reference can change between the check and the submission.
