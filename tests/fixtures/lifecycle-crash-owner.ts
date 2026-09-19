import { createEngine, createFakeAdapter } from '../../packages/engine/src/index.ts';
import type { TaskSnapshot, SessionSnapshot } from '../../packages/engine/src/types.ts';
const engine = await createEngine({
  workspace: process.argv[2],
  stateDir: process.argv[3],
  adapters: [createFakeAdapter({ delayMs: 3600000 })],
  timeouts: { drainMs: 10000 },
});
const task = (await engine.call('tasks.create', {
  spec: {
    goal: 'crash during drain',
    runtime: { provider: 'fake', model: 'test' },
    acceptance: { mode: 'human', criteria: ['review'] },
  },
  idempotencyKey: 'task',
})) as TaskSnapshot;
let session: SessionSnapshot;
do {
  await new Promise((r) => setTimeout(r, 5));
  session = (await engine.call('sessions.get', { sessionId: task.sessionId })) as SessionSnapshot;
} while (!session.providerSessionId);
const operation = await engine.call('sessions.control', {
  target: {
    sessionId: session.id,
    expectedGeneration: session.generation,
    expectedRevision: session.revision,
    expectedDispatchId: session.activeDispatchId,
    expectedState: session.status,
  },
  command: { action: 'pause', mode: 'drain' },
  idempotencyKey: 'pause',
});
process.stdout.write(JSON.stringify({ task, operation }) + '\n');
