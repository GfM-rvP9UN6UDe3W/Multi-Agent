# TDD-0021: Open-source readiness

Date: 2026-09-23. Base: `7af317c`. Branch `oss-launch`. Specification: [SPEC-0021](../specs/0021-open-source-readiness.md). This record covers groups G, R and C and the repository rename (N05). Groups N (package names), P, E and L are not implemented yet.

## RED

The tests in `tests/contract/docs.test.ts` were written first and run against the unchanged documentation: `node --test tests/contract/docs.test.ts` failed 5 of 6.

| Test | Failure before the change |
| --- | --- |
| 0021-R01 the README opens with what it is, three reasons, a diagram, a quickstart, a comparison and the status | No `# Orchvia` title, reasons, diagram or the three sections |
| 0021-R02 0021-R06 0021-R08 no release evidence, price or paid judge, within 15 KB | The README was 46,486 bytes, and cited test counts, CI runs, candidate versions, a price and the paid judge |
| 0021-R03 no internal term in the README; `docs/concepts.md` explains them | The README used A/Q/R and other internal terms; `docs/concepts.md` did not exist |
| 0021-R05 the README embeds a diagram of at most 400 KB | No embedded image; the two diagrams were 1.4 MB and 1.1 MB |
| 0021-R09 no repository file names a downstream product | 24 files: 23 tracked Markdown files, and the draft of SPEC-0021 itself |

0021-R04 (every relative link resolves) passed before the change. It guards the move of the design document, the guide and the diagrams, which rewrote 136 links.

The test for the offline quickstart (0021-R01, second test) was written with the example, so it has no failing run of its own; mutation 9 below shows that it detects a quickstart that does not reuse the session.

## Changes

- **README:** rewritten for a first-time reader, 5,384 bytes: one sentence, three reasons, the diagram, a quickstart, a comparison, what it does, status and links. Package names in the README follow the release plan; the packages are not published yet, and the README says so.
- **Quickstart:** `examples/typescript/quickstart.ts` runs two tasks with the fake runtime; the second reuses the first agent's session. The engine setting `allowCrossRootReuse` makes the second request eligible to reuse it.
- **Documentation moved under `docs/`:** the design document to `docs/design.md`, the guide to `docs/guide.md`, and the diagrams to `docs/images/` as JPEG files of 369 KB and 243 KB. A script rewrote the relative links in every Markdown file; links inside code blocks were left alone.
- **New pages:**
  - `docs/reference.md`: the detailed part of the old README. The candidate-specific install steps became build-from-source steps; the price of the hosted judge was removed; writing your own judge now comes first.
  - `docs/status.md`: verification record, candidate history, the specification index and the runtime baselines.
  - `docs/concepts.md`: every internal term, in plain words first.
- **Internal names:** removed from 24 files and replaced with neutral descriptions. Branch names were replaced by the pull requests that carried them. The check stores only SHA-256 digests of the names. Git history is unchanged.
- **Agent instructions:** `CLAUDE.md` moved to `.claude/CLAUDE.md`. The Claude Code documentation says a project's instructions may be stored in either place (checked on 2026-09-23). `AGENTS.md` stays at the root. Both were updated for the new layout and the renamed repository.
- **Comparison (R07):** each cell rests on the other project's own documentation, checked on 2026-09-23: LangGraph persistence, CrewAI processes, OpenAI Agents SDK handoffs, the Microsoft Agent Framework overview and Claude Code subagents.

## Repository page and rename

On 2026-09-23, with the owner's go-ahead:

- the npm organization `orchvia` exists (the owner registered it; the registry answers 200 for it);
- the repository was renamed from `Multi-Agent` to `orchvia` in its settings; it kept its 19 stars, and the old URL answers 301 to the new one;
- the description and the six topics of G01 and G02 were set;
- the local remote now points to `git@github.com:masonlee39/orchvia.git`, which the worktrees share, and `git ls-remote` reads `main`.

## GREEN

- `node --test tests/contract/docs.test.ts`: 7 of 7 passed.
- `npm test`: 564 passed, none failed or skipped. That is 557 before, plus the seven documentation tests.
- `PYTHONDONTWRITEBYTECODE=1 npm run test:python`: 79 passed.
- `npm run typecheck`, `npm run format:check`, `npm run check:generated` and `git diff --check` passed.
- `PYTHONPATH=python/src python3 examples/python/fake_roundtrip.py` completed, as the README says.

## Mutation checks

Each change was made in turn, the matching test was run, and the file was restored:

| Mutation | Result |
| --- | --- |
| A test count in the README | caught (R02) |
| A candidate version in the README | caught (R02) |
| A price in the README | caught (R06) |
| The status heading renamed | caught (R01) |
| An internal term in the README | caught (R03) |
| A term missing from `docs/concepts.md` | caught (R03) |
| A broken relative link | caught (R04) |
| An internal name in a document | caught (R09) |
| The quickstart starting a fresh session | caught (R01) |
| An embedded image over 400 KB | caught (R05) |

## Not done or not verified

- R06: the documents do not yet state the project's relationship to TypeSafe; the owner has not confirmed it.
- R10: the READMEs inside the npm packages and the PyPI description still say "unpublished". They change with the packaging work (P).
- R01: the quickstart variant with real Claude waits for E01 and E02.
- The diagram in the README is the existing detailed one. A simpler overview may suit first-time readers better; that is a judgment, not a failing check.
- Old links: GitHub redirects the old repository URL. Historical records keep their original URLs.
- Remote branches named after the downstream product still exist on GitHub; deleting them needs the owner's word.
