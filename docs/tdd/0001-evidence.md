# SPEC-0001 TDD evidence

Date: 2026-09-19. These are actual command results, not real-model end-to-end acceptance.

## Environment

- macOS; Node.js v24.14.0; Python 3.14.6; TypeScript 5.9.3.
- Node's built-in SQLite emits an experimental warning on stderr; built-in SQLite is the persistence implementation.
- Before this increment, the workspace contained only two Markdown files and two PNGs, with no source or Git repository. Development did not overwrite business code, initialize Git, publish packages, or call paid models.

## RED → GREEN

| Scope | Observed RED | After implementation |
| --- | --- | --- |
| Engine foundation | `node --test tests/engine/foundation.test.ts`: exit 1, ERR_MODULE_NOT_FOUND; index.ts did not exist | First round: 15/15 passed |
| Host + TS SDK | `node --test tests/contract/host.test.ts tests/contract/sdk.test.ts`: exit 1, two missing-file errors for host.ts / SDK index.ts | Verified in full suite after implementation |
| Python SDK | `PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p 'test_sdk.py' -v`: exit 1, ModuleNotFoundError agent_orch | First round: 15 passed; later recovery regressions added |
| Claude/Codex adapters | `node --test tests/contract/adapters.test.ts`: exit 1, missing Claude module | First round: 10/10 offline protocol tests passed |
| Bounded close, result session ID, control races | Extended foundation suite: 15 pass / 3 fail; adapter cleanup hung, native session ID was null, stale pause falsely completed after cancel | 18/18 passed after fixes |
| Python lost-receipt recovery keys | Two failed requests shared one exception, producing `[lost-second, lost-second]` | Independent exception objects fixed; regression passed |
| TS wait timeout against slow host | A 200 ms state read prevented a local 10 ms wait from timing out promptly | Fixed and verified by the corresponding contract test |

## Independent review and added regressions

- Approval incorrectly clearing pause, expired approval causing session resume to rerun, and `..state` bypassing directory checks: new tests first **18 pass / 3 fail**, then all passed.
- Changed upstream native session ID at terminal left pause permanently persisted: focused test **0/1 → 1/1**. Exception fallback now atomically marks dispatch, mail/outbox, and controls outcome_unknown.
- An independent reviewer reran those four focused regressions: **4/4 PASS**. Independent review did not replace the primary agent's full regression.
- Large multilingual output and event pages: focused tests **0/2 → 2/2**. Full text uses content-addressed artifacts, inline preview is capped at 64 KiB, and event pages use encoded-byte limits with correct cursors.
- Host/TS settlement error codes, configuration allow lists, private socket directories/path length, and numeric bounds first failed, then reached **15/15 GREEN**.
- Adapters added isolated CODEX_HOME, managed configuration, request/terminal deadlines, queue bounds, and actual exit checks: RED, then **16/16 GREEN**. Local Codex 0.153.4 performed only an isolated initialize handshake, without a model turn.
- Python review found startup/close races and malformed JSON killing the reader. See [Python TDD](../../python/TDD.md).

## Real subprocesses and crash boundaries

`node --test tests/engine/recovery.test.ts` passed. An owned Node fixture creates running and queued tasks, receives SIGKILL, and reopens the same SQLite store. The lock is released; running → blocked/outcome_unknown; queued → paused; no model call starts automatically. Explicitly resuming unexecuted queued work runs exactly one turn. This added acceptance to existing recovery code; no independent RED was invented.

Python `test_node_e2e.py` uses the actual Node CLI and fake runtime for stdio create/accept/restart idempotency, two Unix clients sharing state and closing independently, and incomplete-close continuation/interruption. It verifies local wiring, not provider models.

`tests/contract/cross-language.test.ts` adds a genuinely mixed-language chain: TS submits → Python connects to the same Unix host, replays the approval event, checks the fixture and approves → TS observes that task completed. storeId/taskId match, and the host survives Python disconnect. Focused result: 1/1 passed.

## Final verification

The primary agent reran these after integrating all fixes in the workspace:

| Command | Final result |
| --- | --- |
| `npm test` | **57/57 PASS**, 0 failed, 0 skipped; 1.441 s |
| `npm run test:python` | **25/25 PASS**, 0 skipped; 1.588 s |
| `npm run typecheck` | exit 0 |
| `npm run format:check` | exit 0; all configured source paths passed |
| `python3 -m compileall -q python/src python/tests examples/python` | exit 0 |
| `PYTHONPATH=python/src python3 examples/python/fake_roundtrip.py` | completed, fake, model_calls=none |
| Actual TypeScript local-example subprocess | Entered approve for the known fixture; completed; process exit 0 |

Total: 82 automated tests, including real mixed-language, subprocess, socket, database, and crash boundaries. Python socket tests initially hit sandbox EPERM, then passed in an approved local-IPC environment; no failing test was skipped.

No provider model task ran, and this did not establish delivery of the complete first version.

## Not accepted

Actual Claude/Codex model tasks, official account login, complete MCP bridge, gateways, real cache/usage costs, long-lived Claude streaming input, fork/compact/rotate, package installation across languages, and minimum Node/Python version matrices cannot be inferred from these offline tests.
