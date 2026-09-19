import { createEngine, createFakeAdapter } from '../../packages/engine/src/index.ts';
import type { TaskSnapshot } from '../../packages/engine/src/types.ts';
const engine = await createEngine({
  workspace: process.argv[2],
  stateDir: process.argv[3],
  adapters: [createFakeAdapter({ delayMs: 3600000 })],
  limits: { maxActiveSessions: 1 },
});
const spec = {
  goal: 'A deterministic recovery fixture',
  runtime: { provider: 'fake', model: 'test' },
  acceptance: { mode: 'human', criteria: ['reviewed'] },
};
const running = (await engine.call('tasks.create', {
  spec,
  idempotencyKey: 'running',
})) as TaskSnapshot;
const queued = (await engine.call('tasks.create', {
  spec,
  idempotencyKey: 'queued',
})) as TaskSnapshot;
while (
  ((await engine.call('tasks.get', { taskId: running.id })) as TaskSnapshot).status !== 'running'
)
  await new Promise((r) => setTimeout(r, 5));
process.stdout.write(JSON.stringify({ running, queued, storeId: engine.storeId }) + '\n');
