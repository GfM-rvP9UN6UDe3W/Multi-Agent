import { createInterface } from 'node:readline';
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  if (value.method === 'initialize') send({ id: value.id, result: {} });
  else if (value.method === 'thread/start') {
    if (value.params.approvalPolicy !== 'on-request')
      throw new Error('Runtime approval policy not configured');
    send({ id: value.id, result: { thread: { id: 'thread' } } });
  } else if (value.method === 'turn/start') {
    send({ id: value.id, result: { turn: { id: 'turn' } } });
    send({
      id: 'permission',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        itemId: 'tool-1',
        command: 'read fixture',
        cwd: process.cwd(),
      },
    });
  } else if (value.id === 'permission' && value.result) {
    send({
      method: 'item/completed',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: { type: 'agentMessage', text: value.result.decision },
      },
    });
    send({
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } },
    });
  }
}
