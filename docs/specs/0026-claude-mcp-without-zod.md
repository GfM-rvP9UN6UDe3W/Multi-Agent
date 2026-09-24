# SPEC-0026: A Claude MCP server without Zod

Date: 2026-09-24. Status: approved by the owner on 2026-09-24, who asked for a fix that removes the conflict at its cause instead of documenting a way around it. Evidence: [TDD-0026](../tdd/0026-claude-mcp-without-zod.md).

## Why

`@orchvia/adapter-claude` 0.1.2 declares the optional peer `zod: 4.4.3`. An application that uses another Zod, such as the current 4.6.5, cannot install the adapter: npm stops with `ERESOLVE`, `Could not resolve dependency: peerOptional zod@"4.4.3" from @orchvia/adapter-claude@0.1.2`.

The pin was not a preference. The adapter built its `agent_orch` MCP server with the Claude Agent SDK's `createSdkMcpServer` and `tool()`, which take Zod schemas. When Claude Code lists the tools, the SDK converts each schema to JSON Schema with the Zod code bundled in the SDK, and that code calls into the schema's own Zod. Whether that works depends on the pair. With Zod 4.6.5, SDK 0.3.241 lists the tools, but 0.3.274 and 0.3.281 fail `tools/list` with `Cannot read properties of undefined (reading 'push')` ([TDD-0011](../tdd/0011-release-readiness.md#real-native-binary-findings-and-corrections)), and the model gets none of the four tools. With Zod 4.4.3 all three list them. The pin therefore held only for the SDK releases checked against it, and it imposed that one Zod on every application.

The four tools already have JSON Schemas, which the Codex adapter's MCP bridge serves without Zod. For an in-process server the SDK needs only an object with `connect(transport)`: SDK 0.3.241, 0.3.274 and 0.3.281 call nothing else on it, then pass it MCP messages through the transport.

## Acceptance criteria

- **Z01** The Claude adapter's `agent_orch` server answers MCP itself. `tools/list` returns the bound tool definitions with the JSON Schemas of `ORCHESTRATION_TOOLS`, the same that Codex gets, whatever Zod the application has installed, or none.
- **Z02** Creating the server imports neither `zod` nor `@anthropic-ai/claude-agent-sdk`: `createClaudeMcpServer(tools)` resolves when neither can be imported. It never rejects with `CLAUDE_DEPENDENCY_UNAVAILABLE`.
- **Z03** `tools/call` of a served tool calls it with `arguments.request` and returns its result as JSON text. A call with an unknown name, or with arguments other than exactly an object `request`, is answered as a tool error `UNKNOWN_TOOL` or `INVALID_REQUEST` without calling anything. A failed call is answered with the error's code, or `TOOL_FAILED`, never with its message.
- **Z04** `initialize` answers with the server name `agent_orch`, the package version and the `tools` capability. It keeps the protocol version that the client asks for when it is 2024-11-05, 2025-03-26, 2025-06-18 or 2025-11-25, and otherwise answers the latest of these. `ping` is answered, another method with an id gets the error `-32601`, and a notification gets no answer. The Codex bridge answers through the same code, so it now also keeps 2025-11-25 and answers the latest version where it had answered 2024-11-05.
- **Z05** The server's `close()` closes the transports that it is connected to.
- **Z06** With a host-supplied `query` and orchestration tools, the adapter uses its own server when the host supplies no `createMcpServer`. The server loads no SDK, so an injected query can no longer get a second one through it, and SPEC-0010 D04's requirement of a matching MCP factory is lifted. A host's `createMcpServer` still replaces the server. Inspection is unchanged: without `inspectSession`, an injected query's inspection reports `unavailable`.
- **Z07** `createClaudeMcpServer(tools, dependencies)` accepts and ignores the `{ sdk, zod }` of a 0.1.2 host. Its type `ClaudeMcpDependencies` stays exported, without Zod types.
- **Z08** `@orchvia/adapter-claude` declares no Zod dependency or peer, and no package source imports Zod. The workspace no longer pins Zod: its lockfile resolves the Agent SDK's own Zod peer, now 4.6.5. Installing the adapter next to Zod 4.6.5 succeeds.

## Tests

- Contract: the server driven as the SDK drives it, through `connect(transport)`, answers initialize, ping, tools/list and tools/call, and closes its transport (Z01, Z03 to Z05). The Codex bridge keeps 2025-11-25 (Z04).
- Contract: a child process in which `zod` and `@anthropic-ai/claude-agent-sdk` cannot be resolved creates the server and lists the tools (Z02).
- Contract: an adapter with an injected query and no `createMcpServer` passes its own server to the query (Z06), and a 0.1.2 host's call with `{ sdk, zod }` still works (Z07).
- Contract: the installed SDK's `query()` and the offline Claude process list the four tools with their schemas and call them, with the adapter's own server (Z01, Z06).
- Contract: no package declares or imports Zod, and the workspace does not pin it (Z08).
- Packages: the package smoke creates the server where neither the SDK nor Zod is installed and lists four tools, and the CJS and ESM bundles contain no Zod (Z02, Z08).
- Outside CI: SDK 0.3.241, 0.3.274 and 0.3.281 with Zod 4.6.5 list and call the tools through the offline Claude process, and the packed adapter installs next to Zod 4.6.5 (Z01, Z08). The pinned native job runs the real Claude binary with the lockfile's Zod 4.6.5 (Z01).

## Not changed

The engine, the wire protocol, the tools and their JSON Schemas, and the Claude SDK peer range. A host that supplies `createMcpServer` keeps its own server.
