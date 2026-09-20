import { exerciseTools } from './orchestration-actions.ts';
import { createInterface } from 'node:readline';
import { TOOL_NAMES } from '../../packages/engine/src/tools.ts';
const session = '11111111-1111-4111-8111-111111111111';
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const queue = [
  {
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'offline', version: '1' },
    },
  },
  { method: 'tools/list', params: {} },
  ...TOOL_NAMES.map((name) => ({
    method: 'tools/call',
    params: { name, arguments: { request: { id: name } } },
  })),
];
let sequence = 0;
let permissionRequested = false;
const results: unknown[] = [];
function next() {
  const request = queue.shift();
  if (request)
    send({
      type: 'control_request',
      request_id: `mcp-${++sequence}`,
      request: {
        subtype: 'mcp_message',
        server_name: 'agent_orch',
        message: { jsonrpc: '2.0', id: sequence, ...request },
      },
    });
  else if (!permissionRequested) {
    permissionRequested = true;
    send({
      type: 'control_request',
      request_id: 'permission-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Read',
        input: { file_path: 'fixture.txt' },
        tool_use_id: 'tool-1',
        permission_suggestions: [],
      },
    });
  } else
    send({
      type: 'result',
      subtype: 'success',
      session_id: session,
      result: JSON.stringify(results),
      is_error: false,
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
    });
}
const pending = new Map<string, (value: any) => void>();
async function engineTools() {
  const mcp = (method: string, params: Record<string, unknown>) =>
    new Promise<any>((resolve) => {
      const id = `engine-${++sequence}`;
      pending.set(id, resolve);
      send({
        type: 'control_request',
        request_id: id,
        request: {
          subtype: 'mcp_message',
          server_name: 'agent_orch',
          message: { jsonrpc: '2.0', id: sequence, method, params },
        },
      });
    });
  await mcp('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'fixture', version: '1' },
  });
  const result = await exerciseTools(async (name, request) => {
    const response = await mcp('tools/call', { name, arguments: { request } });
    if (response.result.isError) throw new Error(response.result.content[0].text);
    return JSON.parse(response.result.content[0].text);
  });
  send({
    type: 'result',
    subtype: 'success',
    session_id: session,
    result: JSON.stringify(result),
    is_error: false,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    total_cost_usd: 0,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
  });
}
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  if (value.type === 'control_request')
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: value.request_id,
        response: { commands: [], models: [], account: {} },
      },
    });
  else if (value.type === 'user') {
    send({
      type: 'system',
      subtype: 'init',
      session_id: session,
      tools: [],
      model: 'offline',
      mcp_servers: [],
      permissionMode: 'dontAsk',
      slash_commands: [],
      apiKeySource: 'none',
    });
    if (process.argv.includes('--engine-tools'))
      void engineTools().catch((error) => {
        process.stderr.write(String(error));
        process.exitCode = 1;
        process.stdin.destroy();
      });
    else next();
  } else if (value.type === 'control_response' && pending.has(value.response.request_id)) {
    const resolve = pending.get(value.response.request_id)!;
    pending.delete(value.response.request_id);
    resolve(value.response.response.mcp_response);
  } else if (value.type === 'control_response' && value.response.request_id.startsWith('mcp-')) {
    results.push(value.response);
    next();
  } else if (value.type === 'control_response' && value.response.request_id === 'permission-1') {
    results.push(value.response);
    next();
  }
}
