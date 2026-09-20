import { exerciseTools } from './orchestration-actions.ts';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { TOOL_NAMES } from '../../packages/engine/src/tools.ts';

const config = process.argv.find((arg) => arg.startsWith('mcp_servers=')) ?? '';
const runner = JSON.parse(config.match(/args=\[("(?:[^"\\]|\\.)*")\]/)?.[1] ?? 'null');
if (!runner || config.includes(process.env.AGENT_ORCH_BRIDGE_TOKEN!))
  throw new Error('Invalid private bridge wiring');
const bridge = spawn(process.execPath, [runner], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const responses = createInterface({ input: bridge.stdout })[Symbol.asyncIterator]();
const call = async (method: string, params = {}) => {
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
  return JSON.parse((await responses.next()).value!);
};
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
process.on('exit', () => bridge.kill());
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const req = JSON.parse(line);
    if (req.id === undefined) continue;
    if (req.method === 'initialize') send({ id: req.id, result: {} });
    else if (req.method === 'thread/start')
      send({ id: req.id, result: { thread: { id: 'thread' } } });
    else if (req.method === 'turn/start') {
      send({ id: req.id, result: { turn: { id: 'turn' } } });
      await call('initialize', { protocolVersion: '2024-11-05' });
      let result: unknown;
      if (process.argv.includes('--engine-tools'))
        result = await exerciseTools(async (name, request) => {
          const response = await call('tools/call', { name, arguments: { request } });
          if (response.result.isError) throw new Error(response.result.content[0].text);
          return JSON.parse(response.result.content[0].text);
        });
      else {
        result = [];
        for (const name of TOOL_NAMES)
          (result as unknown[]).push(
            await call('tools/call', { name, arguments: { request: { id: name } } }),
          );
      }
      send({
        method: 'item/completed',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          item: { type: 'agentMessage', text: JSON.stringify(result) },
        },
      });
      send({
        method: 'turn/completed',
        params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } },
      });
    } else send({ id: req.id, result: {} });
  }
} finally {
  bridge.stdin.end();
  bridge.kill();
}
