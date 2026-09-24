# Repository Guidelines

## Project Structure & Module Organization

Orchvia uses one Node.js engine for scheduling and SQLite persistence; Python connects to that host rather than implementing another engine.

- `packages/engine/`: orchestration, storage, types, and deterministic fake runtime.
- `packages/sdk-typescript/`, `packages/cli/`: TypeScript client and local host/CLI.
- `packages/adapter-claude/`, `packages/adapter-codex/`: provider adapters.
- `python/src/orchvia/`: async Python SDK; `python/tests/`: Python tests.
- `tests/engine/`, `tests/contract/`, `tests/fixtures/`: engine tests, integration/contract tests, and subprocess fixtures.
- `schemas/`: wire schema; `examples/`: runnable examples; `docs/specs/` and `docs/tdd/`: acceptance contracts and verification evidence; `docs/`: guide, reference, concepts, design and status; `docs/images/`: diagrams.

## Build, Test, and Development Commands

Use Node.js 22.18+ and Python 3.11+. Run from the repository root:

- `npm ci --ignore-scripts`: install locked development dependencies.
- `npm run typecheck`: check strict TypeScript without emitting files.
- `npm run format:check`: check configured TypeScript/JSON paths with Prettier.
- `npm test`: run Node engine and contract suites.
- `npm run test:python`: run Python unittest discovery.
- `npm run cli -- --help`: inspect available CLI commands.
- `node scripts/set-version.mjs X.Y.Z`: the only way to change the version; it writes every copy (SPEC-0021 P08).
- `PYTHONPATH=python/src python3 examples/python/fake_roundtrip.py`: run the offline Python-to-Node example.

Source development executes erasable TypeScript directly. `npm run build:packages` emits locally installable JavaScript/declaration tarballs; `npm run check:generated` verifies the generated protocol contract. Python wheel/sdist and clean-install commands are documented in `docs/reference.md`.

## Coding Style & Naming Conventions

Follow `.prettierrc.json`: two-space indentation, single quotes, semicolons, trailing commas, and 100-column print width. Use ESM with explicit `.ts` imports, camelCase functions/variables, and PascalCase types/classes. Avoid TypeScript syntax requiring compilation. Python uses four-space indentation, snake_case functions/fields, and PascalCase classes; runtime dependencies remain standard-library-only. No separate lint command is configured.

## Testing Guidelines

Follow `CONTRIBUTING.md`: define numbered spec acceptance criteria, record meaningful RED/GREEN evidence, implement, and update documentation. Use `node:test` with `*.test.ts` and Python `unittest` with `test_*.py`. No numerical coverage threshold is configured.

Test observable behavior and relevant failure paths. Wire or lifecycle changes require both suites and actual subprocess integration. Use temporary workspaces/state directories and explicit fake providers. Give each test engine a 4 KiB emergency reserve (`storage: { emergencyBytes: 4096 }`); `npm test` and `npm run test:python` fail any process that would write a larger one, except the runnable examples. Unix-socket tests require local IPC permissions; skipped tests are not passes. Offline fixtures do not establish real-model acceptance.

## Commit & Pull Request Guidelines

Use concise, imperative, scoped messages, such as `engine: preserve dispatch deadlines`. Keep changes focused. PRs should describe behavior, link relevant specs/issues, report validation commands/results, and identify unverified boundaries.

## Security & Configuration

Keep private state outside the workspace. Never read login credentials or invoke paid models in ordinary tests. Preserve unknown outcomes without blind retries. Publishing packages and real-provider acceptance require the maintainer's separate authorization.
