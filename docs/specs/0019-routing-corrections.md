# SPEC-0019: Routing layer corrections

Date: 2026-09-22. Status: requested by the owner after an external assessment of `370085f`, the source of the rc.12 candidate; merged into main as `e6bb1c6` (pull request #8) and packaged in the local rc.13 candidate. rc.12 still has these defects. Evidence: [TDD-0019](../tdd/0019-routing-corrections.md). It corrects [SPEC-0018](0018-routing-layer.md). There is no engine, wire, schema or storage change.

## Acceptance criteria

- **C01 — The judge's own confidence counts (corrects SPEC-0018 Policy and R05):**
  - The problem: the router checked that `best.confidence` was a probability and then ignored it. It used the proposed option's probability after dropping read-only candidates and renormalizing the rest. A judge that answered `confidence: 0.2` with `A1: 0.95` produced `confidence: 0.95` and `needsConfirmation: false`. Renormalizing alone could also lift an option the judge gave 0.8 above the 0.85 threshold.
  - A proposal now reports three figures separately:
    - `judgeConfidence`, in Python `judge_confidence`: the judge's own confidence in its `best` answer. It is null when `best` was not asked or the judge failed.
    - `alternatives[].judgeProbability`, in Python `judge_probability`: the probability the judge gave each option that can take the work.
    - `alternatives[].probability`: that option's share among those options. It orders the alternatives, and `NARROW_MARGIN` compares it, as before.
  - `confidence` is the lower of `judgeConfidence` and a figure for the decision itself:
    - when the proposal follows `best` (idle reuse, busy wait, busy parallel work or fresh chosen): the judge's probability for that option;
    - when no agent is relevant: 1 minus the highest relevance;
    - without candidates: 1;
    - when the judge failed: 0.
  - `LOW_CONFIDENCE`, and with it `needsConfirmation`, is set when there were candidates and `confidence` is below `confirmBelow` (0.85). Exactly 0.85 is confident. Renormalizing never raises `confidence`.
  - Unchanged:
    - no candidates;
    - judge failure and `onJudgeFailure`;
    - `NARROW_MARGIN`, `WRITES_UNCERTAIN` and `RUNTIME_MISSING`.
  - `submit` still submits whatever the host passes. Confirmation stays the host's decision.
  - Reason details:
    - `IDLE_REUSE` and `FRESH_CHOSEN` report the judge's own probability as `judgeProbability` (Python `judge_probability`), where they reported the share as `probability`.
    - `LOW_CONFIDENCE` reports `confidence` and `judgeConfidence`.
- **C02 — Findings stay in the source's group (corrects SPEC-0018 Notifications, R02 and R07):**
  - The problem: `notifications` chose recipients from `finding.rootTaskId ?? source.rootTaskId`. It never compared the two, and never checked that the source was a member. Take a source in root A, `rootTaskId: B` and a member of B, without `allowCrossRootReuse`: the plan named the B member, and `notify` delivered the message to B's task.
  - The source session must be one of `members`, under both scopes. Otherwise the call fails with `RoutingError` `ROUTING_SOURCE_NOT_MEMBER`.
  - Under `scope: 'root'` the group is the source session's own root task. It is derived as the engine derives it: the session's `rootTaskId`, else its task's root, else its task.
    - A `rootTaskId` that differs fails with `ROUTING_ROOT_MISMATCH`. So does a source without a root.
    - Members of other roots are ignored, as before.
  - Under `scope: 'engine'`, every member can receive the finding, and `rootTaskId` is ignored.
  - Both checks run before the judge is asked, so a refused finding reaches neither the judge nor any session.
  - This is a routing-group rule, not authorization. A host that holds the engine connection can still call `messages.send` directly, and the engine does not know about groups.
- **C03 — Results the engine would refuse are not carried (corrects SPEC-0018 R04):**
  - The problem: the router carried each relevant agent's latest result, limited only in number. The engine refuses a whole task when one context reference exceeds its inline limit of 32 KiB (`ARTIFACT_TOO_LARGE`). A 32,769-byte result therefore made an unconfirmed fresh proposal fail on submit.
  - The router measures each result as the engine does, in UTF-8 bytes. It reads the result from the task snapshot, which holds the complete result up to 64 KiB ([SPEC-0001](0001-foundation.md)) and a longer, marked preview beyond. A result of at most 32,768 bytes is carried; a larger one is left out.
  - A result left out adds a `CONTEXT_OMITTED` reason:
    - with `sessionId`, `artifactRef`, `reason: 'too_large'` and `maxBytes: 32768`;
    - with `bytes` too, when the snapshot holds the complete result.
    - Python uses snake_case keys.
  - A result left out takes none of the `maxContextRefs` places. The router never writes a summary in its place. `CONTEXT_OMITTED` alone does not set `needsConfirmation`.
  - The rule applies to every path that carries results:
    - context for idle reuse;
    - a busy wait's fallback;
    - busy parallel work, which carries the busy agent's own result first;
    - fresh sessions.
  - Collected and damaged results:
    - No read-only interface reported whether a result's content was collected or damaged. Collection happens at least 90 days after its task ended and reads as `ARTIFACT_HISTORY_EXPIRED`; damage reads as `ARTIFACT_CORRUPT`. [SPEC-0020](0020-context-check.md) adds `context.checkRefs`, and the router uses it where the engine offers it.
    - The engine checks every reference again when the proposal is submitted. Such a result, whether it was collected or damaged before or after routing, fails the submission with the engine's error, and nothing is created.
    - The router neither retries nor rewrites the proposal.
  - Unchanged: the engine's limit, its reference checks, and the wire.
- **C04 — One deadline per Jev evaluation (corrects SPEC-0018 R08 and R09):**
  - The Python problem: `timeout_ms` only set the socket timeout of `urlopen`.
    - A body that arrived a few bytes at a time kept every read short, so a 100 ms deadline returned a successful answer after 267 ms.
    - The coroutine waited for the thread without a deadline.
    - A cancelled evaluation left the thread reading.
  - Python now runs each request on its own daemon thread.
    - The coroutine waits at most until the deadline. At the deadline, or when it is cancelled, it shuts the connection down, which ends a blocked read at once. Then it raises `JUDGE_TIMEOUT` or re-raises the cancellation.
    - The thread bounds every socket operation by the time left and checks the deadline between reads of the body. It therefore also stops on its own while the event loop is busy.
    - The retry and the pause before it share the same deadline.
    - A refusal's body is never read.
    - Transport errors such as a truncated body count as network failures: one retry, then `JUDGE_UNAVAILABLE`.
  - The standard library cannot interrupt a name lookup. The thread then sends nothing after the deadline, and it ends when the lookup returns.
  - TypeScript already bounded headers and body with its `AbortSignal`. The check found two defects, now fixed:
    - The 200 ms pause before the retry ignored the deadline and the caller's signal: a 50 ms deadline returned after 215 ms. The pause now ends early with either.
    - A caller's abort while the body was arriving was reported as `JUDGE_PROTOCOL`. It now surfaces as the abort itself.

## Timing invariants

- A Python evaluation returns or raises within `timeout_ms` of its start on the monotonic clock, plus scheduling delay. After that, nothing it started reads from the connection. The only exception is a name lookup that is still running (C04).
- The router's check of a result (C03) and the engine's admission are separate steps. A result collected or damaged between them fails at submit, and nothing is created. No atomicity between routing and submitting is promised.
- The group checks for a finding (C02) complete before the judge is called, so a refused finding has no side effects.

## Owner decisions (2026-09-22)

- A result left out does not ask for confirmation. The omission is a fixed capacity limit, not an uncertain judgment, and `needsConfirmation` keeps meaning uncertainty. A host that wants a confirmation checks `reasons` for `CONTEXT_OMITTED`.
- Detecting a collected or damaged result before submitting gets a read-only engine query, as a separate change whose design the owner reviews before any code. The engine collects hourly and keeps detail for at least 90 days after a task ends, so a group that lives longer will meet such results. It is [SPEC-0020](0020-context-check.md).

## Boundaries

- Detecting a collected or damaged result before submitting needed a read-only engine query. This change added none; [SPEC-0020](0020-context-check.md) adds it.
- Covered by tests: HTTP on loopback; a TLS handshake against a local server that does not speak TLS. Not exercised: HTTPS to a real server and requests through a proxy. They keep urllib's defaults: the proxy environment variables and a default TLS context. The judge builds its own opener, so an opener installed with `urllib.request.install_opener` no longer applies.
- The default thresholds are still the small offline trials of SPEC-0018. No live Jev call was made.

## Verification

Record an observed RED against `370085f` for each criterion, in both languages, before changing the SDKs. Then run the focused tests, mutation checks, parallel load runs, the type, format and generated-contract checks, and both full suites. No credentials and no paid models are used.
