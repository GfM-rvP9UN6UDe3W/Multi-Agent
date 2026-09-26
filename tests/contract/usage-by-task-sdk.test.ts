import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Orchestrator,
  connectOrchestrator,
  createOrchestrator,
  validateWire,
} from '../../packages/sdk-typescript/src/index.ts';
import { startUnixHost } from '../../packages/cli/src/host.ts';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type { RuntimeAdapter, RuntimeInput } from '../../packages/engine/src/types.ts';

// SPEC-0029 A04, B03 and D04: the TypeScript SDK and the schema.

const spec = (goal: string, extra: Record<string, unknown> = {}) => ({
  goal,
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human' as const, criteria: ['Review'] },
  ...extra,
});

/** A fake runtime that reports usage once accepted. */
function reporting(): RuntimeAdapter {
  const base = createFakeAdapter();
  return {
    ...base,
    async *execute(input: RuntimeInput) {
      for await (const event of base.execute(input)) {
        yield event;
        if (event.type === 'accepted')
          yield {
            type: 'usage',
            usageId: 'u1',
            usage: {
              inputTokens: 7,
              cachedInputTokens: 1,
              cacheWriteInputTokens: null,
              outputTokens: 3,
              raw: {},
            },
          };
      }
    },
  };
}

test('0029-A04 the SDK refuses usage.byTask before sending to a host without it', async () => {
  const sent: string[] = [];
  const earlier = new Orchestrator(
    {
      async call<T>(method: string): Promise<T> {
        sent.push(method);
        throw new Error('not reached');
      },
      disconnect() {},
    },
    {
      protocolVersion: '2.0',
      engineVersion: 'fixture',
      schemaVersion: 3,
      instanceId: 'fixture',
      storeId: 'store',
      capabilities: {
        storeNamespaces: { version: 1 },
        // The workflow features of 0.1.5.
        workflow: {
          version: 1,
          taskList: true,
          runtimeRules: true,
          labels: true,
          taskQueries: true,
          queueReasons: true,
          pauseClose: true,
          ruleRetirement: true,
        },
      },
    },
    true,
  );
  await assert.rejects(earlier.usage.byTask(['a']), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.deepEqual(sent, []);
});

test('0029-A04 0029-B03 usage.byTask and deliveredAt round-trip over a Unix host with schema-valid payloads', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-by-task-sdk-')));
  const socketRoot = await realpath(await mkdtemp('/tmp/obt-'));
  await mkdir(join(root, 'workspace'));
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [reporting()],
  });
  const host = await startUnixHost(engine, { socketPath: join(socketRoot, 'rpc.sock') });
  const client = await connectOrchestrator({ socketPath: join(socketRoot, 'rpc.sock') });
  try {
    assert.equal((client.info.capabilities.workflow as Record<string, unknown>).usageByTask, true);
    const first = await client.tasks.create(spec('first'));
    const second = await client.tasks.create(spec('second'));
    for (const id of [first.id, second.id])
      for (let i = 0; i < 400 && (await client.tasks.get(id)).status !== 'waiting_approval'; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
    const params = { taskIds: [second.id, 'missing', first.id] };
    validateWire('UsageByTaskParams', params);
    const result = await client.usage.byTask(params.taskIds);
    validateWire('UsageByTaskResult', result);
    assert.deepEqual(
      result.tasks.map((task) => [task.taskId, task.totals.inputTokens, task.completeness]),
      [
        [second.id, 7, 'reported'],
        [first.id, 7, 'reported'],
      ],
    );
    assert.deepEqual(result.missing, ['missing']);
    const delivered = await client.tasks.get(first.id);
    assert.equal(typeof delivered.deliveredAt, 'string');
    validateWire('TaskSnapshot', delivered);
    for (const [name, value] of [
      ['UsageByTaskParams', { taskIds: [] }],
      ['UsageByTaskParams', { taskIds: Array.from({ length: 101 }, (_, i) => `t${i}`) }],
      ['UsageByTaskParams', {}],
      ['TaskSnapshot', { ...delivered, deliveredAt: 5 }],
      ['TaskSnapshot', { ...delivered, pausedByClose: { operationId: 'x' } }],
    ] as const)
      assert.throws(() => validateWire(name, value), { code: 'INVALID_WIRE_DATA' }, name);
  } finally {
    await client.close();
    await host.close({ timeoutMs: 2000 });
    await rm(root, { recursive: true, force: true });
    await rm(socketRoot, { recursive: true, force: true });
  }
});

test('0029-C01 0029-D04 reactivation and pausedByClose through the in-process SDK', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-reactivate-sdk-')));
  await mkdir(join(root, 'workspace'));
  const config = {
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter({ delayMs: 60_000 })],
    limits: { maxActiveSessions: 1 },
    storage: { emergencyBytes: 4096 },
  };
  const rule = {
    id: 'lint',
    version: '1',
    argv: ['/usr/bin/true'],
    cwdRelative: '.',
    timeoutMs: 1000,
    permissionProfile: 'read-only' as const,
    success: { exitCode: 0 },
  };
  let orch = await createOrchestrator(config);
  try {
    await orch.rules.register(rule);
    await orch.rules.retire({ id: 'lint', version: '1' });
    const again = await orch.rules.register(rule);
    assert.equal((again.initial.result as { reactivated?: boolean }).reactivated, true);
    assert.deepEqual(
      (await orch.rules.list()).rules.map((item) => item.version),
      ['1'],
    );
    const running = await orch.tasks.create(spec('running turn'));
    for (let i = 0; i < 400 && (await orch.tasks.get(running.id)).status !== 'running'; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const queued = await orch.tasks.create(spec('queued task'));
    const closed = await orch.close({ mode: 'pause', timeoutMs: 5000 });
    orch = await createOrchestrator(config);
    const turn = await orch.tasks.get(running.id);
    const waiting = await orch.tasks.get(queued.id);
    validateWire('TaskSnapshot', turn);
    validateWire('TaskSnapshot', waiting);
    assert.deepEqual(turn.pausedByClose, { operationId: closed?.operationId, wasRunning: true });
    assert.deepEqual(waiting.pausedByClose, {
      operationId: closed?.operationId,
      wasRunning: false,
    });
  } finally {
    await orch.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
