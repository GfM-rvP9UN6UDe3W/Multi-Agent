# TDD-0026: A Claude MCP server without Zod

Date: 2026-09-24. Base: `078ff5c` (SPEC-0025). Specification: [SPEC-0026](../specs/0026-claude-mcp-without-zod.md). Node 22.22.2, npm 10.9.7, Linux x86-64.

## The problem, reproduced

- An empty project, `npm install zod@4.6.5 @orchvia/adapter-claude@0.1.2`: `ERESOLVE unable to resolve dependency tree`, `Could not resolve dependency: peerOptional zod@"4.4.3" from @orchvia/adapter-claude@0.1.2`.
- The 0.1.2 server, created with the SDK and Zod beside it and driven as the SDK drives it: with SDK 0.3.274 or 0.3.281 and Zod 4.6.5, `initialize` and `tools/call` were answered and `tools/list` was answered `{"code":-32603,"message":"Cannot read properties of undefined (reading 'push')"}`.
- The same code through the SDK's `query()`, the offline Claude process and an actual engine (`tests/fixtures/native-mcp-engine-smoke.ts`):

| SDK | Zod 4.4.3 | Zod 4.6.5 |
| --- | --- | --- |
| 0.3.241 | passed | passed |
| 0.3.274 | passed | failed: `tools/list`, the task ended `blocked` |
| 0.3.281 | passed | failed: `tools/list`, the task ended `blocked` |

## RED

`tests/contract/claude-mcp-server.test.ts`, and `tests/contract/claude-host-bindings.test.ts` with its MCP test replaced, against the base with Zod 4.4.3 installed: 10 of 12 tests failed.

- `0026-Z01`, tools/list: the served schemas were Zod's conversion, `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"request":{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{}}},"required":["request"]}`, with `execution: {taskSupport: 'forbidden'}` on each tool. The description of `request`, which names the fields each tool takes and which Codex gets, was missing, and so was `additionalProperties: false`.
- `0026-Z01` and `0026-Z06` through the installed SDK: without `createMcpServer`, the adapter stopped before submission with `Host-provided query requires matching config.createMcpServer when orchestration tools are enabled; no default SDK was loaded`; with the engine, the task ended `failed` for that reason.
- `0026-Z02`: with Zod and the SDK hidden, `createClaudeMcpServer` rejected with `Claude MCP requires @anthropic-ai/claude-agent-sdk and zod 4.4.3, or explicit host SDK/Zod bindings`.
- `0026-Z03`: an unknown tool was answered `MCP error -32602: Tool approvals.decide not found` instead of `UNKNOWN_TOOL`. Results and failure codes already matched.
- `0026-Z04`: `initialize` answered `capabilities.tools.listChanged: true`. The Codex bridge answered `2024-11-05` to a client that asked for `2025-11-25`.
- `0026-Z05`, `close()`: passed; the SDK's own server closes its transport too.
- `0026-Z06`, injected query: the same error before submission, and the query was never called.
- `0026-Z07`: `{ sdk: {}, zod: {} }` failed with `z.string is not a function`.
- `0026-Z08`: the workspace's `package.json` pinned `zod` in `devDependencies`.
- `D04` inspection, unchanged: passed.

## Changes

- `packages/engine/src/mcp-server.ts` holds `answerMcpMessage`, the `agent_orch` server's answer to one MCP message, which the Codex stdio bridge used to compute inline. It keeps a known protocol version, 2024-11-05 to 2025-11-25, and otherwise answers the latest.
- `packages/engine/src/tool-bridge.ts` answers through it; its framing, credential and limits are unchanged.
- `createClaudeMcpServer` in `packages/adapter-claude/src/mcp.ts` returns `{type: 'sdk', name: 'agent_orch', instance}`, whose instance has `connect(transport)`, which answers each message through `answerMcpMessage`, and `close()`. It imports nothing but engine code and ignores a second argument, whose type no longer names Zod or the SDK.
- `packages/adapter-claude/src/index.ts` no longer requires `createMcpServer` with an injected query.
- The adapter's manifest drops the Zod peer and the workspace drops its Zod pin. The lockfile keeps Zod only as the Agent SDK's peer, at 4.6.5.
- The offline Claude process checks that `tools/list` returns `ORCHESTRATION_TOOLS` exactly. The standalone and engine MCP smokes, the native gateway smoke and the packaged host no longer pass Zod or `createMcpServer`. The package smoke creates the server where neither the SDK nor Zod is installed, copies no Zod into the bundle smoke and checks that no bundle contains it.

Found on the way:

- The first RED run gave the old server an `initialize` without `clientInfo.version`, which MCP requires, and it refused it as invalid. With a valid `clientInfo`, the difference is `listChanged`.
- `npm install` with npm 10.9.7 also reordered the workspace links and marked the Agent SDK's platform packages `dev`, which this change does not need. The lockfile was edited instead to the three entries that npm computes for this change: the root and the adapter without Zod, and `node_modules/zod` at 4.6.5 as a peer. A comparison with `npm install --package-lock-only` found no other difference, and `npm ci` installs it.
- SDK 0.3.241 checks for its native binary before it calls the host's spawn callback. Installed with `--no-optional`, it failed the offline smokes with `Native CLI binary for linux-x64 not found`, with the old code as with the new one. Installed with its optional dependencies, it passed.

## GREEN

- The two test files: 12 of 12, with `tool-bridge.test.ts` and `naming.test.ts` passing unchanged.
- `npm test`: 627 of 627. `npm run test:python`: 91 of 91. Typecheck, formatting and the generated-contract check passed.
- Package smoke, `npm run build:packages`, `scripts/build-python.py` and `npm run test:packages`: nine modes passed, among them the installed and the bundled CJS and ESM Claude hosts with four MCP calls each. The packed adapter declares only the optional SDK peer.
- The packed engine and adapter installed next to Zod 4.6.5 and SDK 0.3.281 without an error, and the installed server answered `tools/list` with the four tools.
- Outside CI, with Zod 4.6.5: SDK 0.3.241, 0.3.274 and 0.3.281 each passed the standalone MCP smoke and the actual-engine smoke.
- The real Claude binary of SDK 0.3.274 (`node scripts/native-gateway-smoke.mjs claude`), with Zod 4.6.5 in the workspace: nine cases passed. The binary reported `agent_orch` as `connected` with the four tools, and its model requests carried their JSON Schemas, with the description of `request`.
- The real Codex binary 0.153.4 (`node scripts/native-gateway-smoke.mjs codex`), whose bridge now answers through the shared code: six cases passed.

## Mutation checks

| Mutation | Result |
| --- | --- |
| Arguments with more keys than `request` are accepted | caught by `0026-Z03` and the bridge's `AC-F05/F06` |
| An unknown protocol version is answered `2024-11-05` | caught by both `0026-Z04` tests |
| `2025-11-25` is not a known version | caught by both `0026-Z04` tests |
| A failure is answered with its message | caught by `0026-Z03` |
| Names are checked against all tools, not the bound ones | caught by `0026-Z03` |
| Notifications are answered | caught by `0026-Z04` |
| `close()` closes nothing | caught by `0026-Z05` |
| An injected query requires `createMcpServer` again | caught by the three `0026-Z06` and `Z01` tests with a query |
| The server imports Zod | caught by `0026-Z02` and `0026-Z08` |
| `tools/list` serves schemas without their properties | caught by `0026-Z01`, both `Z06` paths and `Z07` |

## Not verified

- SDK releases other than 0.3.241, 0.3.274 and 0.3.281. The SDK types an in-process server's instance as `McpServer` of `@modelcontextprotocol/sdk`; a release that used more of it than `connect(transport)` would need this server extended. The pinned native job checks 0.3.274.
- Whether real models use the added descriptions of `request` better; no model requests were made.
- `notifications/cancelled`: the server lets a cancelled call finish and answers it, as the Codex bridge did; the SDK drops an answer that nothing waits for.
