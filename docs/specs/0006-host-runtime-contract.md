# SPEC-0006: Host runtime contract and offline conformance

Date: 2026-09-20. Status: implemented and verified with offline contracts and actual subprocess/Unix-socket integration. See [TDD evidence](../tdd/0006-host-runtime-contract.md). Concrete application integration and real-model acceptance remain unverified.

Design authority: [adapter extension and host integration](../../AGENT_ORCHESTRATION_DESIGN.md#73-current-application-adapter-extension-point), updated before this specification. This is delivery slice 1 in design section 7.5. A2 remains authoritative for execution leases, evidence, quarantine, deadlines, and owner reconciliation; this increment does not weaken those rules.

## Problem and target behavior

The engine already accepts application-owned adapters, but its TypeScript capability declaration leaves a required budget under an untyped JSON extension. Invalid JavaScript capability values may be used as truthy permission/resume/interrupt declarations. Existing hosts also need an executable way to verify the difference between queue admission, native acceptance, main-turn completion, resource shutdown, and result acceptance.

Make the supported adapter contract explicit and validate it before task admission and dispatch. Provide an optional Node test entry point that exercises a caller-supplied offline host boundary through the real engine. Include a controlled offline host implementation and a runnable SDK example. Do not add another scheduler or force application-specific policies into the engine.

## Scope and non-goals

In scope: capability types/validation, required engine-input preflight for host adapters, the shared conformance suite, an offline host fixture/example, real-process crash/restart and Python interoperability, and corresponding documentation.

Out of scope: a production Axion adapter, host authentication or durable dispatch journal, cross-store projection implementation, new task/wire fields, MCP/model delegation tools, a custom CLI module loader, session fork/compact, workspace sandboxing, storage GC, worker/process relocation, npm/PyPI publication, application packaging/hot update, and real-model calls. The example's in-memory host map is deliberately not restart recovery; engine restart must remain conservative when it disappears.

Wire protocol stays 1.0; storage schema stays 2; event schemaVersion stays 1. No new runtime dependencies, automatic retries, credentials, model calls, or external network listeners.

## Contract

### Capability declaration

`RuntimeCapabilities` retains provider, resume, interrupt, permissionProfiles, and JSON extension fields. Add named required `RuntimeBudgetCapabilities` (`version: 2`, `acceptanceCapMs: number | null`, `turnCapMs: number | null`) and optional `RuntimeEvidenceCapabilities` (`version: 1`, `terminalCoversExecution: boolean`). Omitted evidence support remains conservative; an explicit malformed value must not be treated as omission.

Export `readRuntimeCapabilities(adapter)`, returning a detached immutable snapshot. Validate:

- The declaration is an object and its provider equals the adapter's nonempty provider identity.
- resume and interrupt are booleans. permissionProfiles is a nonempty, duplicate-free list containing only read-only/workspace-write.
- Budget version is 2, both caps are explicit null or integers from 1 to 86400000 ms. Preserve UNSUPPORTED_CAPABILITY for absent/unsupported budget versions; malformed supported-version values are INVALID_RUNTIME_CONTRACT.
- Optional evidence, when present, is an object with version 1 and a boolean terminalCoversExecution. Unsupported evidence versions fail with UNSUPPORTED_CAPABILITY; malformed shapes fail with INVALID_RUNTIME_CONTRACT.
- Extension values are JSON-compatible, with finite numbers, no cycles, functions, non-plain objects, sparse arrays, or undefined array elements. Optional object properties with undefined may be omitted. Bound snapshot traversal to 32 nesting levels and 10000 values.
- Capability reads that throw or return a Promise are INVALID_RUNTIME_CONTRACT. Error messages identify the field/provider without echoing arbitrary returned payloads.

Use the same validation for task admission, configured provider preflight, capability queries, and dispatch. A dispatch uses one snapshot for permission support, resume support, budget, and execution evidence coverage. Revalidate queued work immediately before execution; a lost permission capability must stop dispatch before invoking the adapter. Do not change existing conservative behavior for an adapter that truthfully declares missing evidence coverage.

### Engine-supplied input

Keep `RuntimeInput` usable by the existing standalone adapter tests/callers. Add `EngineRuntimeInput`, requiring generation, executionBudget, and reportExecutionEvidence, and `requireEngineRuntimeInput(input)` to validate and return that narrower shape. Require positive integer generation, nonempty task/session/dispatch IDs, an AbortSignal-compatible signal, budget policyVersion 2 with positive effective limits and callable remaining-budget methods, and the evidence callback. Do not invent defaults or reset deadlines. The helper does not authenticate a caller, prove enforcement, inspect credentials, or submit work.

### Optional conformance entry point

Export a testing-only `registerRuntimeAdapterContract(name, createFixture)` entry point. A fixture supplies its adapter, observations of actual host submissions, controlled host actions, and deterministic cleanup. Actions are delivered through the host boundary; the suite must not bypass the adapter by fabricating evidence directly into the engine. Run every scenario against a fresh temporary workspace/stateDir and actual engine. Bound waits and cleanup, report failures rather than skipping unavailable capabilities, and never import testing code from normal engine initialization.

The controlled host records the engine dispatch identity; its queued receipt never emits accepted. Actual simulated native acceptance supplies a stable native session/turn. Its read-only gate and simulated tool-confirmation counter belong to the fixture host; it does not authenticate users or invoke tools. Its synthetic task-acceptance decision is explicitly a test action. All terminal/stop evidence is explicitly marked as deterministic fixture evidence. No claims about a real host's security or native process termination follow from this fixture.

## Acceptance criteria

- **AC-H01 Typed and validated capabilities:** Typecheck rejects missing required budgets, unsupported budget literals, and malformed evidence declarations. Runtime tests reject invalid booleans/profiles/provider identities, caps, versions, non-JSON extensions, thrown/async declarations, and malformed evidence before task persistence or adapter submission. Valid unknown JSON extensions and omitted evidence remain supported. Snapshot mutation cannot change returned capabilities. Queued work loses no safety check at dispatch.
- **AC-H02 Required host input:** A hosted adapter receives the original identity, signal, generation, monotonic budget functions, and evidence callback. Missing/malformed engine-only fields fail preflight before the host is called. Existing direct Claude/Codex RuntimeInput callers remain supported. Time spent in host admission consumes the original remaining budget.
- **AC-H03 Native acceptance and definite rejection:** Queue insertion alone leaves the dispatch unaccepted. A definite pre-submission host rejection yields failed, no native-accepted event, and no retained execution lease. Native acceptance must use the host's actual simulated native ID. No host receipt is promoted to native acceptance.
- **AC-H04 Ambiguity and idempotency:** Disconnection after possible submission, including before native acceptance, retains blocked/outcome_unknown and occupied execution. Repeating the same tasks.create key returns the same task without another host submission. Inspecting or waiting does not retry execution.
- **AC-H05 Cancellation proof:** If interrupt is supported, a cancellation acknowledgement/aborted stream without stop evidence cannot report completed cancellation or release the execution lease. Later matching stop evidence may release execution but must preserve unknown business outcome. If interruption is unsupported, the suite verifies explicit rejection without cancelling work; it must not skip the case or pretend interruption succeeded.
- **AC-H06 Background and late evidence:** A main-turn result with retained host resources cannot release the slot or complete the task. Mismatched generation/dispatch evidence cannot release it. Later correct full-execution evidence may release only execution; the task remains blocked until explicit owner reconciliation. Resume after reconciled completed output requests human task acceptance without resubmitting the host turn.
- **AC-H07 Result acceptance and usage:** A clean terminal result and complete resource proof release execution and request human task acceptance, not automatic task completion. Usage emitted twice with the same usageId is recorded once; missing fields remain null. Host tool confirmation cannot satisfy task acceptance. Explicit approval completes the task without a second dispatch.
- **AC-H08 Process and language boundary:** Crash a real owned fixture host process after a persisted dispatch, restart against the same stateDir with no in-memory host mapping, and observe blocked/outcome_unknown with no automatic resubmission. A real Python client subprocess reads the same recovered task/session, capabilities, and scheduler state. Ordinary socket clients remain unable to reconcile owner state.
- **AC-H09 Runnable example and scoped claims:** The documented offline host example executes from source, reaches waiting_approval, uses a clearly identified simulated approval, completes, and closes. Tests/source contain no Axion paths, login reads, paid-model calls, or claims of real permission/packaging acceptance. Documentation marks the concrete host bridge, journal/projection, package distribution, and performance work as later slices.

## Verification order

After the design and this specification: add failing behavior/type tests, run and record actual RED, then implement. Add regression scenarios for previously correct A2 behavior without fabricating failures. Run the conformance suite, process/Python integration, the example, full Node and Python suites, typecheck, formatting, and diff checks. Record commands, observed failures, counts, and unverified boundaries in `docs/tdd/0006-host-runtime-contract.md`.
