import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type { TaskSnapshot, RuntimeEvent } from '../../packages/engine/src/types.ts';

test('AC-F10 concurrent root budgets reserve before dispatch and keep unknown usage reserved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-money-'));
  await mkdir(join(dir, 'workspace'));
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const fake = createFakeAdapter();
  const config = {
    workspace: join(dir, 'workspace'),
    stateDir: join(dir, 'state'),
    pricing: [
      {
        provider: 'fake',
        model: 'fixture',
        currency: 'USD',
        version: 'fixture',
        inputTokenMode: 'uncached' as const,
        perMillion: { input: '10', output: '10', cacheRead: '1', cacheWrite: '12.5' },
      },
    ],
    budget: { currency: 'USD', maxCost: '1', reservePerDispatch: '0.75' },
    adapters: [
      {
        ...fake,
        async *execute(input: Parameters<typeof fake.execute>[0]): AsyncIterable<RuntimeEvent> {
          calls++;
          await hold;
          if (!input.prompt.includes('unknown'))
            yield {
              type: 'usage',
              usageId: 'bill-1',
              usage: {
                inputTokens: 10000,
                outputTokens: 0,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
                raw: {},
              },
            };
          for await (const event of fake.execute(input))
            yield event.type === 'result'
              ? { ...event, usageComplete: !input.prompt.includes('unknown') }
              : event;
        },
      },
    ],
  };
  const engine = await createEngine(config);
  const spec = {
    goal: 'first',
    runtime: { provider: 'fake', model: 'fixture' },
    acceptance: { mode: 'human', criteria: ['review'] },
  };
  try {
    const first = (await engine.call('tasks.create', {
      spec,
      idempotencyKey: 'one',
    })) as TaskSnapshot;
    const second = (await engine.call('tasks.create', {
      spec: { ...spec, goal: 'unknown second' },
      idempotencyKey: 'two',
    })) as TaskSnapshot;
    await new Promise((done) => setTimeout(done, 5));
    assert.equal(calls, 1);
    assert.equal(
      ((await engine.call('tasks.get', { taskId: second.id })) as TaskSnapshot).reason,
      'HOST_BUDGET_EXHAUSTED',
    );
    release();
    while (
      ((await engine.call('tasks.get', { taskId: first.id })) as TaskSnapshot).status !==
      'waiting_approval'
    )
      await new Promise((done) => setTimeout(done, 2));
    const firstCost = (await engine.call('costs.get', { taskId: first.id, scope: 'direct' })) as {
      totals: { USD: string };
      settlementIncomplete: boolean;
    };
    assert.equal(firstCost.totals.USD, '0.1');
    assert.equal(firstCost.settlementIncomplete, false);
    await engine.call('tasks.resume', { taskId: second.id, idempotencyKey: 'resume-two' });
    while (
      ((await engine.call('tasks.get', { taskId: second.id })) as TaskSnapshot).status !==
      'waiting_approval'
    )
      await new Promise((done) => setTimeout(done, 2));
    assert.equal(calls, 2);
    const secondCost = (await engine.call('costs.get', { taskId: second.id })) as {
      settlementIncomplete: boolean;
      reservations: { remaining: string }[];
    };
    assert.equal(secondCost.settlementIncomplete, true);
    assert.equal(secondCost.reservations[0].remaining, '0.75');
    const third = (await engine.call('tasks.create', {
      spec,
      idempotencyKey: 'three',
    })) as TaskSnapshot;
    await new Promise((done) => setTimeout(done, 5));
    assert.equal(
      ((await engine.call('tasks.get', { taskId: third.id })) as TaskSnapshot).reason,
      'HOST_BUDGET_EXHAUSTED',
    );
    assert.equal(calls, 2);
  } finally {
    release();
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    await rm(dir, { recursive: true, force: true });
  }
});
test('AC-C03/F10 exact decimal token pricing normalizes cache overlap and preserves unknowns', async () => {
  const { priceUsage, estimateStrategies } = await import(
    '../../packages/engine/src/accounting.ts'
  );
  const pricing = {
    provider: 'fixture',
    model: 'm',
    currency: 'USD',
    version: '2026-09-fixture',
    inputTokenMode: 'total' as const,
    perMillion: { input: '3', cacheRead: '0.3', cacheWrite: '3.75', output: '15' },
  };
  const cost = priceUsage(
    { inputTokens: 1000, cachedInputTokens: 500, cacheWriteInputTokens: 100, outputTokens: 20 },
    pricing,
  );
  assert.equal(cost.amount, '0.002025');
  assert.deepEqual(cost.tokens, { ordinary: 400, cached: 500, cacheWrite: 100, output: 20 });
  assert.equal(
    priceUsage(
      { inputTokens: 1000, cachedInputTokens: null, cacheWriteInputTokens: 0, outputTokens: 20 },
      pricing,
    ).amount,
    null,
  );
  const comparison = estimateStrategies({
    pricing,
    keep: [
      { inputTokens: 1000, cachedInputTokens: 900, cacheWriteInputTokens: 0, outputTokens: 20 },
      { inputTokens: 1100, cachedInputTokens: 1000, cacheWriteInputTokens: 0, outputTokens: 20 },
    ],
    compact: [
      { inputTokens: 200, cachedInputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 20 },
    ],
    compaction: {
      inputTokens: 1000,
      cachedInputTokens: 900,
      cacheWriteInputTokens: 0,
      outputTokens: 100,
    },
    intervalsKnown: false,
  });
  assert.equal(comparison.automaticSelection, false);
  assert.equal(comparison.reason, 'unknown_future_intervals');
  assert.notEqual(comparison.compact.amount, comparison.keep.amount);
});

test('AC-F10 late costs retain their original owner across history reuse and tree totals deduplicate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-late-cost-'));
  await mkdir(join(dir, 'work'));
  const base = createFakeAdapter();
  const inputs = new Map<string, Parameters<typeof base.execute>[0]>();
  const engine = await createEngine({
    workspace: join(dir, 'work'),
    stateDir: join(dir, 'state'),
    pricing: [
      {
        provider: 'fake',
        model: 'fixture',
        currency: 'USD',
        version: 'v1',
        inputTokenMode: 'uncached',
        perMillion: { input: '1', output: '1', cacheRead: '1', cacheWrite: '1' },
      },
    ],
    budget: { currency: 'USD', maxCost: '10', reservePerDispatch: '1' },
    adapters: [
      {
        ...base,
        async *execute(input) {
          inputs.set(input.taskId, input);
          for await (const event of base.execute(input))
            yield event.type === 'result' ? { ...event, usageComplete: true } : event;
        },
      },
    ],
  });
  const spec = {
    goal: 'root',
    runtime: { provider: 'fake', model: 'fixture' },
    acceptance: { mode: 'human', criteria: ['review'] },
  };
  const ready = async (id: string) => {
    for (let n = 0; n < 400; n++) {
      const task = (await engine.call('tasks.get', { taskId: id })) as TaskSnapshot;
      if (task.status === 'waiting_approval') return task;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('deadline');
  };
  try {
    const root = (await engine.call('tasks.create', {
      spec,
      idempotencyKey: 'root',
    })) as TaskSnapshot;
    const done = await ready(root.id);
    await engine.call('approvals.decide', {
      approvalId: done.approvalId,
      decision: { choice: 'approve', expectedRevision: 1 },
      idempotencyKey: 'approve',
    });
    const child = (await engine.call('tasks.create', {
      spec: {
        ...spec,
        goal: 'child reuses history',
        parentTaskId: root.id,
        contextPlan: {
          requestedMode: 'reuse',
          independent: true,
          candidateSessionId: root.sessionId,
        },
      },
      idempotencyKey: 'child',
    })) as TaskSnapshot;
    await ready(child.id);
    assert.equal(child.sessionId, root.sessionId);
    const usage = (n: number) => ({
      type: 'usage' as const,
      usageId: 'same-upstream-id',
      usage: {
        inputTokens: n,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        raw: {},
      },
    });
    inputs.get(child.id)!.reportUsage!(usage(2000));
    inputs.get(root.id)!.reportUsage!(usage(1000));
    inputs.get(root.id)!.reportUsage!(usage(1000));
    const direct = (await engine.call('costs.get', { taskId: root.id })) as any;
    const tree = (await engine.call('costs.get', { taskId: root.id, scope: 'tree' })) as any;
    assert.equal(direct.totals.USD, '0.001');
    assert.equal(direct.recordCount, 1);
    assert.equal(tree.totals.USD, '0.003');
    assert.equal(tree.recordCount, 2);
    assert.equal(tree.settlementIncomplete, false);
    assert.equal(
      ((await engine.call('costs.get', { taskId: child.id })) as any).totals.USD,
      '0.002',
    );
    const overhead = {
      billingId: 'fixture-overhead',
      currency: 'USD',
      amount: '0.01',
      pricingVersion: 'v1',
      summary: 'fixture maintenance',
      idempotencyKey: 'overhead',
    };
    await engine.call('costs.recordOverhead', overhead, { owner: true });
    await engine.call('costs.recordOverhead', overhead, { owner: true });
    assert.equal(
      ((await engine.call('costs.get', { scope: 'host_overhead' })) as any).totals.USD,
      '0.01',
    );
    assert.equal(
      ((await engine.call('costs.get', { taskId: root.id, scope: 'tree' })) as any).totals.USD,
      '0.003',
    );
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
