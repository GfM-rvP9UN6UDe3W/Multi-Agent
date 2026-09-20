import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Engine, TaskSnapshot } from '../../packages/engine/src/types.ts';

// Run the same public-API workload against a source checkout, including an isolated baseline.
// node tests/fixtures/scheduler-benchmark.ts [checkout] [50,100,150,300]
const checkout = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)));
const checkpoints = (process.argv[3] ?? '50,100,150,300').split(',').map(Number);
if (!checkpoints.length || checkpoints.some((n) => !Number.isSafeInteger(n) || n < 5 || n > 10000))
  throw new Error('Checkpoint counts must be integers from 5 through 10000');
const { createEngine } = await import(
  pathToFileURL(join(checkout, 'packages/engine/src/index.ts')).href
);
const { createFakeAdapter } = await import(
  pathToFileURL(join(checkout, 'packages/engine/src/fake.ts')).href
);
const dir = await mkdtemp(join(tmpdir(), 'orch-scheduler-benchmark-'));
let engine: Engine | undefined;
try {
  const workspace = join(dir, 'workspace');
  await mkdir(workspace);
  engine = await createEngine({
    workspace,
    stateDir: join(dir, 'state'),
    adapters: [createFakeAdapter({ result: 'offline benchmark' })],
  });
  const host = engine!;
  const samples: number[] = [];
  for (let totalTasks = 1; totalTasks <= Math.max(...checkpoints); totalTasks++) {
    const start = performance.now();
    const created = (await host.call('tasks.create', {
      spec: {
        goal: 'offline benchmark',
        runtime: { provider: 'fake', model: 'test' },
        acceptance: { mode: 'human', criteria: ['fixture'] },
      },
      idempotencyKey: `benchmark-${totalTasks}`,
    })) as TaskSnapshot;
    samples.push(performance.now() - start);
    const waitStart = performance.now();
    while (
      ((await host.call('tasks.get', { taskId: created.id })) as TaskSnapshot).status !==
      'waiting_approval'
    ) {
      if (performance.now() - waitStart > 10000)
        throw new Error('Fake task did not reach waiting_approval');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (checkpoints.includes(totalTasks)) {
      const recent = samples.slice(-5);
      console.log(
        JSON.stringify({
          totalTasks,
          createMs: Number(samples.at(-1)!.toFixed(2)),
          meanLast5Ms: Number((recent.reduce((a, b) => a + b, 0) / recent.length).toFixed(2)),
        }),
      );
    }
  }
} finally {
  await engine?.close({ mode: 'interrupt', timeoutMs: 1000 });
  await rm(dir, { recursive: true, force: true });
}
