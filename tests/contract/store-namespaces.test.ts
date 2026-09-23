import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../../packages/engine/src/index.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import { createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';

const spec = {
  goal: 'namespace fixture',
  runtime: { provider: 'fake', model: 'test' },
  acceptance: { mode: 'human' as const, criteria: ['review'] },
};
test('B08 namespace/protocol checks precede every business write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-namespace-'));
  const workspace = join(root, 'work');
  await mkdir(workspace);
  const engine = await createEngine({
    workspace,
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
    storage: { emergencyBytes: 4096 },
  });
  try {
    await assert.rejects(
      engine.call('initialize', { protocolVersion: '1.0', sdkVersion: 'test' }),
      { code: 'PROTOCOL_MISMATCH' },
    );
    const info = (await engine.call('initialize', {
      protocolVersion: '2.0',
      sdkVersion: 'test',
    })) as any;
    assert.equal(info.capabilities.storeNamespaces.version, 1);
    const before = await engine.call('events.read');
    await assert.rejects(engine.call('tasks.create', { spec, idempotencyKey: 'K' }), {
      code: 'STORE_NAMESPACE_REQUIRED',
    });
    await assert.rejects(
      engine.call('tasks.create', { spec, idempotencyKey: 'K', expectedStoreId: 'old' }),
      { code: 'STORE_NAMESPACE_MISMATCH' },
    );
    assert.deepEqual(await engine.call('events.read'), before);
    const task = (await engine.call('tasks.create', {
      spec,
      idempotencyKey: 'K',
      expectedStoreId: engine.storeId,
    })) as any;
    assert.equal(task.retryIdentity.storeId, engine.storeId);
    assert.equal(task.retryIdentity.digestVersion, 1);
  } finally {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    await rm(root, { recursive: true, force: true });
  }
});

test('B08 TypeScript receipt retry keeps its original namespace on another host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-namespace-sdk-'));
  const workspace = join(root, 'work');
  await mkdir(workspace);
  const make = (name: string) =>
    createOrchestrator({
      workspace,
      stateDir: join(root, name),
      adapters: [createFakeAdapter()],
      storage: { emergencyBytes: 4096 },
    });
  const first = await make('first'),
    second = await make('second');
  try {
    const task = await first.tasks.create(spec, { idempotencyKey: 'K' });
    const identity = (task.initial as any).retryIdentity;
    assert.equal(identity.storeId, first.info.storeId);
    await assert.rejects((second as any).retry(identity, { spec }), (error: any) => {
      assert.equal(error.code, 'STORE_NAMESPACE_MISMATCH');
      assert.deepEqual(error.data.retryIdentity, identity);
      return true;
    });
    const repeated = await (first as any).retry(identity, { spec });
    assert.equal(repeated.id, task.id);
    await assert.rejects((first as any).retry(identity, { spec: { ...spec, goal: 'changed' } }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
  } finally {
    await first.close({ mode: 'interrupt', timeoutMs: 1000 });
    await second.close({ mode: 'interrupt', timeoutMs: 1000 });
    await rm(root, { recursive: true, force: true });
  }
});
