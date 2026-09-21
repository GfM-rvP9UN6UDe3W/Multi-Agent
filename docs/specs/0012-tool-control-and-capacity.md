# SPEC-0012: Tool control precedence and scoped capacity

Date: 2026-09-21. Status: implemented and verified locally; remote CI on this source is pending. This increment addresses three verified findings in the current repository without changing the provider or publication gates in the readiness ledger.

## Acceptance criteria

- **R01 — Client pause wins:** A session pause records whether it came from an ordinary client or a bound runtime tool. A bound `work_control` cannot resume, stop, rotate or compact a client-owned pause, including a pause inherited from an older store with no origin field. A client may resume it. A client pause of an already runtime-paused session takes ownership, and a later runtime pause cannot replace that ownership. The origin survives the active dispatch settling and a host restart. A bound runtime may resume a pause it initiated. Operation idempotency and stale-target checks remain in force.
- **R02 — Scoped tool state:** Every bound tool computes its loop fingerprint and subtree checks from only the authorized root and its descendants. An indexed lookup by `spec.parentTaskId` expands the subtree and preserves task insertion order for loop fingerprints. The existing subtree authorization, child-count, context-artifact and operation-ownership rules remain unchanged. Retained unrelated tasks do not make an otherwise constant-size tool call scale linearly with global history.
- **R03 — Honest capacity contract:** Programmatic engine default `maxLogicalSessions` is 10,000; the configured upper bound is 100,000. Capacity measurement with 50,000 retained sessions explicitly uses `maxLogicalSessions: 100000`. Schema, README and readiness evidence disclose the limit and the `SESSION_CAPACITY_EXHAUSTED` outcome. The bounded benchmark also measures `work_read` at each history size; it does not claim a production latency guarantee.

## Verification

Record a failing behavioral regression for R01 and a failing global-scan regression for R02 before changing runtime code. Run focused Node and Python/actual-host tests, generated-contract, type and format checks, then full suites. Run the bounded capacity benchmark separately and record its exact configuration and measured tool latency. Package artifacts, if rebuilt, receive a new immutable candidate version. Git submission and registry publication remain separate actions.

Local RED/GREEN and measurement evidence is in [TDD-0012](../tdd/0012-tool-control-and-capacity.md) and [the capacity result](../tdd/0012-capacity.json).
