# TDD-0021: Open-source readiness

Date: 2026-09-23. Base: `7af317c`. Branch `oss-launch`. Specification: [SPEC-0021](../specs/0021-open-source-readiness.md). This record covers groups G, R and C and the repository rename (merged as pull request #10), then the package rename (N) and publishing (P) on branch `orchvia-rename` (pull request #11), then the real-model evidence (E) on branch `bench-and-claude-quickstart`. L is recorded when it is done.

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

- R06: at this point the documents did not state the relationship to TypeSafe; the rename branch below adds it, after the owner confirmed there is none.
- R10: at this point the package READMEs and the PyPI description still said "unpublished"; the rename branch below replaces them.
- R01: the quickstart variant with real Claude was added with E01 below; its sample output waits for E02.
- The diagram in the README is the existing detailed one. A simpler overview may suit first-time readers better; that is a judgment, not a failing check.
- Old links: GitHub redirects the old repository URL. Historical records keep their original URLs.
- Remote branches named after the downstream product still existed on GitHub; the owner approved deleting them with the plan (D-oss-10).
- After pull request #10 merged, one CI job on Ubuntu with Node 24 failed 0011-R03 once: the host did not exit within 3 seconds of its shutdown request. 24 local runs under CPU load passed, and the rerun passed. The timing is followed up separately.

## Package rename and publishing (N, P)

Base: `702a3d7`. Branch `orchvia-rename`, merged as pull request #11 (`f331930`).

### RED

- `node --test tests/contract/naming.test.ts`: 2 of 3 failed. 0021-N01 found the packages named `@agent-orch/*`, the command `agent-orch` and the Python distribution `agent-orch`. 0021-N02 found the old names in current files. 0021-N06 passed: it fixes identifiers that were already right, as a guard for the rename.
- `python/tests/test_naming.py`: both tests stopped with `ModuleNotFoundError: No module named 'orchvia'`. That only shows the new module did not exist yet; it is not counted as a defect.
- The golden request digest `1c80623d…dc42` was computed at the base in both languages before any change, and the tests assert it afterwards.

### Changes

- `python/src/agent_orch` moved to `python/src/orchvia`. A script renamed the package names, imports, the command, file names and temporary-directory prefixes in 58 files, and skipped specifications and TDD records. A second pass fixed five places the first missed: text that followed an escaped newline in a string, and module attributes in one test.
- Kept on purpose (N06): the MCP server name and tool names, the Codex client name, the request digest prefix, the schema identifier and the bridge variables.
- `scripts/build-packages.mjs` builds publishable packages: no `private`, public access, `repository`, `homepage`, `bugs`, a description and keywords, and a README for users. It accepts final and pre-release versions.
- `scripts/build-python.py` and `python/pyproject.toml`: the distribution `orchvia`, PEP 440 versions for pre-releases, project links and classifiers. `python/README.md` is the PyPI description, with absolute links.
- `scripts/package-smoke.mjs` checks every archive's metadata and README and the wheel's metadata.
- `.github/workflows/release.yml` (P02, P03), `scripts/registry-check.mjs` (P04), `CHANGELOG.md` (P05), `docs/release/publishing.md` (P06). `offline.yml` can be called by the release workflow.
- R06: the reference and the guide say Orchvia is not affiliated with TypeSafe. L03: issue and pull request templates, `SECURITY.md` and an updated `CONTRIBUTING.md`.

### GREEN

- `node --test tests/contract/naming.test.ts`: 3 of 3; `python/tests/test_naming.py`: 2 of 2.
- A build of 0.1.0 and the package smoke: all nine installation and bundle modes passed, with the new metadata checks.
- Two builds of 0.1.0 produced byte-identical npm archives. That matters because the first npm publish is built locally and the release workflow compares the registry's bytes with its own build.
- `npm publish --dry-run` works without a login when the archive path starts with `./`; without it, npm read `out/<file>` as a GitHub repository. The workflow and the guide use `./`.
- Full checks: `npm test` 567 passed (564 before, plus three naming tests), `npm run test:python` 81 passed (79 plus two), and typecheck, formatting, the generated-contract check and `git diff --check` passed. The quickstart and the Python example ran.
- CI on the pull request ran the release workflow without publishing. Its first run failed because npm requires `--tag` to publish a pre-release version, which the dry run uses; `62f0893` publishes pre-releases to `next`, and the rerun passed the build, the nine package modes, `npm publish --dry-run` for every package and `twine check`.
- A build of 0.1.0 from the merge commit `f331930` produced the same npm archives, byte for byte, as the builds before the merge.

### Mutation checks

| Mutation | Result |
| --- | --- |
| A package keeps its old name | caught (N01) |
| The command keeps its old name | caught (N01) |
| An example imports the old module | caught (N02) |
| The request digest prefix changes, in TypeScript | caught (N06) |
| The request digest prefix changes, in Python | caught (N06) |
| The MCP server name changes | caught (N06) |
| The schema identifier changes | caught (N06) |

### Not verified yet

- The release workflow's publishing jobs and `scripts/registry-check.mjs` run for the first time with the 0.1.0 tag; only the build job runs on pull requests.

## Real-model evidence (E)

Base: `f331930`. Branch `bench-and-claude-quickstart`.

### E01: the quickstart with real Claude

- `examples/typescript/quickstart-claude.ts` runs the offline quickstart's two tasks on Claude with the default read-only profile; the second task reuses the first one's session.
- `scripts/quickstart-claude-smoke.mjs` runs that example with the real Claude Code binary against a scripted loopback gateway, with a private home directory and synthetic credentials. It checks that both tasks complete, that the second reuses the session, and that the second request to the gateway carries the first answer, so the follow-up ran in the same Claude conversation. The pinned native-protocol CI job runs it.
- The example and its check were written together, so the check has no failing run of its own. Mutation: with the second task's context plan removed, the check failed with "reused the first agent's session: false".
- Local run: `{"quickstart":"claude","gatewayRequests":2,"modelCalls":0}`.

### E03 to E05: the benchmark harness

- `bench/` holds the fixture project, the four requests, hidden checks that live outside the agent's workspace, reference solutions and `run.mjs`. The arms and measurements follow E03 as approved with D-oss-10.
- `--fake` replaces the agent's edits with the reference solutions and needs no Claude Code. `--gateway` runs the real Claude Code binary for every arm against a loopback gateway (`bench/gateway.mjs`) that answers each request by reading and writing the reference solution with Claude Code's own tools, so the sandbox, the tools and the engine's writable profile all run, with no model call.
- Prices were checked on 2026-09-23 on Anthropic's pricing page: Claude Sonnet 5 costs $2 input, $10 output, $0.20 cache read, and $2.50 or $4 cache write for 5 minutes or 1 hour, per million tokens. Every arm prices cache writes at the 5-minute rate, because the engine's usage records do not separate the two.
- Each report records the Agent SDK and Claude Code versions: 0.3.274 and 2.1.274.
- CI runs `node bench/run.mjs --gateway --require-pass` in the pinned native-protocol job on Linux and on both macOS runners. `--require-pass` exits with 1 unless every arm passes every request.

#### RED

- **A failed check counted as passed under `npm test`.** `0021-E04 a request whose work is missing fails its checks and is reported so` leaves X2's solution out and failed at first: the report said X2 passed its hidden check. The harness runs each check with `node --test`, and under `npm test` it inherited the test runner's `NODE_TEST_CONTEXT`; a nested run with that variable exits 0 even when a test fails. Outside the test runner the same run reported X2 as failed, and with `NODE_TEST_CONTEXT=child-v8` set by hand it reported all four as passed. So the first E04 test could not detect a failing check. The harness now drops the variable.
- **The Orchvia arm's stop proof fails whenever the other track is still running.** The engine releases a writable Claude dispatch only after the host proves that its execution stopped. The harness's proof was that no process has its working directory in the workspace, but both tracks share the workspace. `node bench/run.mjs --gateway --arms orchvia`, with Y1's last answer held back for 3 seconds, reproduced it: X1's dispatch ended `outcome_unknown` with `remoteExecution: unknown`, and its task was blocked. Y1 and Y2 completed on one session. The X track never continued: the harness waited up to 30 minutes for the blocked task, which is not a terminal status, so the run was stopped by hand.
- The stop-proof tests in `tests/contract/bench.test.ts` state the intended proof. Against the workspace-wide check, two of three failed: a live process of the harness in the workspace blocked the proof (expected to hold), and the proof did not wait for the dispatch's own Claude process to exit. The third, that a process which outlived its parent blocks the proof, already passed.
- **lsof's exit status hid what it found.** With the corrected proof, the gateway run still blocked X1. Logging the proof showed that `lsof -Fp +D <workspace>` listed Y1's Claude process but exited with 1 and no message: with `+D`, lsof exits with 1 when some file under the directory is open in no process. The proof read that status as an error. The stop-proof tests had used an empty workspace, where lsof exits with 0; with one file in the test workspace, the test for the other track failed as well.

#### Changes

- `bench/stop.mjs`, as approved with D-bench-1: the proof waits until the adapter reports that the dispatch's own Claude process exited. It then lists the processes that use the workspace with `lsof +D` and requires each to descend from the harness process, following parent ids from `ps`. A process that exited in between counts as stopped. Any error, timeout or cancellation leaves the stop unproven. Exit status 1 from lsof without a message is read as a result.
- The orchvia arm's Claude adapter gets a 10-second cleanup window instead of the default second, so the wait for the process exit and the two listings fit in it.
- A task that ends failed, cancelled or blocked is read instead of awaited, and its track stops there: its session cannot take the follow-up, and the report shows the rest of the track as not run. Before, the harness waited up to 30 minutes for a blocked task.
- `--require-pass` for CI.

Timing invariants, as approved:

- The proof judges only after the dispatch's own Claude process exited. Until then it waits; a wait that outlasts the cleanup window leaves the stop unproven.
- Every process that still uses the workspace must descend from the harness. One that does not fails the proof of every dispatch while it runs.
- Errors and timeouts never prove a stop.

#### GREEN

- `node --test tests/contract/bench.test.ts`: 6 of 6.
- `node bench/run.mjs --gateway --require-pass`: every arm passed 4 of 4 with the real Claude Code binary, and the run exited with 0. In the orchvia arm, X1 and X2 completed on one session between 0 and 1.8 seconds while Y1 still ran until 3.9 seconds; Y2 then reused Y1's session.
- Before the lsof correction, when the proof still failed, the same run finished in 15 seconds, reported X1 as blocked and the rest of its track as not run, and exited with 1 under `--require-pass`. Before the harness change, it had waited for the blocked task.
- Full checks: `npm test` 573 passed (567 before, plus the six benchmark tests), `npm run test:python` 81 passed, and typecheck, formatting, the generated-contract check and `git diff --check` passed. `scripts/quickstart-claude-smoke.mjs` passed.

#### Mutation checks

| Mutation | Result |
| --- | --- |
| The Orchvia arm's follow-ups start a new session | caught (E04) |
| The two tracks run one after the other | caught (E04) |
| The budget is never checked | caught (E05) |
| A failed hidden check counts as passed | caught (E04) |
| The test runner's variable reaches the checks | caught (E04) |
| The quickstart's second task starts a new session | caught (E01 check) |
| The stop proof does not wait for the dispatch's own process | caught (E04) |
| The stop proof accepts a process that outlived its parent | caught (E04) |
| lsof's exit status 1 with a result counts as an error again | caught (E04) |
| Any error proves the stop | caught (E04) |

#### Not verified yet

- E02, E05 and E06: on 2026-09-23 the owner decided against paid model runs for now. An earlier attempt at the pilot stopped before any model call because the Claude Code sign-in had expired; nothing was spent.
- The scripted gateway only reads and writes files, so the agent running the project's tests through sandboxed Bash is exercised only by a real run.
- The stop proof cannot see a leftover process that left the workspace directory and holds no file in it.
- The CI step runs for the first time with the pull request that adds it.
