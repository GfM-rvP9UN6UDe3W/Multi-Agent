# SPEC-0017: Audit corrections for rc.10

Date: 2026-09-22. Status: approved by the owner; implemented on branch `axion-rc11` for rc.11. Evidence: [TDD-0017](../tdd/0017-audit-corrections.md). Origin: a self-audit of the code added since rc.7 (`2d50e3e..fbf9bdf`) found four defects. Three were reproduced offline; the fourth was found by reading the code.

## Acceptance criteria

- **A01 — Rules never block startup (corrects [SPEC-0014](0014-host-workflow-controls.md) W03/W04):**
  - The problem: the engine re-validated every verification rule at startup, including that its `cwdRelative` and `baselinePaths` exist. A registered rule whose directory was later removed or renamed made startup fail with a raw `ENOENT`. Registered rules cannot be removed, so no configuration change could recover the host. Store switches ran the same check.
  - Startup, store switches and the CLI's configuration loading now check only each rule's shape, without touching the filesystem. The shape covers fields, types and bounds, a relative `cwdRelative`, an absolute executable, and `cwdRelative` and `baselinePaths` that do not leave the workspace by name. This applies to configured and registered rules alike. Conflicts between configured and registered rules still fail startup with `VALIDATION_ERROR`, because their digests do not depend on the filesystem.
  - `rules.register` and task admission also resolve the paths. A path that cannot be resolved fails with `INVALID_WORKSPACE_SCOPE`; the message names the rule, the path and the system error code, for example `ENOENT`. A path that resolves outside the workspace, for example through a symlink, fails as before. A refused admission records nothing, so the same request succeeds once the directory exists again.
  - A check whose path disappears after admission records a failed verification with the error, as before.
  - This changes behavior: a configured rule with a missing path no longer stops the engine from starting. The tasks that use it are refused.
- **A02 — Retries do not depend on the host default (corrects [SPEC-0015](0015-queue-waits.md) Q04):**
  - The problem: `tasks.create` computed its idempotency digest from the spec after applying `limits.defaultMaxQueueWaitMs`. Retrying an identical request after the owner changed that default failed with `IDEMPOTENCY_CONFLICT`.
  - The digest now uses the spec normalized with the fixed fallback of 30,000 ms, as in rc.8, while the admitted task still stores the host default.
  - An identical retry returns the original task under any default. Requests first admitted under rc.9 or rc.10 with a default other than 30,000 ms compare differently after the upgrade, so their retries conflict once.
- **A03 — Revise needs a live session (corrects SPEC-0014 R02/R03):**
  - The problem: `revise` on a task whose session was stopped succeeded, and left the task paused as `paused_by_client` with no way to run the revision.
  - It now fails with `SESSION_CLOSED` and changes nothing. The approval stays pending, and approve or deny still apply.
- **A04 — Handoffs expire on time (corrects SPEC-0014 H03):**
  - The problem: pending handoffs expired only when a scheduler pass, a handoff read or a new request happened to run, so an idle host emitted `handoff.expired` arbitrarily late.
  - The engine now keeps one timer for the earliest pending expiry. It is armed at startup, after each new request and after every expiry check, and it wakes the scheduler, which expires due requests. Expiry therefore also happens while the requesting turn is still running. The deadline is wall-clock time, as for queue waits (SPEC-0015 Q05). A timer that fires early only re-checks. If recording an expiry fails, that request is retried by the next scheduler pass, read or mutation, as before; the timer still covers later requests.

## Boundaries

- Approving a result while messages to the task's stopped session are still pending has the same effect as A03's revise: the task becomes `paused` as `paused_by_client` and cannot be resumed (`SESSION_CLOSED`). This predates SPEC-0014 (it is present at `2d50e3e`) and is not changed here, because the fix must decide what happens to the pending messages.
- Message expiry needs no timer: every call applies it before it runs, including `events.read`.

## Verification

Record an observed RED for A01–A04 against `fbf9bdf` before changing the engine; the manual engine clock drives A04. The Python SDK repeats A01 and A03 against the real stdio host. Then run the focused tests, the type, format and generated-contract checks and both full suites. No credentials or paid models are used.
