# SPEC-0008 verification evidence

Date: 2026-09-20. Scope: [confirmed Claude interruption](../specs/0008-claude-interruption.md), implemented only in Multi-Agent. Existing SPEC-0007 changes were preserved. No Axion files, credentials, real model requests, commits, pushes, or deployments were changed or performed.

## Order and RED

SPEC-0008 and AC-I01–I05 were written before the tests and implementation. The first new adapter test run used real owned offline children and controlled query messages:

```sh
node --test tests/contract/claude-interruption.test.ts
```

Observed: **15 tests, 3 passed, 12 failed**. Failures included interrupt capability false, no owned streaming/partial-message contract, no native interrupt call, and abort terminals still classified as ordinary errors. Wrong-session exclusion, local-cleanup retention, and a missing-method unknown outcome already passed and are regression coverage. RED log: `/private/tmp/multi-agent-spec0008-red.log`.

The CLI budget test was added before accepting its configuration field:

```sh
node --test --test-name-pattern='provider-specific cleanup' tests/contract/execution-isolation-wiring.test.ts
```

Observed: **1 failed**, `Unknown claude provider field: interruptTimeoutMs`. Then the CLI accepted and validated this Claude-only field. RED log: `/private/tmp/multi-agent-spec0008-cli-red.log`; GREEN log: `/private/tmp/multi-agent-spec0008-cli-green.log`.

The native SDK compile check initially found a real request-type incompatibility: streaming message UUID was typed as arbitrary string, while SDK 0.3.274 requires the UUID template type. The adapter now uses Node's UUID type. An exact native `query` function is assignable to `ClaudeQueryFactory<Omit<Options, ClaudeOwnedOption>>` under strict tsc without an any cast. The separate check reads the installed `sdk.d.ts`; normal repository typechecking has no optional native dependency.

Initial lifecycle/full-suite attempts in the filesystem sandbox hit Unix-socket `listen EPERM`; these were environment failures, not product RED or passing tests. The tests were rerun with local IPC permission, without skips. A lifecycle fixture initially tried the unsupported `kind: control` message; it was corrected to the existing `kind: finding` context message. No engine protocol change was required.

## GREEN coverage

| Criteria | Verified behavior |
| --- | --- |
| I01 | One typed user prompt, unique UUID, preserved resume ID, open input until terminal/cleanup, owned partial-message option, rejected overrides, finite positive interruption cap. Existing pre-submission abort regressions remain green. |
| I02 | Exactly one native interrupt after matching main-turn activity, including cancellation before init/activity. Init, subagent activity and unrelated sessions cannot trigger an early interrupt. Receipt leaves the SDK controller/input/terminal observation active. Structured aborted_streaming and aborted_tools map to interrupted; natural success, API errors and missing reasons retain their actual outcome. |
| I03 | Hanging/rejected/missing interrupt requests are bounded without invented stop evidence. An independently matched terminal remains authoritative despite lost/rejected acknowledgement. Wrong-session result excludes usage. Local child exit and host full-stop observation remain separate. A late matched result retains interrupted evidence and original-dispatch usage. Existing EOF, cleanup, acceptance/turn timeout, and resource-isolation suites pass. |
| I04 | A separate Node host owns actual offline Claude child processes. Public TypeScript client pauses, queues revised context, resumes the same native session/generation, and observes the revised result. A real Python subprocess pauses/resumes/cancels and reads both usage records. Host timeout followed by late terminal releases A while the operation remains outcome_unknown and task blocked/Q retained, with no second prompt. |
| I05 | Full Node/Python suites, typecheck, format and diff checks pass. Installed SDK transport and exact native request types are checked separately from real CLI/model acceptance. |

Adapter-specific suite after supplemental regression cases: **20/20**. New real host/client lifecycle suite: **3/3**. Logs: `/private/tmp/multi-agent-spec0008-green.log` and `/private/tmp/multi-agent-spec0008-lifecycle-green.log`.

## Installed SDK transport check

Reference: **@anthropic-ai/claude-agent-sdk 0.3.274**, read from an existing installation without modifying it or installing dependencies. The opt-in script accepts the installed SDK module path:

```sh
node tests/fixtures/claude-native-interrupt-smoke.ts /absolute/path/to/claude-agent-sdk/sdk.mjs
```

It runs the actual SDK query/input/control transport against `claude-interrupt-child.ts` by replacing only the test launch target with an owned offline Node peer. The native CLI is never started. The child receives an empty environment, handles initialize/user/interrupt frames locally, and returns a structured abort result. Recorded output:

```json
{"transport":"installed-native-sdk","subprocess":"offline-fixture","interrupted":true,"prompts":1,"interruptRequests":1,"modelCalls":0}
```

The SDK forwarded exactly one streaming user message and one interrupt after activity; the adapter observed interrupted and actual process cleanup. Log: `/private/tmp/multi-agent-spec0008-native-sdk.log`. The strict native-type check passed; source and output are `/private/tmp/multi-agent-spec0008-native-types.mts` and `/private/tmp/multi-agent-spec0008-native-types.log`.

This is stronger than a query-factory mock, but it does not verify the native CLI's provider cancellation, native tools/background work, real network/account behavior, saved provider history, or model usage completeness. Peer range `>=0.3.241 <1` remains an installation constraint, not a compatibility matrix. Older producers missing the structured abort reason never produce synthetic interruption.

## Final checks

| Command | Result |
| --- | --- |
| `npm test` | **344 passed, 0 failed, 0 skipped, 0 cancelled**; 2772.528125 ms |
| `npm run test:python` | **44 passed**; 5.024 seconds |
| `npm run typecheck` | Passed |
| `npm run format:check` | Passed |
| `git diff --check` | Passed |

Full logs: `/private/tmp/multi-agent-spec0008-node-final.log` and `/private/tmp/multi-agent-spec0008-python-final.log`. No real-provider acceptance or Axion integration is claimed.
