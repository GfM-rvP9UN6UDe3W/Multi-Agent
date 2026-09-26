import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Orchestrator,
  connectOrchestrator,
  createOrchestrator,
  validateWire,
} from '../../packages/sdk-typescript/src/index.ts';
import { startUnixHost } from '../../packages/cli/src/host.ts';
import { loadConfig } from '../../packages/cli/src/config.ts';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  EventEnvelope,
  RuntimeAdapter,
  RuntimeInput,
  TaskListQuery,
} from '../../packages/engine/src/types.ts';

// SPEC-0028 P05, E04, S04 and U05: the TypeScript SDK, the schema and the command-line host.

const spec = (goal: string, extra: Record<string, unknown> = {}) => ({
  goal,
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human' as const, criteria: ['Review'] },
  ...extra,
});
const rule = (version: string) => ({
  id: 'lint',
  version,
  argv: ['/usr/bin/true'],
  cwdRelative: '.',
  timeoutMs: 1000,
  permissionProfile: 'read-only' as const,
  success: { exitCode: 0 },
});

/** A fake runtime that reports usage, and holds turns whose goal starts with `hold`. */
function runtime() {
  const base = createFakeAdapter();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute(input: RuntimeInput) {
      for await (const event of base.execute(input)) {
        if (event.type !== 'accepted' && input.prompt.startsWith('hold')) await held;
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
              raw: { provider_key: 'kept' },
            },
          };
      }
    },
  };
  return { adapter, release };
}

test('0028-P05 0028-U05 0028-S04 the SDK refuses the new calls before sending to a host without them', async () => {
  const sent: string[] = [];
  const legacy = new Orchestrator(
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
        workflow: { version: 1, taskList: true, runtimeRules: true, labels: true },
      },
    },
    true,
  );
  for (const [name, attempt] of [
    ['status', () => legacy.tasks.list({ status: ['queued'] })],
    ['order', () => legacy.tasks.list({ order: 'desc' })],
    ['getMany', () => legacy.tasks.getMany(['a'])],
    ['summary', () => legacy.usage.summary('a')],
    ['retire', () => legacy.rules.retire({ id: 'lint', version: '1' })],
    ['includeRetired', () => legacy.rules.list({ includeRetired: true })],
    ['pause', () => legacy.close({ mode: 'pause' })],
  ] as const)
    await assert.rejects(
      (async () => attempt())(),
      (error: { code?: string }) => error.code === 'UNSUPPORTED_CAPABILITY',
      name,
    );
  assert.deepEqual(sent, []);
});

test('0028-P05 0028-B01 0028-E04 the new queries round-trip over a Unix host with schema-valid payloads', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-queries-sdk-')));
  const socketRoot = await realpath(await mkdtemp('/tmp/oqs-'));
  await mkdir(join(root, 'workspace'));
  const fake = runtime();
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [fake.adapter],
    limits: { maxActiveSessions: 1 },
  });
  const host = await startUnixHost(engine, { socketPath: join(socketRoot, 'rpc.sock') });
  const client = await connectOrchestrator({ socketPath: join(socketRoot, 'rpc.sock') });
  const waitFor = async (id: string, status: string) => {
    let task = await client.tasks.get(id);
    for (let i = 0; i < 400 && task.status !== status; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      task = await client.tasks.get(id);
    }
    assert.equal(task.status, status);
    return task;
  };
  try {
    const workflow = client.info.capabilities.workflow as Record<string, unknown>;
    for (const feature of ['taskQueries', 'queueReasons', 'pauseClose', 'ruleRetirement'])
      assert.equal(workflow[feature], true, feature);
    const root1 = await client.tasks.create(spec('first'));
    await waitFor(root1.id, 'waiting_approval');
    const child = await client.tasks.create(spec('child', { parentTaskId: root1.id }));
    await waitFor(child.id, 'waiting_approval');
    const holder = await client.tasks.create(spec('hold the slot'));
    await waitFor(holder.id, 'running');
    const queued = await client.tasks.create(spec('queued'));

    const listParams: TaskListQuery = {
      status: ['waiting_approval', 'running'],
      order: 'desc',
      limit: 10,
    };
    validateWire('TaskListParams', listParams);
    const listed = await client.tasks.list(listParams);
    assert.deepEqual(
      listed.tasks.map((task) => task.id),
      [holder.id, child.id, root1.id],
    );
    const waiting = await client.tasks.get(queued.id);
    assert.deepEqual(waiting.blockedBy, { reason: 'capacity', taskIds: [holder.id] });
    validateWire('TaskSnapshot', waiting);

    const manyParams = { taskIds: [queued.id, 'missing', root1.id] };
    validateWire('TaskGetManyParams', manyParams);
    const many = await client.tasks.getMany(manyParams.taskIds);
    validateWire('TaskGetManyResult', many);
    assert.deepEqual(
      many.tasks.map((task) => task.id),
      [queued.id, root1.id],
    );
    assert.deepEqual(many.missing, ['missing']);

    validateWire('UsageSummaryParams', { rootTaskId: root1.id });
    const summary = await client.usage.summary(root1.id);
    validateWire('UsageSummary', summary);
    assert.deepEqual([summary.totals.records, summary.totals.inputTokens], [2, 14]);

    const [record] = (await client.usage.get(child.id)).records;
    validateWire('UsageRecord', record);
    assert.equal(record.rootTaskId, root1.id);
    const events: EventEnvelope[] = [];
    for await (const event of client.events({ taskId: child.id })) {
      events.push(event);
      if (event.type === 'usage.recorded') break;
    }
    const recorded = events.find((event) => event.type === 'usage.recorded')!;
    validateWire('UsageRecordedData', recorded.data);
    assert.equal((recorded.data as { model: string }).model, 'fixture');

    for (const [name, value] of [
      ['TaskListParams', { status: [] }],
      ['TaskListParams', { status: ['nope'] }],
      ['TaskListParams', { order: 'newest' }],
      ['TaskGetManyParams', { taskIds: [] }],
      ['TaskGetManyParams', { taskIds: Array.from({ length: 101 }, (_, i) => `t${i}`) }],
      ['UsageSummaryParams', {}],
      ['HostShutdownParams', { mode: 'stop', timeoutMs: 1000, expectedStoreId: 's' }],
      ['RuleListParams', { includeRetired: 'yes' }],
    ] as const)
      assert.throws(() => validateWire(name, value), { code: 'INVALID_WIRE_DATA' }, name);
  } finally {
    fake.release();
    await client.close();
    await host.close({ timeoutMs: 2000 });
    await rm(root, { recursive: true, force: true });
    await rm(socketRoot, { recursive: true, force: true });
  }
});

test('0028-U05 0028-S04 rules.retire, includeRetired and a pausing close through the SDK', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-retire-sdk-')));
  await mkdir(join(root, 'workspace'));
  const orch = await createOrchestrator({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
    storage: { emergencyBytes: 4096 },
  });
  try {
    await orch.rules.register(rule('1'));
    await orch.rules.register(rule('2'));
    const params = { id: 'lint', version: '1' };
    validateWire('RuleRetireParams', {
      ...params,
      expectedStoreId: orch.info.storeId,
      idempotencyKey: 'k',
    });
    const retired = await orch.rules.retire(params);
    assert.equal(retired.initial.status, 'completed');
    validateWire('RuleListParams', { includeRetired: true });
    const all = await orch.rules.list({ includeRetired: true });
    validateWire('RuleListResult', all);
    assert.deepEqual(
      all.rules.map((item) => [item.version, 'retiredAt' in item]),
      [
        ['2', false],
        ['1', true],
      ],
    );
    assert.deepEqual(
      (await orch.rules.list()).rules.map((item) => item.version),
      ['2'],
    );
    validateWire('HostShutdownParams', {
      mode: 'pause',
      timeoutMs: 1000,
      expectedStoreId: orch.info.storeId,
    });
    const closed = await orch.close({ mode: 'pause', timeoutMs: 1000 });
    assert.equal(closed?.status, 'closed');
  } finally {
    await orch.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('0028-S04 the command-line configuration accepts shutdown.mode pause', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-pause-config-')));
  try {
    await mkdir(join(root, 'workspace'));
    await mkdir(join(root, 'state'), { mode: 0o700 });
    const path = join(root, 'config.json');
    const write = (mode: string) =>
      writeFile(
        path,
        JSON.stringify({
          workspace: join(root, 'workspace'),
          stateDir: join(root, 'state'),
          providers: { fake: { model: 'fixture' } },
          shutdown: { mode, timeoutMs: 1000 },
        }),
      );
    await write('pause');
    assert.equal((await loadConfig(path)).shutdown?.mode, 'pause');
    await write('stop');
    await assert.rejects(loadConfig(path), /shutdown\.mode/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
