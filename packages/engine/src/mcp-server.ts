import type { OrchestrationToolDefinition } from './tools.ts';
import type { Json } from './types.ts';
import { VERSION } from './version.ts';

/**
 * MCP revisions whose tool messages this server answers, latest first. Their initialize, ping,
 * tools/list and tools/call messages are the same for a server with only unchanging tools.
 */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** The only failure text a model may see: an error's code, never its message or stack. */
export function toolErrorCode(error: unknown): string {
  return object(error) && typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code)
    ? error.code
    : 'TOOL_FAILED';
}

/**
 * The agent_orch MCP server's answer to one JSON-RPC message, or undefined for a notification.
 * The Codex stdio bridge and the Claude in-process server both answer through it, with the tools'
 * own JSON Schemas (SPEC-0026).
 */
export async function answerMcpMessage(
  message: Record<string, unknown>,
  definitions: readonly OrchestrationToolDefinition[],
  call: (name: string, request: Record<string, unknown>) => Promise<Json>,
): Promise<Record<string, unknown> | undefined> {
  if (message.id === undefined) return undefined;
  const answer: Record<string, unknown> = { jsonrpc: '2.0', id: message.id };
  const params = object(message.params) ? message.params : {};
  if (message.method === 'initialize')
    answer.result = {
      protocolVersion: MCP_PROTOCOL_VERSIONS.includes(String(params.protocolVersion))
        ? params.protocolVersion
        : MCP_PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'agent_orch', version: VERSION },
    };
  else if (message.method === 'ping') answer.result = {};
  else if (message.method === 'tools/list') answer.result = { tools: definitions };
  else if (message.method === 'tools/call') {
    try {
      const definition = definitions.find((tool) => tool.name === params.name);
      if (!definition) throw failure('UNKNOWN_TOOL');
      const args = params.arguments;
      if (
        !object(args) ||
        Object.keys(args).some((key) => key !== 'request') ||
        !object(args.request)
      )
        throw failure('INVALID_REQUEST');
      const result = await call(definition.name, args.request);
      answer.result = { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      answer.result = { isError: true, content: [{ type: 'text', text: toolErrorCode(error) }] };
    }
  } else answer.error = { code: -32601, message: 'Unknown method' };
  return answer;
}
