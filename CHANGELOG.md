# Changelog

All notable changes to Orchvia are recorded here. Versions follow [Semantic Versioning](https://semver.org/); before 1.0, a minor version may change the API.

## [0.1.2] - 2026-09-24

The first release on PyPI and on GitHub Releases. It carries the changes of 0.1.1, which was tagged but not published.

### Fixed

- `close({mode:'interrupt'})` now waits for interrupted turns, at most `timeouts.interruptMs` and half of `timeoutMs`, before it closes the adapters. A Claude turn that reports its interruption in that time is paused with reason `runtime_interrupted`, as documented, instead of ending `outcome_unknown` and quarantined. The cleanup after a stdio host's owner disconnects still closes the adapters at once (SPEC-0022 C).
- The engine's `engineVersion`, the `sdkVersion` that both SDKs send, and the versions that the MCP servers and the Codex client report now follow the release. The builds had rewritten only the package manifests, so these stayed at 0.1.0 (SPEC-0021 P08, P09).
- When the host that the Python SDK started ends before it answers, the error ends with the host's error output, which `error.data["stderrTail"]` holds in full, instead of only `CONNECTION_CLOSED` (SPEC-0023 E01, E02).
- The Python SDK notices that its host exited even while a process the host left behind keeps its output open: pending requests fail within about a second with `CONNECTION_CLOSED` instead of waiting for their timeout, and the SDK closes its ends of the host's pipes (SPEC-0023 E03).
- `orchvia host --socket` handles SIGTERM, SIGINT and SIGHUP before its socket accepts connections, and writes `orchvia listening on` only after that. A signal sent as soon as that line appeared, or while the host was still starting, could end the host at once instead of shutting it down in order (SPEC-0023 S).

### Added

- `orchvia --version` prints the version of the installed `@orchvia/cli` package (#12).
- A task dispatched again after a failed check sees the failed rule's command, exit status and the end of its output, and `verification.completed` summarizes every rule that ran (SPEC-0022 V).
- `processGroupsStopped(context)` in `@orchvia/adapter-claude`, and the `processes` of a stop observer's context, let a host prove that a dispatch's processes and their descendants ended (SPEC-0023 P).

### Changed

- On macOS and Linux each Claude Code process leads its own process group. A forced cleanup signals the whole group, SIGTERM first and SIGKILL when the cleanup window ends, and `orchvia host` shuts down in order on SIGHUP (SPEC-0023 P).

### Release process

- The release workflow's dry run skips a version that is already on npm, as its npm job does. The tagged release of 0.1.0 had stopped there, because its npm packages had been published by hand first.
- The CI and release workflows name every action by its commit, at versions that run on Node.js 24 (SPEC-0023 W).
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
