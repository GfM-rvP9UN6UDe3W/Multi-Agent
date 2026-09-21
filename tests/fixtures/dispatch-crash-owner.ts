// SPEC-0016 S01: an owner that is killed while its only dispatch runs.
import { createEngine } from './engine.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import type { TaskSnapshot } from '../../packages/engine/src/types.ts';

const [workspace, stateDir] = process.argv.slice(2);
const engine = await createEngine({
  workspace,
  stateDir,
  adapters: [createFakeAdapter({ delayMs: 600000 })],
});
let task = (await engine.call('tasks.create', {
  spec: {
    goal: 'crash during this dispatch',
    runtime: { provider: 'fake', model: 'fixture' },
    acceptance: { mode: 'human', criteria: ['Review'] },
  },
  idempotencyKey: 'crash',
})) as TaskSnapshot;
while (task.status !== 'running') {
  await new Promise((resolve) => setTimeout(resolve, 5));
  task = (await engine.call('tasks.get', { taskId: task.id })) as TaskSnapshot;
}
process.stdout.write(`${JSON.stringify(task)}\n`);
// Stay alive until the test kills this process mid-dispatch.
setInterval(() => {}, 1000);
