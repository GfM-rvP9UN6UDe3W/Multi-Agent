import { createInterface } from 'node:readline';

// Offline owned app-server: only returns the policy fields supplied by the adapter.
let thread: Record<string, unknown> = {};
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin })
  .on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: {} });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') {
      thread = { method: message.method, ...message.params };
      send({ id: message.id, result: { thread: { id: 'thread-fixture' } } });
    } else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-fixture' } } });
      send({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-fixture',
          turnId: 'turn-fixture',
          tokenUsage: { last: { inputTokens: 7, outputTokens: 2 }, total: { totalTokens: 9 } },
        },
      });
      send({
        method: 'item/completed',
        params: {
          threadId: 'thread-fixture',
          turnId: 'turn-fixture',
          item: {
            type: 'agentMessage',
            text: JSON.stringify({
              thread,
              turn: message.params,
              args: process.argv.slice(2),
              managedHome: process.env.CODEX_HOME,
            }),
          },
        },
      });
      send({
        method: 'turn/completed',
        params: { threadId: 'thread-fixture', turn: { id: 'turn-fixture', status: 'completed' } },
      });
    }
  })
  .on('close', () => process.exit(0));
