import { createInterface } from 'node:readline';
import { createEngine, createFakeAdapter } from '../../packages/engine/src/index.ts';
import { startUnixHost } from '../../packages/cli/src/host.ts';
import type { EventPage, TaskSnapshot } from '../../packages/engine/src/types.ts';

const [mode, workspace, stateDir, socketPath] = process.argv.slice(2);
const fake = createFakeAdapter();
let submissions = 0;
const engine = await createEngine({
  workspace,
  stateDir,
  adapters: [
    {
      ...fake,
      async *execute(input) {
        submissions++;
        const usage = {
          type: 'usage' as const,
          usageId: 'observed',
          usage: {
            inputTokens: 7,
            cachedInputTokens: null,
            cacheWriteInputTokens: null,
            outputTokens: 2,
            raw: { input_tokens: 7, vendor: { taskId: 'raw-unchanged' } },
          },
        };
        input.reportUsage?.(usage);
        yield usage;
        yield* fake.execute(input);
      },
    },
  ],
});
let task: TaskSnapshot | undefined;
if (mode === 'seed') {
  task = (await engine.call('tasks.create', {
    spec: {
      goal: 'Offline durable usage',
      runtime: { provider: 'fake', model: 'offline' },
      acceptance: { mode: 'human', criteria: ['Review fixture'] },
    },
    idempotencyKey: 'seed',
  })) as TaskSnapshot;
  while (task.status !== 'waiting_approval') {
    await new Promise((resolve) => setTimeout(resolve, 5));
    task = (await engine.call('tasks.get', { taskId: task.id })) as TaskSnapshot;
  }
}
const host = await startUnixHost(engine, { socketPath });
const page = (await engine.call('events.read', { limit: 256 })) as EventPage;
const index = page.events.findIndex((event) => event.type === 'usage.recorded');
process.stdout.write(
  JSON.stringify({
    taskId: task?.id,
    storeId: page.storeId,
    submissions,
    afterCursor: index > 0 ? page.events[index - 1].cursor : '0',
  }) + '\n',
);
const input = createInterface({ input: process.stdin });
input.on('line', (command) => {
  if (command === 'close')
    void host.close({ mode: 'drain', timeoutMs: 1000 }).then(() => input.close());
});
await host.closed;
