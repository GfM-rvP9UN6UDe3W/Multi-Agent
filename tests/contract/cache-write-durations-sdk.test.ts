import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectOrchestrator, validateWire } from '../../packages/sdk-typescript/src/index.ts';
import { startUnixHost } from '../../packages/cli/src/host.ts';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type { RuntimeAdapter, RuntimeInput } from '../../packages/engine/src/types.ts';

// SPEC-0030 A05: the split of cache writes over a Unix host, checked against the schema.

/** A fake runtime whose goal `split=a/b` splits its cache writes and `whole=n` does not. */
function reporting(): RuntimeAdapter {
  const fake = createFakeAdapter();
  return {
    ...fake,
    async *execute(input: RuntimeInput) {
      for await (const event of fake.execute(input)) {
        yield event;
        if (event.type !== 'accepted') continue;
        const split = /split=(\d+)\/(\d+)/.exec(input.prompt);
        const whole = Number(/whole=(\d+)/.exec(input.prompt)?.[1] ?? 0);
        yield {
          type: 'usage',
          usageId: 'u1',
          usage: {
            inputTokens: 7,
            cachedInputTokens: 1,
            cacheWriteInputTokens: split ? Number(split[1]) + Number(split[2]) : whole,
            ...(split
              ? {
                  cacheWrite5mInputTokens: Number(split[1]),
                  cacheWrite1hInputTokens: Number(split[2]),
                }
              : {}),
            outputTokens: 3,
            raw: {},
          },
        };
      }
    },
  };
}

test('0030-A05 the split round-trips over a Unix host with schema-valid payloads', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-cache-write-sdk-')));
  const socketRoot = await realpath(await mkdtemp('/tmp/ocw-'));
  await mkdir(join(root, 'workspace'));
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [reporting()],
  });
  const host = await startUnixHost(engine, { socketPath: join(socketRoot, 'rpc.sock') });
  const client = await connectOrchestrator({ socketPath: join(socketRoot, 'rpc.sock') });
  const spec = (goal: string) => ({
    goal,
    runtime: { provider: 'fake', model: 'fixture' },
    acceptance: { mode: 'human' as const, criteria: ['Review'] },
  });
  try {
    const split = await client.tasks.create(spec('split=9/3'));
    const whole = await client.tasks.create(spec('whole=7'));
    for (const id of [split.id, whole.id])
      for (let i = 0; i < 400 && (await client.tasks.get(id)).status !== 'waiting_approval'; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));

    const byTask = await client.usage.byTask([split.id, whole.id]);
    validateWire('UsageByTaskResult', byTask);
    assert.deepEqual(
      byTask.tasks.map(({ totals }) => [
        totals.cacheWriteInputTokens,
        totals.cacheWrite5mInputTokens,
        totals.cacheWrite1hInputTokens,
      ]),
      [
        [12, 9, 3],
        [7, 0, 0],
      ],
    );
    assert.deepEqual(
      byTask.tasks[0].byModel.map((entry) => [
        entry.cacheWrite5mInputTokens,
        entry.cacheWrite1hInputTokens,
      ]),
      [[9, 3]],
    );
    const summary = await client.usage.summary(split.id);
    validateWire('UsageSummary', summary);
    assert.equal(summary.totals.cacheWrite1hInputTokens, 3);

    const [record] = (await client.usage.get(split.id)).records;
    validateWire('UsageRecord', record);
    assert.equal(record.cacheWrite5mInputTokens, 9);
    const [plain] = (await client.usage.get(whole.id)).records;
    validateWire('UsageRecord', plain);
    assert.equal(Object.hasOwn(plain, 'cacheWrite5mInputTokens'), false);
    const recorded = (await client.events.read({ taskId: split.id })).events.find(
      (event) => event.type === 'usage.recorded',
    )!;
    validateWire('UsageRecordedData', recorded.data);
    assert.equal(recorded.data.cacheWrite1hInputTokens, 3);

    const { cacheWrite5mInputTokens: _five, ...withoutFive } = summary.totals;
    const { cacheWrite1hInputTokens: _one, ...withoutOne } = summary.byModel[0];
    for (const [name, value] of [
      ['UsageTotals', withoutFive],
      ['UsageTotals', { ...summary.totals, cacheWrite1hInputTokens: -1 }],
      ['UsageModelTotals', withoutOne],
      ['UsageRecord', { ...record, cacheWrite5mInputTokens: 1.5 }],
      ['UsageRecord', { ...record, cacheWrite1hInputTokens: null }],
      ['UsageRecordedData', { ...recorded.data, cacheWrite5mInputTokens: '9' }],
    ] as const)
      assert.throws(() => validateWire(name, value), { code: 'INVALID_WIRE_DATA' }, name);
  } finally {
    await client.close();
    await host.close({ timeoutMs: 2000 });
    await rm(root, { recursive: true, force: true });
    await rm(socketRoot, { recursive: true, force: true });
  }
});
