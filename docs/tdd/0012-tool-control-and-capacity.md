# TDD-0012: Client pause and scoped tool reads

Date: 2026-09-21. Source: working tree based on `597f240`; local evidence only. Remote CI and actual application integration on these changes are pending.

## RED

- `node --test --test-name-pattern='0012-R0' tests/engine/runtime-tools.test.ts` ran the two initial new tests against the old code: **0/2 passed**. R01 observed no `pauseOrigin` after a client pause. R02 raised `global task scan in bound tool` from the existing `store.all('tasks')` path. Raw output: `/private/tmp/agent-orch-0012-red.log` on the development host.
- An initial indexed recursive query still used `SCAN child USING INDEX tasks_parent` in SQLite's recursive step. At 1k/10k/50k unrelated historical tasks, 20 bound `work_read` calls averaged 0.886/5.385/24.219 ms. That attempt did not meet R02 and was replaced by indexed parent point lookups.

## GREEN

- Client and runtime pauses now carry a durable `SessionSnapshot.pauseOrigin`. Bound control cannot resume, stop, rotate or compact a client-owned or legacy originless pause. A client can claim an already runtime-paused session; a runtime may resume its own pause. Tests cover old-store absence, takeover, active-drain settlement and restart. Python reads the persisted origin through an actual Node stdio host across restart.
- Tool loop state expands only the bound task's subtree using the `tasks_parent` expression index, with the original row insertion order for its fingerprint. A focused test rejects any global `tasks` scan and checks that the parent lookup plan is `SEARCH tasks USING INDEX tasks_parent`.
- The bounded benchmark sets `maxLogicalSessions: 100000` explicitly, seeds 1k/10k/50k sessions, runs 100 fixture tasks per row and measures 20 `work_read` calls on the first dispatch. Indexed lookup mean: **0.463/0.549/0.636 ms**; p95: **0.956/1.011/0.515 ms**. These are local samples, not a production latency guarantee. See [full environment and rows](0012-capacity.json).
- Full Node 24.14.0 and minimum Node 22.18.0 suites with IPC access: **442/442 each**, zero skipped; Python 3.14.6 suite: **49/49**. Typecheck, formatting, generated-contract and `git diff --check` passed. The first sandboxed Node 24 run failed 32 IPC cases with `listen EPERM`; it is not counted as a pass. The same command was rerun with local IPC access.
- Immutable local `0.1.0-rc.5` npm/Python archives passed all **nine** clean-install/package modes, including the CJS/ESM single-file Claude bundles. No paid models or login credentials were used. Previous RC artifacts were not overwritten.

## Remaining boundary

The previous committed source `597f240` passed [six remote jobs](https://github.com/masonlee39/Multi-Agent/actions/runs/35530017913). This working-tree increment has not been committed or run in remote CI. The [readiness ledger](../acceptance/readiness.md) retains actual gateway/model, OS sandbox, Axion application, economics, production capacity and publication gates.
