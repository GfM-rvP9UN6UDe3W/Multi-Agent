# Python SDK TDD evidence — 2026-09-19

Scope: `python/` and `examples/python/` only. Python standard library client for wire 1.0.
No model calls, package publication, credential reads or database access from Python.

## Initial RED

Tests and the independent fake protocol fixture were written before the package existed.

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p 'test_sdk.py' -v
```

Exit 1: `ModuleNotFoundError: No module named 'agent_orch'` during test discovery.
After implementation, the initial 15 contract tests passed. Unix socket tests required
execution permission outside the filesystem sandbox, which initially returned `EPERM`
when binding a socket. The same authorized test command passed with socket access.

## Behavioural RED → GREEN

Added a recovery test before fixing concurrent connection failure handling:

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p 'test_sdk.py' -k disconnected_mutations -v
```

RED, exit 1: two concurrent mutations returned recovery keys
`['lost-second', 'lost-second']` instead of `['lost-first', 'lost-second']`.
The transport shared one exception object between pending futures. It now creates an
independent error per pending request, so each mutation retains its own recovery key.
The same test then passed.

The recovery test was extended to require `method` and the operation's actual `scope`,
not just its key. RED raised `AttributeError: OrchestrationError has no attribute method`.
Receipts/errors now carry all three lookup fields, including the approval ID scope for
`approvals.decide`; the extended test passed after that change.

## Real Node subprocess integration

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p 'test_node_e2e.py' -v
```

3 passed on Node v24.14.0 and Python 3.14.6:

- stdio task → persisted approval → accepted completion → restart/query/idempotent replay;
- drain timeout → retained client/operation ID → interrupt and confirmed process shutdown;
- two Unix-socket clients share a task, while client disconnect leaves the host running.

These tests run the real local Node host and SQLite engine with an explicit `fake` runtime.
They do not prove Claude/Codex runtime, tool, model-cache or cost behaviour.

## Final verification

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -v
python3 -m compileall -q python/src python/tests examples/python
PYTHONPATH=python/src python3 examples/python/fake_roundtrip.py
```

- Full suite: 19 passed (16 protocol/client contracts + 3 real Node host integrations),
  no skips, 1.366 seconds on this run.
- Bytecode compilation: exit 0.
- Executable example: exit 0, status `completed`, deterministic expected result,
  `runtime: fake`, `model_calls: none`.
- Protocol mismatch code was aligned with the final shared contract as `PROTOCOL_MISMATCH`;
  the focused test first failed with the previous code and passed after correction.
- Python 3.11 compatibility follows the language/API baseline but was not run on a 3.11
  interpreter on this host; the available interpreter was Python 3.14.6.
- Wheel creation/install was not exercised: setuptools is absent from the available
  interpreter. Runtime tests use `PYTHONPATH=python/src`; no build dependencies were downloaded.

## Review fixes: startup/close races

Added `tests/test_lifecycle.py` first, using gates around real fixture subprocess
creation and transport return. The tests always clean up their known fixture resources.

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p 'test_lifecycle.py' -v
```

RED: 4 tests ran; 3 failed because the owned process remained alive after:

- close raced with a transport that had been created but not assigned to the client;
- startup was cancelled after transport creation but before it returned;
- startup was cancelled after the subprocess existed but before creation returned.

The failure-and-close case already passed and remains a deadlock regression guard.
Startup, close and disconnect now share one lifecycle lock. Transport creation is
shielded so cancellation cannot lose an already-created child; failed/cancelled startup
waits for ownership to resolve and completes cleanup before re-raising. Cleanup and
shutdown call the transport directly and do not recursively acquire the startup lock.
Repeated cancellation during startup cleanup is included in the regression coverage.

GREEN: all 4 lifecycle tests passed; process exit plus both reader tasks are verified.

## Review fixes: fatal JSON decoder exceptions

Added `tests/test_transport_parsing.py` before widening the decoder exception boundary.

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p 'test_transport_parsing.py' -v
```

RED: both tests exceeded a 250 ms guard with pending calls still unresolved; their
ordinary request deadlines were 5 seconds. The frames were below the 1 MiB limit.
One frame used a 5000-digit integer with Python's 4300-digit limit. The other used
deep nesting with the standard library's Python scanner to deterministically raise
`RecursionError` across Python versions. Python 3.14's C scanner accepted the original
depth-only candidate, so that fixture was corrected and both tests were rerun against
the original exception handling before applying the final fix.

`ValueError` (including integer/UTF-8/JSON decode errors) and `RecursionError` now become
`PROTOCOL_ERROR`; the connection closes and every pending request gets an independent
error immediately. GREEN: both tests passed in 0.005 seconds on the focused run.

Final review-fix regression:

```sh
PYTHONPATH=python/src python3 -m unittest discover -s python/tests -v
python3 -m compileall -q python/src python/tests
```

25 tests passed, no skips, 1.760 seconds (22 Python client/protocol/lifecycle tests plus
3 actual Node/fake-runtime integrations). Compilation exited 0. Only Python source,
tests and this evidence file changed in this review-fix pass.
