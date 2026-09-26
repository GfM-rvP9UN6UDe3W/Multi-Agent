import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  Engine,
  EventPage,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeInput,
  RuntimeUsageEvent,
  TaskSnapshot,
  UsageRecord,
} from '../../packages/engine/src/types.ts';

// SPEC-0031 B: a usage observation may name its model; records, totals and costs follow it.

type Reporting = RuntimeInput & { reportUsage: (event: RuntimeUsageEvent) => void };
const counts = (input: number) => ({
  inputTokens: input,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  raw: {},
});
/** The observations each goal's dispatch reports: the main loop, then the listed models. */
const plans: Record<string, { usageId: string; model?: string; input: number }[]> = {
  priced: [
    { usageId: 'main', input: 100 },
    { usageId: 'outside-large', model: 'large', input: 100 },
  ],
  unpriced: [
    { usageId: 'main', input: 100 },
    { usageId: 'outside-euro', model: 'euro', input: 100 },
    { usageId: 'outside-other', model: 'unregistered', input: 100 },
  ],
  plain: [{ usageId: 'main', input: 100 }],
};
function reporting(inputs: Map<string, Reporting>): RuntimeAdapter {
  const fake = createFakeAdapter();
  return {
    ...fake,
    async *execute(input: RuntimeInput): AsyncIterable<RuntimeEvent> {
      inputs.set(input.taskId, input as Reporting);
      for await (const event of fake.execute(input)) {
        if (event.type === 'result') {
          for (const { usageId, model, input: tokens } of plans[input.prompt.split(' ')[0]] ?? [])
            yield {
              type: 'usage',
              usageId,
              usage: { ...counts(tokens), ...(model ? { model } : {}) },
            };
          yield { ...event, usageComplete: true };
        } else yield event;
      }
    },
  };
}
const price = (model: string, rate: string, currency = 'USD') => ({
  provider: 'fake',
  model,
  currency,
  version: 'v1',
  inputTokenMode: 'uncached' as const,
  perMillion: { input: rate, output: rate, cacheRead: rate, cacheWrite: rate },
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-usage-models-')));
  await mkdir(join(root, 'workspace'));
  const inputs = new Map<string, Reporting>();
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [reporting(inputs)],
    providers: { fake: { models: ['small', 'large'] } },
    pricing: [price('small', '1'), price('large', '2'), price('euro', '1', 'EUR')],
    budget: { currency: 'USD', maxCost: '100', reservePerDispatch: '1' },
  });
  return {
    engine,
    inputs,
    async close() {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function deliver(engine: Engine, goal: string) {
  const task = (await engine.call('tasks.create', {
    spec: {
      goal,
      runtime: { provider: 'fake', model: 'small' },
      acceptance: { mode: 'human', criteria: ['Review'] },
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
  new Map(
    ((await engine.call('usage.get', { taskId })) as { records: UsageRecord[] }).records.map(
      (record) => [record.id.split(':').at(-1)!, record],
    ),
  );

test('0031-B01 an observation’s model replaces the session’s, and an invalid one is refused', async () => {
  const f = await setup();
  try {
    const task = await deliver(f.engine, 'priced');
    const byId = await records(f.engine, task.id);
    assert.equal(byId.get('main')!.model, 'small');
    assert.equal(byId.get('outside-large')!.model, 'large');
    const input = f.inputs.get(task.id)!;
    for (const model of ['', 'x'.repeat(257), 5, null, ['large']])
      assert.throws(
        () =>
          input.reportUsage({
            type: 'usage',
            usageId: `bad-${JSON.stringify(model)}`,
            usage: { ...counts(1), model: model as never },
          }),
        { code: 'INVALID_RUNTIME_CONTRACT' },
        JSON.stringify(model),
      );
    input.reportUsage({
      type: 'usage',
      usageId: 'longest',
      usage: { ...counts(1), model: 'm'.repeat(256) },
    });
    assert.equal((await records(f.engine, task.id)).size, 3);
  } finally {
    await f.close();
  }
});

test('0031-B02 a repeated observation must resolve to its record’s model', async () => {
  const f = await setup();
  try {
    const task = await deliver(f.engine, 'priced');
    const input = f.inputs.get(task.id)!;
    const again = (usageId: string, model?: string) =>
      input.reportUsage({
        type: 'usage',
        usageId,
        usage: { ...counts(100), ...(model ? { model } : {}) },
      });
    again('outside-large', 'large');
    again('main');
    // Naming the session's model is the same as naming none.
    again('main', 'small');
    for (const [usageId, model] of [
      ['outside-large', 'small'],
      ['outside-large', undefined],
      ['main', 'large'],
    ] as const)
      assert.throws(() => again(usageId, model), { code: 'IDEMPOTENCY_CONFLICT' }, usageId);
    assert.equal((await records(f.engine, task.id)).size, 2);
  } finally {
    await f.close();
  }
});

type Costs = {
  totals: Record<string, string>;
  unknownRecords: number;
  records: { usageRecordId: string; amount: string | null; reason?: string }[];
  reservations: { status: string }[];
  settlementIncomplete: boolean;
};

test('0031-B03 each record is priced at its own model’s registered price, or is unknown', async () => {
  const f = await setup();
  try {
    const priced = await deliver(f.engine, 'priced');
    const costs = (await f.engine.call('costs.get', { taskId: priced.id })) as Costs;
    assert.deepEqual(
      costs.records.map((cost) => [cost.usageRecordId.split(':').at(-1), cost.amount]).sort(),
      [
        ['main', '0.0001'],
        ['outside-large', '0.0002'],
      ],
    );
    assert.equal(costs.totals.USD, '0.0003');
    // costs.get lists the reservations still held: none once every record is priced.
    assert.deepEqual(costs.reservations, []);
    assert.equal(costs.settlementIncomplete, false);

    const unpriced = await deliver(f.engine, 'unpriced');
    const unknown = (await f.engine.call('costs.get', { taskId: unpriced.id })) as Costs;
    assert.deepEqual(
      unknown.records
        .map((cost) => [cost.usageRecordId.split(':').at(-1), cost.amount, cost.reason ?? null])
        .sort(),
      [
        ['main', '0.0001', null],
        ['outside-euro', null, 'pricing_not_registered'],
        ['outside-other', null, 'pricing_not_registered'],
      ],
    );
    assert.equal(unknown.unknownRecords, 2);
    assert.deepEqual(
      unknown.reservations.map((reservation) => reservation.status),
      ['held'],
    );
    assert.equal(unknown.settlementIncomplete, true);
  } finally {
    await f.close();
  }
});

test('0031-B04 usage.recorded, usage.byTask and usage.summary carry each record’s own model', async () => {
  const f = await setup();
  try {
    const task = await deliver(f.engine, 'priced');
    const page = (await f.engine.call('events.read', { taskId: task.id, limit: 100 })) as EventPage;
    assert.deepEqual(
      page.events
        .filter((event) => event.type === 'usage.recorded')
        .map((event) => [String(event.data.usageRecordId).split(':').at(-1), event.data.model])
        .sort(),
      [
        ['main', 'small'],
        ['outside-large', 'large'],
      ],
    );
    type Grouped = { byModel: { model: string | null; inputTokens: number }[] };
    const [byTask] = (
      (await f.engine.call('usage.byTask', { taskIds: [task.id] })) as { tasks: Grouped[] }
    ).tasks;
    const summary = (await f.engine.call('usage.summary', { rootTaskId: task.id })) as Grouped;
    for (const grouped of [byTask, summary])
      assert.deepEqual(
        grouped.byModel.map((row) => [row.model, row.inputTokens]),
        [
          ['large', 100],
          ['small', 100],
        ],
      );
  } finally {
    await f.close();
  }
});
