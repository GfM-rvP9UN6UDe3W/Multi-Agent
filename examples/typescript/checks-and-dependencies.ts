/** Offline parity example: registered checks, dependencies and fixed snapshots. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import type { TaskSpec } from '../../packages/engine/src/types.ts';

const root = await mkdtemp(join(tmpdir(), 'orch-checks-example-'));
const workspace = join(root, 'work');
await mkdir(workspace);
const orch = await createOrchestrator({
  workspace,
  stateDir: join(root, 'state'),
  adapters: [createFakeAdapter()],
  storage: { emergencyBytes: 4096, minFreeBytes: 0 },
  verificationRules: [
    {
      id: 'fixture',
      version: '1',
      argv: [process.execPath, '-e', 'console.log("fixture verified")'],
      cwdRelative: '.',
      timeoutMs: 1000,
      permissionProfile: 'read-only',
      success: { exitCode: 0 },
    },
  ],
});
try {
  const spec: TaskSpec = {
    goal: 'Produce deterministic offline output',
    runtime: { provider: 'fake', model: 'fixture' },
    acceptance: { mode: 'checks', ruleRefs: [{ id: 'fixture', version: '1' }] },
  };
  const parent = await orch.tasks.create(spec);
  const child = await orch.tasks.create({
    ...spec,
    parentTaskId: parent.id,
    dependencyTaskIds: [parent.id],
    contextPlan: {
      requestedMode: 'fresh',
      independent: true,
      dependencyTaskIds: [parent.id],
      contextRefs: [],
      fallbackModes: [],
      maxQueueWaitMs: 30000,
    },
  });
  for (const task of [parent, child]) {
    const done = await task.wait({ timeoutMs: 5000 });
    if (done.status !== 'completed') throw new Error(`Fixture acceptance failed: ${done.status}`);
  }
  const snapshot = await orch.state.snapshot({ limit: 8 });
  try {
    let page = snapshot,
      items = page.items.length;
    while (!page.done) {
      page = await orch.state.snapshot({
        snapshotId: snapshot.snapshotId,
        offset: page.nextOffset,
        limit: 8,
      });
      items += page.items.length;
    }
    console.log(
      JSON.stringify({ language: 'typescript', completed: 2, snapshotItems: items, modelCalls: 0 }),
    );
  } finally {
    await orch.state.releaseSnapshot(snapshot.snapshotId);
  }
} finally {
  await orch.close({ mode: 'interrupt', timeoutMs: 3000 });
  await rm(root, { recursive: true, force: true });
}
