import { answerMcpMessage } from '../../engine/src/mcp-server.ts';
import type { RuntimeTools } from '../../engine/src/tools.ts';

/** @deprecated Ignored: the server needs neither the Claude SDK nor Zod (SPEC-0026 Z07). */
export interface ClaudeMcpDependencies {
  sdk?: unknown;
  zod?: unknown;
}

/** What the Claude Agent SDK passes to an in-process server's `connect`, as far as it is used here. */
interface SdkServerTransport {
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
}

/**
 * The adapter-owned `agent_orch` server for the Claude Agent SDK's `mcpServers` option. It answers
 * MCP itself with the tools' JSON Schemas, as the Codex bridge does, so it loads neither the SDK nor
 * Zod and works with whatever Zod the host has installed (SPEC-0026).
 */
export async function createClaudeMcpServer(
  tools: RuntimeTools,
  _dependencies?: ClaudeMcpDependencies,
): Promise<unknown> {
  const transports = new Set<SdkServerTransport>();
  return {
    type: 'sdk',
    name: 'agent_orch',
    instance: {
      async connect(transport: SdkServerTransport) {
        transports.add(transport);
        transport.onclose = () => transports.delete(transport);
        transport.onmessage = (message) => {
          if (!message || typeof message !== 'object' || Array.isArray(message)) return;
          void answerMcpMessage(
            message as Record<string, unknown>,
            tools.definitions,
            (name, request) => tools.call(name, request),
          )
            .then((answer) => answer && transport.send(answer))
            // A transport closed by its query cannot take a late answer; nothing waits for it.
            .catch(() => {});
        };
        await transport.start();
      },
      async close() {
        for (const transport of [...transports]) await transport.close();
      },
    },
  };
}
