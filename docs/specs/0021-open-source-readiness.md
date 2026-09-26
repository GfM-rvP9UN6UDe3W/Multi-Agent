# SPEC-0021: Open-source readiness

Date: 2026-09-23. Status: approved by the owner on 2026-09-23, with D-oss-1 to D-oss-4 each set to option 1. G, R and C and the repository rename (N05) were merged in pull request #10. The rename (N), P01 to P03, P05, P06, R06, R10 and L03 were merged in pull request #11 (`f331930`); P04 passed with the first release, 0.1.2, on 2026-09-24, and with every release since; TDD-0021 records each. On 2026-09-27 the owner chose D-rel-3, which P10 implements. E01, E03 and E04 were merged in pull request #17 (`0b36181`). E02, E05 and E06 are not run: on 2026-09-23 the owner decided against paid model runs for now. On 2026-09-23 the owner published the five npm packages as 0.1.0, and npm trusted publishing and approval of releases in GitHub were set up (D-oss-13); The tagged release of 0.1.0 stopped in its dry run, before publishing anything (D-rel-1). With the dry run corrected, 0.1.1 was tagged, but its release was rejected before publishing, because its packages would have reported version 0.1.0 in eight places (D-rel-2). P08 and P09 keep one version everywhere (D-ver-1); 0.1.2, the first release on PyPI and GitHub Releases, was published on 2026-09-24 after the owner approved it, and P04 passed with it. L01, L02 and L04 are not implemented yet. The maintainer implemented L03's three good first issues: #12 as P07, #13 as R12 and #14 as R11, which keeps the outside contributor's commit. Evidence: [TDD-0021](../tdd/0021-open-source-readiness.md). The owner asked for one plan that answers an outside assessment of why the public repository draws little attention. The owner chose the name Orchvia (D-oss-5). The project has no relationship with TypeSafe. It supersedes no specification. It changes packaging ([SPEC-0010](0010-bundled-host-delivery.md), [SPEC-0011](0011-release-readiness.md)) and the documentation layout, not the engine.

## Why

The repository became public on 2026-09-19. A reader who arrives cannot tell what it is, and cannot install it.

- **Nothing is published.**
  - `@agent-orch/sdk` does not exist on npm. Installing means building tarballs and installing them by absolute path.
  - `scripts/build-packages.mjs` marks every generated package `private: true`, so npm would refuse to publish the packages as built.
- **The first screen of the README is release evidence.**
  - It shows license terms, the ESM-only notice, "not published", test counts, CI run ids, commit hashes and SPEC numbers.
  - Some of it is stale: it cites 442 Node and 49 Python tests (557 and 79 today) and names rc.7 as the current handoff (rc.14 exists).
  - It states no problem it solves, embeds neither diagram, and every example uses the fake runtime.
- **It never says why to choose it.**
  - Nothing compares it with LLM orchestration frameworks or with running several coding-agent sessions by hand.
  - The repository description says speed and cost are "measured, not assumed", while the README lists economic benefit and real-model acceptance as unverified.
- **Three names.**
  - The repository is `Multi-Agent`, the title "Agent Orchestration SDK" and the packages `@agent-orch/*`.
  - The unscoped npm package `agent-orch` belongs to an unrelated multi-agent CLI orchestrator (0.5.45). It installs a command named `agent-orch`, the same command our CLI package installs.
  - An npm organization or user named `agent-orch` already exists, so the `@agent-orch` scope cannot be registered unless it is the owner's.
  - No topics or homepage are set.
- **Size and vocabulary.**
  - The root holds a 46 KB README, a 104 KB design document, a 77 KB wiring guide, two diagrams of 2.6 MB together, and agent instruction files.
  - Internal terms appear unexplained: A/Q/R, quarantine, `outcome_unknown`, owner attestation.
- **Internal names.** The names of a downstream product and of its ledger appear in 23 tracked Markdown files; no source or test file contains them. They also appear in 4 commit messages, 4 remote branch names and the public rc.14 release archive.
- **A paid default.** The routing example's default judge is a paid external service, shown with its price.

## Environments

- Documentation: GitHub's Markdown renderer, and the npm and PyPI package pages.
- Packages: the npm registry and PyPI. Platforms as in the existing CI matrix: macOS on Apple silicon and Intel, and Linux; Node 22.18 and 24.14; Python 3.11 to 3.14. Windows stays unverified and is stated as such.
- Real-model runs happen only on the owner's machine, with the owner's accounts.

## Acceptance criteria

### G: Repository page (no code)

- **G01** The repository description says what the project does and makes no claim that has not been measured. It changes only with the owner's authorization.
- **G02** Topics: `multi-agent`, `claude-code`, `codex`, `orchestration`, `mcp`, `agents`. A homepage is set once a package page or documentation site exists.

### R: README and documentation (documentation only)

- **R01** The README opens with, in this order:
  1. one sentence: what it is, and for whom;
  2. three reasons to use it;
  3. one diagram;
  4. a quickstart, in two variants: offline with the fake runtime (no account needed) and with real Claude (E01, E02);
  5. the comparison (R07);
  6. a status paragraph: alpha, the supported platforms, and what is and is not verified, linking to R02.
- **R02** Test counts, CI run ids, commit hashes, SPEC coverage and candidate history move to `docs/status.md`. A test checks that the README matches no test-count, run-id or candidate-version pattern.
- **R03** `docs/concepts.md` explains every internal term that the README or the guide uses, in plain words first. The README uses none without explanation.
- **R04** The design document, the wiring guide and the diagrams move under `docs/`. A test checks that every relative link in tracked Markdown resolves.
- **R05** One diagram is embedded in the README. Each embedded image is at most 400 KB and legible at 900 px wide.
- **R06** The README names no paid service and no price. The guide documents Jev as one optional judge, next to writing your own, and states the project's relationship to its vendor, which the owner confirms.
- **R07** The comparison covers two groups:
  - LLM orchestration frameworks: LangGraph, CrewAI, OpenAI Agents SDK, and AutoGen or Microsoft Agent Framework;
  - ways to run several coding agents: Claude Code subagents, and several sessions by hand or with a session manager.
  - Each cell cites the other project's own documentation, checked on the day it is written. No cell judges quality.
- **R08** The README is at most 15 KB, checked by the R02 test.
- **R09** Internal names follow D-oss-2. With option 1, no tracked file contains them, checked by a test that stores only hashes of the names. Git history is not rewritten.
- **R10** The README that each generated npm package carries, and the PyPI description, describe the published package, link to the repository, and no longer say "unpublished".
- **R11** The README's diagram is a simple overview for a first-time reader (issue #14): the application, the engine with its SQLite state, the Claude Code and Codex sessions, and the acceptance of each result. The detailed diagram stays in the design document, at the start of its architecture section.
  - Every text takes its font from a CSS class or from the `font-family`, `font-size` and `font-weight` attributes. SVG has no `font` attribute, and browsers ignore it.
  - No text is smaller than 16 px, and the viewBox is at most 1,200 wide, so the smallest text is at least 12 px when the image is shown 900 px wide (R05).
  - The mailbox is drawn inside the engine, as part of its SQLite state, and the sessions message each other through it. Results leave the sessions, not the mailbox.
  - The banner, the SVG's description and the README's alternative text say that a person or a registered check accepts each result, as the README's third reason does.
  - A test checks the fonts, the sizes and the wording; the drawing is checked by eye on a rendering.
- **R12** The offline quickstart also runs from Python (issue #13). `examples/python/quickstart.py` starts the Node host from the checkout with `Orchestrator.local`, runs the same two tasks with the fake runtime, accepts each result and prints the same three lines; the second task reuses the first one's session. The README's quickstart gives its command, and a test runs it next to the TypeScript quickstart.
  - The test gives the example a 4 KiB emergency reserve with `--emergency-bytes 4096`: the host it starts runs from `packages/cli/`, not from `examples/`, so the reserve guard of SPEC-0011 R10 applies to it. A reader's run keeps the engine's default.

### C: Agent instruction files (D-oss-2)

- **C01** With D-oss-2 option 1:
  - `CLAUDE.md` is rewritten for outside contributors. It moves to `.claude/CLAUDE.md` only if Claude Code is verified to load it from there; otherwise it stays at the root.
  - `AGENTS.md` stays at the root, where Codex and other tools look for it, and is cleaned the same way.

### N: One name (D-oss-1)

- **N01** The repository, the README title, the npm scope or names, the PyPI project, the Python import name and the CLI command use one name.
- **N02** No existing npm package has that name, and the CLI command is not `agent-orch`. Both are checked against the registry when the name is chosen.
- **N03** No aliases (D-oss-10): the old npm names were never published, and the old Python import `agent_orch` is removed. A migration table in the changelog and in the release notice maps each old name to the new one, for existing consumers such as the downstream host.
- **N04** Behavior does not change. The full Node and Python suites and the nine package modes pass before and after the rename, with the same test counts.
- **N05** The GitHub rename keeps the old URL redirecting, and the local remotes are updated.
- **N06** Protocol identifiers do not change with the name, because stored data and native histories contain them: the MCP server name `agent_orch` and its tool names `mcp__agent_orch__<tool>`, the request digest prefix `agent-orch-request-v1:`, the schema identifier `urn:agent-orch:protocol:2.0`, and the bridge variables `AGENT_ORCH_BRIDGE_*`. A test fixes a request digest in both languages and each identifier.

### P: Publishing (packaging code; the design is reviewed before any code)

- **P01** The build produces publishable packages:
  - not `private`, and scoped packages publish with public access;
  - `repository`, `homepage` and `bugs` point at the repository under its N01 name;
  - the CLI's `bin` uses the N01 name.
  - A test inspects the generated `package.json` files.
- **P02** A release workflow runs only on a version tag:
  1. the full offline suite on the CI matrix;
  2. one build of every package from the tag, with the hashes recorded;
  3. npm publishing with provenance, in dependency order: engine, then the adapters and sdk, then cli. A version that already exists on the registry is skipped;
  4. PyPI publishing through trusted publishing;
  5. a GitHub Release with the archives and their hashes.
  - No token is stored in the repository.
- **P03** Every pull request that touches packaging runs the same workflow without publishing: `npm publish --dry-run` for each package, and a metadata check of the wheel and sdist.
- **P04** After publishing, a job on fresh macOS and Linux runners installs the packages from the registries, with no repository checkout. It runs the offline quickstart and the Python managed-host example. If either fails, the release is not announced.
- **P05** Versions follow D-oss-3:
  - public releases follow semver from 0.1.0;
  - pre-releases go to npm's `next` tag and to PyPI as pre-releases;
  - `CHANGELOG.md` records every public version;
  - the local rc series ends.
- **P06** The owner's one-time account steps are an SOP in `docs/release/publishing.md`, pasted to the owner in full:
  - the npm organization or user, with two-factor authentication;
  - a first manual publish, if the registry requires a package to exist before trusted publishing can be configured;
  - the PyPI pending publisher;
  - GitHub environment protection for the release workflow.
- **P07** `orchvia --version` prints the version in the `package.json` of the installed `@orchvia/cli`, followed by a newline, and exits with 0 (issue #12). `orchvia --help` lists it.
  - The CLI reads the file only when asked, at `../package.json` next to its running module: `packages/cli/package.json` in a checkout, and the package's own `package.json` when the built `dist/main.js` runs. A release build writes the released version into the package it builds, so a checkout prints the version its source manifest holds.
  - There is no `-v`: the command line has no short options, and many tools use `-v` for verbose output.
  - A test runs it from the source; the package smoke runs it from the installed package.
- **P08** One version number (D-ver-1). The `version` in the root `package.json` is the only copy anyone edits, and only with `node scripts/set-version.mjs X.Y.Z`. The script writes it to every other copy: the five package manifests, `package-lock.json`, `packages/engine/src/version.ts`, `python/pyproject.toml` and `python/src/orchvia/_version.py`, the Python copies in PEP 440 spelling (`0.2.0rc1` for `0.2.0-rc.1`).
  - Code takes the version from `version.ts` or `_version.py`: the engine's `engineVersion`, the `sdkVersion` that the TypeScript and Python SDKs send, `orchvia.__version__`, and the versions that the MCP servers and the Codex client report. The CLI's `--version` reads its own `package.json` (P07). No other version is written in package source.
  - `main` holds the latest released version, or the version that a release pull request is about to tag, so `CHANGELOG.md` always has a section for it.
  - A test checks every copy, that package source holds no other version, the engine's reported version and the changelog section.
- **P09** A release reports its version everywhere (D-ver-1, D-rel-2).
  - A build without `--version` uses the source version. With `--version`, as a pull request's dry run uses, it also rewrites the built `version.js` and `_version.py`, so the throwaway packages are consistent too.
  - The release workflow stops when the tag differs from the source version, when the changelog has no section for it, or when the tagged commit is not on `main`.
  - The package smoke and the registry check require the installed packages to report the release version: `orchvia --version`, the engine's `engineVersion`, and in Python `orchvia.__version__` and the SDK's `sdkVersion`.
- **P10** No document names the latest release, which GitHub Releases does (D-rel-3). A release pull request also records the release before it, whose facts exist only after that release's run: `docs/status.md` and TDD-0021, as `docs/release/publishing.md` step 1 says. Other documents describe the releases in words that do not change with each one. A test fails on a sentence that states which version is published or latest.

### E: Real-model evidence (new code outside the engine; paid runs only on the owner's account, within D-oss-11)

- **E01** The real-Claude quickstart runs in CI against the real Claude Code binary and the existing scripted loopback gateway, with synthetic credentials and no model call.
- **E02** The same quickstart runs once on the owner's machine with the owner's Claude Code account. Its output, trimmed, becomes the README's sample output, with the date and model.
- **E03** The benchmark design, as approved with D-oss-10:
  - one small JavaScript project and four related requests on two independent tracks, each request with a hidden automatic check that lives outside the agent's workspace, plus the track's own tests;
  - three arms: one Claude session that does every request in order; a new Claude session for each request; Orchvia, with the two tracks at the same time and each follow-up on its track's warm session;
  - every arm runs the same model, the same Claude Code build (the one bundled with the Agent SDK), the same tools, no user or project settings, and the operating-system sandbox of the engine's writable Claude profile;
  - metrics: input, output, cache-read and cache-write tokens; wall time; estimated cost at list prices; pass rate. The harness is the reviewer, so no person intervenes;
  - three repetitions per arm; each report records the model, the prices, the machine, and the Agent SDK and Claude Code versions.
- **E04** The harness lives in `bench/`. `npm test` runs every arm without a model call: reference solutions stand in for the agent's edits, and a request whose solution is left out must fail its checks. CI also runs every arm with the real Claude Code binary against a scripted loopback model, which must pass every request.
- **E05** A pilot, with one repetition per arm, measures what a full run costs, within D-oss-11's $10. The harness stops before the next request once its estimate reaches the limit.
- **E06** The full run stays within D-oss-11's $50. Raw results and the exact commands are committed, and the README's numbers link to them. Results are published whether or not they favor the engine.
- **E07** Until E06 exists, the README and the repository description say speed and cost can be measured, not that they are better.

### L: Launch (drafts only; the owner posts)

- **L01** Launch starts only after P04 has passed and E06 exists, unless the owner decides to launch without E06.
- **L02** Drafts:
  - a Show HN post;
  - posts for r/ClaudeAI and r/ChatGPTCoding;
  - one article built on the benchmark.
  - Communities about local models are not targeted: the engine runs no local model.
- **L03** Community files: issue and pull request templates, `SECURITY.md`, a `CONTRIBUTING.md` updated for outside contributors, and three "good first issue" items. The maintainer implemented all three: #12 as P07, #13 as R12 and #14 as R11. #14 keeps the outside contributor's commit from pull request #15, merged unchanged; the corrections follow in a separate commit.
- **L04** A social preview image and a short terminal recording of the quickstart.

## Timing invariants

- The release pipeline builds each version once. A retry publishes the recorded bytes. A version already on a registry is never rebuilt or overwritten.
- npm packages publish in dependency order, so no published version depends on a version that is missing. A failure part-way leaves the earlier packages published, and the rerun continues from the first missing one.
- The GitHub Release is created last, after both registries have the version.

## Order

1. G.
2. R and C.
3. N and P.
4. E. The harness may be written during step 3.
5. L.

Each public action waits for the owner's explicit authorization: renaming, changing settings, publishing and posting.

## Owner decisions (2026-09-23)

- **D-oss-1, the name:** a new name everywhere (option 1).
- **D-oss-5, which name:** Orchvia. On 2026-09-23 `orchvia` was free on npm (unscoped and as a scope), on PyPI and as a GitHub user or organization, and no npm package installs an `orchvia` command. The domain orchvia.com was registered on 2026-08-22 by an unknown holder. A web search for the name returns OrchVis, a 2025 research paper on multi-agent orchestration with human oversight. The names:

  | Use | Before | After |
  | --- | --- | --- |
  | Repository | `masonlee39/Multi-Agent` | `masonlee39/orchvia` |
  | README title | Agent Orchestration SDK | Orchvia |
  | npm packages | `@agent-orch/{sdk,engine,adapter-claude,adapter-codex,cli}` | `@orchvia/{sdk,engine,adapter-claude,adapter-codex,cli}` |
  | CLI command | `agent-orch` | `orchvia` |
  | PyPI project | `agent-orch` (never published) | `orchvia` |
  | Python import | `agent_orch` | `orchvia`, with no alias (N03) |

  The npm organization is registered before the repository is renamed, because the rename makes the name public ([owner steps](../release/publishing.md)).
- **D-oss-2, internal names:** remove them from current files and keep history (option 1).
- **D-oss-3, versions:** publish 0.1.0 as `latest` (option 1).
- **D-oss-4, evidence:** a pilot, then the full benchmark (option 1).
- **Facts from the owner:** the project has no relationship with TypeSafe (R06); orchvia.com is not the owner's, so the homepage is the npm package page; the owner had no PyPI account.
- **D-oss-10, the plan:** everything that can be done now is done now: no compatibility layer for the old names, protocol identifiers kept for good, and every step the maintainer may do is done by the maintainer. The owner does only what needs the owner's identity or money: npm and PyPI sign-in and two-factor confirmation, the PyPI account, the model budget, and forwarding the notice to the downstream host.
- **D-oss-11, the model budget:** a pilot of at most $10 and a full run of at most $50, on the owner's local Claude Code account; the run stops and asks when a limit would be passed. On 2026-09-23 the owner decided against paid runs for now, so E02, E05 and E06 wait until the owner funds them.
- **D-oss-12, the first npm publish:** now, before PyPI can be used (option 1). The npm pages become public before the PyPI release and the GitHub Release, and the package READMEs link to a PyPI page that does not exist yet.
- **D-oss-13, how CI publishes to npm:** option 3. The npm trusted publisher of each package may publish directly, which npm marks "not recommended" (its default allows only staged publishing that a maintainer approves on npmjs.com). The human approval is in GitHub instead: the environments `npm` and `pypi` require the owner's approval, and administrators cannot bypass it. The alternatives were staged publishing only, which changes the release workflow and needs the owner's approval on npmjs.com for each package, and direct publishing with no human approval.
- **D-npm-1, npm publishing access:** option 1, unchanged. Every settings change on npmjs.com needs the owner's security key, and the project uses no tokens that bypass two-factor authentication.
- **D-rel-1, after the failed 0.1.0 release run:** option 1. The dry run skips versions already on npm, and 0.1.1 is the first full release; 0.1.0 stays on npm only, and its tag stays. The alternative was moving the `v0.1.0` tag to a release branch with only the workflow fix. D-rel-2 later stopped 0.1.1 itself.
- **D-rel-2, the tagged 0.1.1:** option 2, do not publish it. Its packages would have reported 0.1.0 in eight places, because the build rewrote only the manifests: the engine's `engineVersion`, the `sdkVersion` that both SDKs send (three places), and the versions of both MCP servers and of the Codex client (four places). A published version cannot be corrected. The owner rejected its deployment; 0.1.2 is the first release on PyPI and GitHub Releases. The alternative was publishing 0.1.1 and correcting the versions in 0.1.2.
- **D-rel-3, recording a release (2026-09-27):** option 3. No document names the latest release, and each release pull request records the release before it (P10). Up to 0.1.7 a pull request after each release recorded it in seven files, which cost a pull request, a CI run and a reply from the owner per release. The alternative, recording each release in the next release pull request while the guide still named the latest version, would have left the guide wrong between releases.
- **D-ver-1, where the version lives:** option 1, in the source (P08, P09). A release pull request sets it, and the tag must match it. The alternative was a placeholder `0.0.0-dev` in the source that the build replaces with the tag, which leaves a checkout of a tag without its version and ships the placeholder if one copy is missed.
- **D-bench-1, the orchvia arm's stop proof:** option 1. The dispatch's own Claude process must have exited, and every process that still uses the shared workspace must descend from the harness; errors never prove a stop. The alternatives were a workspace per track, which is not how a team shares a repository, and running the tracks one after the other, which removes the parallelism the benchmark measures.

## Boundaries

- No engine, protocol or storage behavior changes. The rename changes names only.
- The Python package still needs Node and the CLI package. Bundling the host into the wheel is out of scope.
- Git history is not rewritten unless D-oss-2 is 3. Under options 1 and 2, the internal names stay visible in old commits, old pull requests and the rc.14 release archive.
- No paid model call is made except the runs of E02, E05 and E06 on the owner's account, within D-oss-11's limits.

## Rollback

- Documentation changes are reverted as commits.
- A repository rename can be undone in the settings, and GitHub keeps redirecting the old URL.
- A published version number can never be reused. npm allows unpublishing only under narrow conditions, for example within 72 hours; otherwise a version can only be deprecated. A PyPI release can be yanked. So the P03 dry runs and the P04 check come before the first real publish.
