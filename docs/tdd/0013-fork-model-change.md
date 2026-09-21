# TDD-0013: Fork into another model of the same provider

Date: 2026-09-21. Base source: `2d50e3e`. Implementation commit: `3655cb6` on branch `spec-0013-fork-model`. Local verification and the first remote CI run are complete. Nothing has been published.

## Feasibility before tests

Before writing acceptance tests, a standalone spike ran the installed Claude binary (Claude Code 2.1.274, Agent SDK 0.3.274) against a loopback scripted gateway with an isolated home and synthetic credentials. It ran a parent turn on `model-alpha`, forked it with `resume`, `forkSession: true`, `resumeSessionAt` and `model: "model-beta"`, then resumed the parent on `model-alpha`. The gateway saw request models `model-alpha`, `model-beta`, `model-alpha`. The fork request carried the parent prompt and reply, returned a distinct native session ID, and the parent's later request did not contain the fork. All six checks passed. The spike changed no repository file.

## RED

- `node --test tests/engine/fork-model.test.ts` ran 14 new tests against the unchanged engine: **2/14 passed, 12 failed**. The failures were: `models` was not validated, so invalid lists were accepted and an unlisted model was admitted (M01). The JSON CLI rejected `models` with `providers.fake.model must name an explicit model` (M01). `sessions.fork` rejected `model` with `VALIDATION_ERROR: Unknown field: model` (M02–M04, M06). The protocol schema rejected `SessionForkParams.model` with `INVALID_WIRE_DATA` (M06). Of the two passing tests, one covers behavior that was already correct and remains unchanged: an inline `requestedMode: "fork"` keeps the source model. The other asserted that an unlisted target is rejected, but it passed only because `model` was an unknown field. It was tightened to require the allowed-model error and a successful listed fork, and then failed as expected.
- `PYTHONPATH=python/src python3 -m unittest discover -s python/tests -p 'test_fork_model.py' -v`: **0/2 passed**. The real Node stdio host exited during startup because the CLI rejected `models`. `sessions.fork()` raised `TypeError: unexpected keyword argument 'model'`.

## GREEN

- Providers accept `models`, a non-empty list of unique names. `model` remains a one-item shorthand, and configuring both fails (`VALIDATION_ERROR` in the engine, `INVALID_CONFIG` in the JSON CLI). `tasks.create` and `sessions.open` admit only listed models.
- `sessions.fork` accepts `model` and `acknowledgeCacheLoss`. A different model requires a configured list, a listed target, runtime `forkModelChange: true` and `acknowledgeCacheLoss: true`, checked in that order before any session is created. The operation result and `session.fork_prepared` carry `modelChange: {fromModel, toModel, promptCacheReuse: false}`. Both new fields enter the idempotency payload, and omitted fields keep the old digest.
- `readRuntimeCapabilities` rejects a non-boolean `forkModelChange` with `INVALID_RUNTIME_CONTRACT`. The fake and Claude adapters declare `true`; Codex declares `false`. `initialize` advertises `sessionLifecycle.forkModel`, and both SDKs require it before sending `model`.
- Dispatch on the fork passes the target model with the source `forkSource` binding. Context limits and pricing apply to the target model through the existing ledger (`CONTEXT_CAPACITY`, `BUDGET_PRICE_UNKNOWN`). Bound tools still cannot name a model or claim an unassigned prepared fork.
- The schema, generated TypeScript/Python wire types and both SDKs changed additively. Python maps `forkModel` to `fork_model`; `operation.result` keeps raw camelCase keys.
- Focused results: **14/14** Node and **2/2** Python. Full Node 24.14.0 suite: **456/456**. Python 3.14.6 suite: **51/51**. Typecheck, formatting, the generated-contract check and `git diff --check` passed. Node 22.18 was not available locally; the CI matrix covers it.

## M05 native evidence

`node scripts/native-gateway-smoke.mjs claude EVIDENCE.json` now configures `models: ["claude-sonnet-4-6", "claude-haiku-4-5"]` for Claude. Through the engine, Unix host and TypeScript SDK, it checks that a fork without acknowledgment fails with `CACHE_LOSS_NOT_ACKNOWLEDGED`. It then forks the completed root session into `claude-haiku-4-5` and runs a task on it. At the gateway, every forked request named `claude-haiku-4-5`. The first request contained the source prompt and assistant turn and the new fork prompt, but not the earlier sibling fork. The fork's native session ID differed from the source, and the source's model, native ID, checkpoint and revision were unchanged. The run passed all seven cases with seven gateway requests ([evidence](0013-native-claude.json)). The Codex smoke with local codex-cli 0.153.4 still passed its six cases. Both runs used synthetic credentials and no paid model.

## Remote CI

The push of `3655cb6` ran [35585440200](https://github.com/masonlee39/Multi-Agent/actions/runs/35585440200): **6/6 jobs passed** on the first run. The four contract jobs covered Ubuntu 24.04 and macOS 14 with Node 22.18.0/Python 3.11 and Node 24.14.0/Python 3.14.6, so the Node 22.18 gap in local verification is closed. The two pinned-native jobs ran the real Claude Agent SDK 0.3.274 and Codex 0.153.4 binaries against the scripted loopback gateway on Ubuntu and macOS, including the new model-changing fork case. This is one sample, not a repeated stability measurement.

## Remaining boundary

This evidence uses scripted gateways. It does not show real-model quality after a model change, real prompt-cache pricing or latency, or an application's user notice. The engine does not estimate inherited history. Callers supply it in `contextEstimate`, and the provider's own context limit remains the final boundary.
