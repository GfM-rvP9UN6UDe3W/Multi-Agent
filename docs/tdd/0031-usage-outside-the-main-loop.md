# TDD-0031: Usage outside the main loop

Date: 2026-09-27. Base: `54ca5ff` (0.1.7, its release record and SPEC-0021 P10 on `main`). Specification: [SPEC-0031](../specs/0031-usage-outside-the-main-loop.md).

## Reproduction

Before the specification, a scratch script ran the real Claude Code binary of SDK 0.3.274 against a scripted loopback gateway, which answered each kind of call with its own token counts.

- A plain turn: the result's `usage` and `modelUsage` both held 100 input, 20 output, 5 cache-read and 12 cache-write tokens, under the key `claude-sonnet-4-6`, which was also the dispatch's model and the entry's `canonicalModel`. The engine recorded them.
- `sessions.compact`: the result's `usage` held four zeros and `num_turns` 0, while `modelUsage` held the compaction's 7,000 input, 700 output and 300 cache-write tokens. The engine recorded four zeros.
- A dispatch whose first call reported an almost full context: Claude Code compacted before its next call. `usage` held only the main loop, while `modelUsage` held the compactions too, and the engine recorded only the main loop.

## RED

The new tests ran on the base, which had only the new tests, the script and the specification.

- `tests/contract/claude-outside-usage.test.ts`: 4 of 5 failed; the adapter reported no observation besides the main loop's. `0031-A01 0031-A05`, which expects exactly that, passed.
- `tests/engine/usage-models.test.ts`, 4 of 4 failed. The engine refused an observation that named its model with `INVALID_RUNTIME_CONTRACT`, so a runtime that named one never delivered.
- `scripts/native-usage-smoke.mjs` failed at C02: the dispatch that Claude Code compacted had only the record of its main loop, 191,000 input, 50 output, 5 cache-read and 12 cache-write tokens, and no record of the compaction.

## Changes

- **The Claude adapter (A).** `outsideUsage` reads the `modelUsage` of the result whose `usage` it already takes, finds the main model and reports one observation per model for its calls outside the main loop, or an observation with unknown counts. The adapter reports them through `reportUsage` right after the main loop's observation, and yields them after it, before the terminal.
- **The engine (B).**
  - `usageRecord` accepts `model`, 1 to 256 characters.
  - `recordUsage` gives a record the model the observation names, else the session's. It compares a repeated observation without the model, and then its resolved model with the record's.
  - The cost ledger prices a record of another model at that model's registered price, when the dispatch was priced and the currency is the same; otherwise it leaves the cost unknown, so the reservation stays held.
- **The real binary (C).**
  - `scripts/native-usage-smoke.mjs` runs both paths against a scripted gateway.
  - The pinned native protocol job in `offline.yml` runs it.
- The schema's descriptions of `UsageRecord` and `UsageRecordedData` say whose model a record holds; no field changed.

Found on the way:

- The downstream host reviewed the design and asked for three changes, all adopted before the tests:
  - the main model's calls keep the dispatch's model, so that one model makes one row in the totals;
  - a compaction in the middle of a dispatch is an acceptance path;
  - the timing invariants say what the subtraction compares.
- **B02 changed while it was implemented.** It first required a repeated observation to name the same model or again none. A record does not keep whether its observation named the model, so B02 now compares the model that the repeat resolves to.
- **The gateway triggers the compaction through the context size.** The host suggested `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. The gateway reports an almost full context for the first call instead, which makes Claude Code compact before its next call, with the real model name.
- **The first adapter test found the main model by `canonicalModel` only where it was the only key,** which the last rule finds anyway. A second test puts another model beside it.

## GREEN

- The new tests passed: `tests/contract/claude-outside-usage.test.ts` 5 of 5, and `tests/engine/usage-models.test.ts` 4 of 4.
- `scripts/native-usage-smoke.mjs` passed three times in a row. In the dispatch that Claude Code compacted, the gateway saw a read, a compaction and an answer, and the engine recorded both of these:
  - the main loop: 191,000 input, 50 output, 5 cache-read and 12 cache-write tokens;
  - the compaction: 7,000 input, 700 output and 300 cache-write tokens.

  Both records are under `claude-sonnet-4-6`. The `sessions.compact` dispatch recorded four zeros for its main loop and the compaction's call beside them.
- `npm test`: 736 of 736 (727 before). `npm run test:python`: 102 of 102.
- `npm run typecheck`, `npm run format:check` and `npm run check:generated` (82 definitions) passed.
- `npm run build:packages`, `scripts/build-python.py` with the pinned build tools and `npm run test:packages`: nine installation and bundle modes passed.
- Six new and affected test files, eight runs each with eight at a time: 48 of 48 passed.

## Mutation checks

Each mutation was applied alone, and the tests named were run; all 18 were caught.

| Mutation | Result |
| --- | --- |
| No observation outside the main loop | caught by `0031-A02` |
| The main loop is not subtracted | caught by `0031-A01`, `0031-A02` |
| The main model is named by its canonical model | caught by `0031-A02 0031-A03` |
| Another model is named by its key | caught by `0031-A02 0031-A03` |
| A remainder of four zeros is reported | caught by `0031-A01 0031-A05` |
| The canonical model does not find the main model | caught by `0031-A02 0031-A03`, after the second test above |
| The first key is taken for the main model | caught by `0031-A04` |
| A negative remainder becomes zero | caught by `0031-A04` |
| A missing count becomes zero | caught by `0031-A04` |
| The observations are only reported, not yielded | caught by the adapter tests' comparison |
| The observations are only yielded, not reported | caught by the adapter tests' comparison |
| A long key is not digested | caught by `0031-A02` |
| The engine refuses a named model | caught by `0031-B01` to `0031-B03` |
| The engine accepts any model | caught by `0031-B01` |
| The record keeps the session's model | caught by `0031-B01` to `0031-B03` |
| A repeat ignores the model | caught by `0031-B02` |
| Every record is priced at the dispatch's model | caught by `0031-B03` |
| Another currency prices a record | caught by `0031-B03` |

## Not verified

- **Real models.** Only the scripted gateway ran, so it is not known how many tokens real dispatches lost.
- **A Task subagent through the real binary.** The adapter's default tools do not include Task; a scripted result with two models covers A03.
- **Which cache duration Claude Code gives a compaction.** `modelUsage` has no split.
