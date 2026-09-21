# TDD-0012: Client pause and scoped tool reads

Date: 2026-09-21. Implementation source: `9ce65e4`, with bounded test-harness follow-ups through `8ee5078`. Local verification and all six remote CI jobs are complete. Actual application integration remains a separate gate.

## RED

- `node --test --test-name-pattern='0012-R0' tests/engine/runtime-tools.test.ts` ran the two initial new tests against the old code: **0/2 passed**. R01 observed no `pauseOrigin` after a client pause. R02 raised `global task scan in bound tool` from the existing `store.all('tasks')` path. Raw output: `/private/tmp/agent-orch-0012-red.log` on the development host.
- An initial indexed recursive query still used `SCAN child USING INDEX tasks_parent` in SQLite's recursive step. At 1k/10k/50k unrelated historical tasks, 20 bound `work_read` calls averaged 0.886/5.385/24.219 ms. That attempt did not meet R02 and was replaced by indexed parent point lookups.

## GREEN

- Client and runtime pauses now carry a durable `SessionSnapshot.pauseOrigin`. Bound control cannot resume, stop, rotate or compact a client-owned or legacy originless pause. A client can claim an already runtime-paused session; a runtime may resume its own pause. Tests cover old-store absence, takeover, active-drain settlement and restart. Python reads the persisted origin through an actual Node stdio host across restart.
- Tool loop state expands only the bound task's subtree using the `tasks_parent` expression index, with the original row insertion order for its fingerprint. A focused test rejects any global `tasks` scan and checks that the parent lookup plan is `SEARCH tasks USING INDEX tasks_parent`.
- The bounded benchmark sets `maxLogicalSessions: 100000` explicitly, seeds 1k/10k/50k sessions, runs 100 fixture tasks per row and measures 20 `work_read` calls on the first dispatch. Indexed lookup mean: **0.463/0.549/0.636 ms**; p95: **0.956/1.011/0.515 ms**. These are local samples, not a production latency guarantee. See [full environment and rows](0012-capacity.json).
- Full Node 24.14.0 and minimum Node 22.18.0 suites with IPC access: **442/442 each**, zero skipped; Python 3.14.6 suite: **49/49**. Typecheck, formatting, generated-contract and `git diff --check` passed. The first sandboxed Node 24 run failed 32 IPC cases with `listen EPERM`; it is not counted as a pass. The same command was rerun with local IPC access.
- Immutable local `0.1.0-rc.5` npm/Python archives passed all **nine** clean-install/package modes, including the CJS/ESM single-file Claude bundles. That candidate preserves its precommit provenance (`sourceCommitted: false`) and is not the clean committed-source handoff. No paid models or login credentials were used, and previous RC artifacts were not overwritten.

## Remote CI

- Initial source `9ce65e4` ran in [35558527513](https://github.com/masonlee39/Multi-Agent/actions/runs/35558527513): **5/6 jobs passed**. Ubuntu/Node 24 exposed two bounded-wait failures: late execution-resource release and cross-language host readiness.
- Follow-up `52fdafb` ran in [35559024815](https://github.com/masonlee39/Multi-Agent/actions/runs/35559024815): **4/6 jobs passed**. Ubuntu/Node 22 exposed a rollover child-readiness timeout; Ubuntu/Node 24 exposed host-policy, replay-wait and bounded-GC polling races.
- Follow-up `5645d3a` ran in [35559738575](https://github.com/masonlee39/Multi-Agent/actions/runs/35559738575): **5/6 jobs passed** before Ubuntu/Node 22 exceeded the 20-minute job limit. GitHub no longer returned that job's log archive, so its exact last internal wait remains unknown.
- Final follow-up `8ee5078` bounded subprocess readiness and the test-run timeout. [Run 35561652769](https://github.com/masonlee39/Multi-Agent/actions/runs/35561652769) passed **6/6 jobs**. Every contract job passed **442 Node tests**, **49 Python tests** and **nine package modes**. Both Ubuntu and macOS native jobs passed six Claude and six Codex scripted-gateway groups without model calls.
- [The machine-readable CI record](0012-ci.json) preserves all 24 job/step results, exact available failure blocks, remediation commits and final proof lines. It explicitly does not attribute the cancelled job to an unseen test.

## Remaining boundary

SPEC-0012 is implemented and remotely verified, but CI uses scripted gateways and bounded fixture data. The [readiness ledger](../acceptance/readiness.md) still retains actual gateway/model, OS sandbox, Axion application, economics, deployment-capacity and publication gates. The clean committed-source handoff uses a new immutable `0.1.0-rc.6` candidate; rc.5 remains unchanged as historical precommit evidence.
