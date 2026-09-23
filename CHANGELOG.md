# Changelog

All notable changes to Orchvia are recorded here. Versions follow [Semantic Versioning](https://semver.org/); before 1.0, a minor version may change the API.

## [Unreleased]

The first release on PyPI and on GitHub Releases. It carries the changes of 0.1.1, which was tagged but not published.

### Fixed

- `close({mode:'interrupt'})` now waits for interrupted turns, at most `timeouts.interruptMs` and half of `timeoutMs`, before it closes the adapters. A Claude turn that reports its interruption in that time is paused with reason `runtime_interrupted`, as documented, instead of ending `outcome_unknown` and quarantined. The cleanup after a stdio host's owner disconnects still closes the adapters at once (SPEC-0022 C).
- The engine's `engineVersion`, the `sdkVersion` that both SDKs send, and the versions that the MCP servers and the Codex client report now follow the release. The builds had rewritten only the package manifests, so these stayed at 0.1.0 (SPEC-0021 P08, P09).

### Added

- `orchvia --version` prints the version of the installed `@orchvia/cli` package (#12).
- A task dispatched again after a failed check sees the failed rule's command, exit status and the end of its output, and `verification.completed` summarizes every rule that ran (SPEC-0022 V).

### Release process

- The release workflow's dry run skips a version that is already on npm, as its npm job does. The tagged release of 0.1.0 had stopped there, because its npm packages had been published by hand first.
- The version lives in one place. `node scripts/set-version.mjs X.Y.Z` writes it to every copy, a test checks that the copies agree, and the release workflow stops unless the tag equals it, the changelog has its section and the tagged commit is on `main` (SPEC-0021 P08, P09).

## [0.1.1] - 2026-09-23

Tagged but not published. Its packages would have reported 0.1.0 in eight places, such as the engine's `engineVersion`, so its release was rejected before publishing (SPEC-0021 D-rel-2). Its changes are listed under the next version.

## [0.1.0] - 2026-09-23

First public release, on npm as `@orchvia/*`. Its tagged release stopped in the dry run, before PyPI and GitHub Releases, so `orchvia` starts on PyPI with the next release.

### Added

- One local engine for Node.js 22.18 and later. SQLite stores tasks, sessions, messages, approvals, events and usage records.
- A TypeScript SDK (`@orchvia/sdk`) and a Python SDK (`orchvia`) with the same API, over an in-process engine, a child process or a Unix socket.
- Runtime adapters for Claude Code (`@orchvia/adapter-claude`) and Codex (`@orchvia/adapter-codex`), and a host with commands (`@orchvia/cli`).
- Sessions that stay warm across tasks: reuse, fork (also to another model of the same provider), compaction, pause, resume and stop.
- Scheduling with dependencies, queues, capacity limits and exclusive write scopes; acceptance by a person or by registered checks; approval of delegations and handoffs; token records per task.
- An optional routing layer with pluggable judges, and `context.checkRefs` to check context references before submitting.

### Changed

- The packages were renamed from the unpublished `@agent-orch/*` and the Python module `agent_orch`, with no aliases. Protocol identifiers did not change: the `agent_orch` MCP server name and its tool names, request digests, and the schema identifier.

Local release candidates 0.1.0-rc.1 to 0.1.0-rc.14 preceded this release; [docs/status.md](docs/status.md#candidate-builds) lists them.
