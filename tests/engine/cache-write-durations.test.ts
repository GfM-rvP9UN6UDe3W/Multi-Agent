import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter, openReadOnlyEngine } from '../fixtures/engine.ts';
import type {
  Engine,
  EventPage,
  RuntimeAdapter,
  RuntimeInput,
  RuntimeUsageEvent,
  TaskSnapshot,
  UsageRecord,
} from '../../packages/engine/src/types.ts';

// SPEC-0030 A: cache writes split by how long they live, reported by a runtime and totalled.

type Usage = RuntimeUsageEvent['usage'];
type Reporting = RuntimeInput & { reportUsage: (event: RuntimeUsageEvent) => void };
type Totals = {
  records: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  cacheWrite5mInputTokens: number;
  cacheWrite1hInputTokens: number;
  outputTokens: number;
  unknownRecords: number;
};
type Grouped = {
  byModel: (Totals & { provider: string; model: string | null })[];
  totals: Totals;
};

const base = {
  inputTokens: 100,
  cachedInputTokens: 10,
  cacheWriteInputTokens: 12,
  outputTokens: 5,
  raw: {},
};
/** The usage a goal asks for: `split=a/b` splits its cache writes, `whole=n` does not. */
function usageOf(prompt: string): Usage {
  const split = /split=(\d+)\/(\d+)/.exec(prompt);
  if (split)
    return {
      ...base,
      cacheWriteInputTokens: Number(split[1]) + Number(split[2]),
      cacheWrite5mInputTokens: Number(split[1]),
      cacheWrite1hInputTokens: Number(split[2]),
    };
  return { ...base, cacheWriteInputTokens: Number(/whole=(\d+)/.exec(prompt)?.[1] ?? 0) };
}
/** A fake runtime that reports the usage its goal asks for, and keeps each task's input. */
function reporting(inputs: Map<string, Reporting>): RuntimeAdapter {
  const fake = createFakeAdapter();
  return {
    ...fake,
    async *execute(input: RuntimeInput) {
      inputs.set(input.taskId, input as Reporting);
      for await (const event of fake.execute(input)) {
        yield event;
        if (event.type === 'accepted')
          yield { type: 'usage', usageId: 'u1', usage: usageOf(input.prompt) };
      }
    },
  };
}
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-cache-write-')));
  await mkdir(join(root, 'workspace'));
  const stateDir = join(root, 'state');
  const inputs = new Map<string, Reporting>();
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir,
    adapters: [reporting(inputs)],
    providers: { fake: { models: ['small', 'large'] } },
  });
  return {
    engine,
    stateDir,
    inputs,
    async close() {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function deliver(
  engine: Engine,
  goal: string,
  model = 'small',
  extra: Record<string, unknown> = {},
) {
  const task = (await engine.call('tasks.create', {
    spec: {
      goal,
      runtime: { provider: 'fake', model },
      acceptance: { mode: 'human', criteria: ['Review'] },
      ...extra,
    },
    idempotencyKey: crypto.randomUUID(),
  })) as TaskSnapshot;
  for (let i = 0; i < 400; i++) {
    const current = (await engine.call('tasks.get', { taskId: task.id })) as TaskSnapshot;
    if (current.status === 'waiting_approval') return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${task.id} did not deliver`);
}
const records = async (engine: Engine, taskId: string) =>
  ((await engine.call('usage.get', { taskId })) as { records: UsageRecord[] }).records;
const report = (input: Reporting, usageId: string, usage: Usage) =>
  input.reportUsage({ type: 'usage', usageId, usage });

test('0030-A02 an observation splits its cache writes into two counts that add up, or not at all', async () => {
  const f = await setup();
  try {
    const task = await deliver(f.engine, 'whole=0');
    const input = f.inputs.get(task.id)!;
    for (const [name, usage] of [
      ['one count', { ...base, cacheWrite5mInputTokens: 12 }],
      ['the other count', { ...base, cacheWrite1hInputTokens: 12 }],
      [
        'counts that do not add up',
        { ...base, cacheWrite5mInputTokens: 5, cacheWrite1hInputTokens: 5 },
      ],
      ['a negative count', { ...base, cacheWrite5mInputTokens: 13, cacheWrite1hInputTokens: -1 }],
      ['a fraction', { ...base, cacheWrite5mInputTokens: 11.5, cacheWrite1hInputTokens: 0.5 }],
      ['a null count', { ...base, cacheWrite5mInputTokens: null, cacheWrite1hInputTokens: 12 }],
      [
        'no cache-write count',
        {
          ...base,
          cacheWriteInputTokens: null,
          cacheWrite5mInputTokens: 0,
          cacheWrite1hInputTokens: 0,
        },
      ],
    ] as const)
      assert.throws(
        () => report(input, `bad ${name}`, usage as unknown as Usage),
        { code: 'INVALID_RUNTIME_CONTRACT' },
        name,
      );
    assert.equal((await records(f.engine, task.id)).length, 1);
    report(input, 'split', { ...base, cacheWrite5mInputTokens: 9, cacheWrite1hInputTokens: 3 });
    report(input, 'zero', {
      ...base,
      cacheWriteInputTokens: 0,
      cacheWrite5mInputTokens: 0,
      cacheWrite1hInputTokens: 0,
    });
    assert.equal((await records(f.engine, task.id)).length, 3);
  } finally {
    await f.close();
  }
});

test('0030-A03 the record and usage.recorded hold the split only when reported, and a repeat is compared on it', async () => {
  const f = await setup();
  try {
    const task = await deliver(f.engine, 'split=9/3');
    const input = f.inputs.get(task.id)!;
    report(input, 'plain', base);
    const byId = new Map((await records(f.engine, task.id)).map((r) => [r.id.split(':')[1], r]));
    assert.equal(byId.get('u1')!.cacheWrite5mInputTokens, 9);
    assert.equal(byId.get('u1')!.cacheWrite1hInputTokens, 3);
    assert.equal(Object.hasOwn(byId.get('plain')!, 'cacheWrite5mInputTokens'), false);
    assert.equal(Object.hasOwn(byId.get('plain')!, 'cacheWrite1hInputTokens'), false);
    const page = (await f.engine.call('events.read', { taskId: task.id, limit: 100 })) as EventPage;
    const recorded = new Map(
      page.events
        .filter((event) => event.type === 'usage.recorded')
        .map((event) => [String(event.data.usageRecordId).split(':')[1], event.data]),
    );
    assert.equal(recorded.get('u1')!.cacheWrite5mInputTokens, 9);
    assert.equal(recorded.get('u1')!.cacheWrite1hInputTokens, 3);
    assert.equal(Object.hasOwn(recorded.get('plain')!, 'cacheWrite5mInputTokens'), false);
    assert.equal(Object.hasOwn(recorded.get('plain')!, 'cacheWrite1hInputTokens'), false);
    // The same observation again is accepted once; another split, or none, is a conflict.
    report(input, 'u1', { ...base, cacheWrite5mInputTokens: 9, cacheWrite1hInputTokens: 3 });
    for (const usage of [{ ...base, cacheWrite5mInputTokens: 3, cacheWrite1hInputTokens: 9 }, base])
      assert.throws(() => report(input, 'u1', usage), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal((await records(f.engine, task.id)).length, 2);
  } finally {
    await f.close();
  }
});

const totals = (write: number, fiveMinutes: number, oneHour: number, count = 1): Totals => ({
  records: count,
  inputTokens: 100 * count,
  cachedInputTokens: 10 * count,
  cacheWriteInputTokens: write,
  cacheWrite5mInputTokens: fiveMinutes,
  cacheWrite1hInputTokens: oneHour,
  outputTokens: 5 * count,
  unknownRecords: 0,
});

test('0030-A04 0030-A05 totals sum each duration over the records that split, per model, online and read-only', async () => {
  const f = await setup();
  try {
    const root = await deliver(f.engine, 'split=9/3');
    const plain = await deliver(f.engine, 'whole=7');
    const large = await deliver(f.engine, 'split=0/4', 'large');
    const child = await deliver(f.engine, 'split=2/0', 'large', { parentTaskId: root.id });
    // A second record of the root without a split, as a record written before 0.1.7 is.
    report(f.inputs.get(root.id)!, 'older', { ...base, cacheWriteInputTokens: 5 });
    const taskIds = [root.id, plain.id, large.id, child.id];
    const byTask = (await f.engine.call('usage.byTask', { taskIds })) as {
      tasks: (Grouped & { taskId: string })[];
    };
    assert.deepEqual(
      byTask.tasks.map((task) => task.totals),
      [totals(17, 9, 3, 2), totals(7, 0, 0), totals(4, 0, 4), totals(2, 2, 0)],
    );
    // The cache writes without a split are the difference.
    const [rootTotals] = byTask.tasks;
    assert.equal(
      rootTotals.totals.cacheWriteInputTokens -
        rootTotals.totals.cacheWrite5mInputTokens -
        rootTotals.totals.cacheWrite1hInputTokens,
      5,
    );
    const summary = (await f.engine.call('usage.summary', { rootTaskId: root.id })) as Grouped;
    assert.deepEqual(summary.byModel, [
      { provider: 'fake', model: 'large', ...totals(2, 2, 0) },
      { provider: 'fake', model: 'small', ...totals(17, 9, 3, 2) },
    ]);
    assert.deepEqual(summary.totals, totals(19, 11, 3, 3));
    const reader = await openReadOnlyEngine({ stateDir: f.stateDir });
    try {
      assert.deepEqual(await reader.call('usage.byTask', { taskIds }), byTask);
      assert.deepEqual(await reader.call('usage.summary', { rootTaskId: root.id }), summary);
    } finally {
      await reader.close();
    }
  } finally {
    await f.close();
  }
});
