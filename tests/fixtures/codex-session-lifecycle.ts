import { createInterface } from 'node:readline';
const mode = process.argv[2];
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
let threadId = 'native-source';
let admission: unknown;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const p = request.params;
  if (request.method === 'initialize') send({ id: request.id, result: {} });
  else if (['thread/start', 'thread/resume', 'thread/fork'].includes(request.method)) {
    threadId = request.method === 'thread/fork' ? 'native-fork' : (p.threadId ?? 'native-source');
    admission = { method: request.method, params: p };
    send({ id: request.id, result: { thread: { id: threadId } } });
  } else if (request.method === 'turn/start' || request.method === 'thread/compact/start') {
    const compact = request.method === 'thread/compact/start';
    const turnId = compact ? 'compact-turn' : 'normal-turn';
    send({ id: request.id, result: compact ? {} : { turn: { id: turnId } } });
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
    if (compact && mode !== 'missing-boundary')
      send({
        method: 'item/completed',
        params: { threadId, turnId, item: { type: 'contextCompaction', id: 'compact-item' } },
      });
    else
      send({
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          item: { type: 'agentMessage', text: JSON.stringify(admission) },
        },
      });
    send({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'completed' } },
    });
  } else send({ id: request.id, error: { code: -32601, message: 'Unexpected fixture method' } });
}
