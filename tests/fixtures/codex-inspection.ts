import { createInterface } from 'node:readline';
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (req.method === 'initialize') send({ id: req.id, result: {} });
  else if (req.method === 'initialized') continue;
  else if (req.method === 'thread/read')
    send({
      id: req.id,
      result: {
        thread: { id: req.params.threadId, turns: [{ id: 'original-turn', status: 'completed' }] },
      },
    });
  else throw new Error('Inspection attempted a mutating native operation');
}
