import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import { Store } from '../../packages/engine/src/store.ts';
import type {
  EventPage,
  RuntimeEvent,
  RuntimeInput,
  TaskSnapshot,
  UsageRecord,
} from '../../packages/engine/src/types.ts';
import { withClaudeProcess } from '../fixtures/claude-process.ts';

type UsageEvent = Extract<RuntimeEvent, { type: 'usage' }>;
type ReportingInput = RuntimeInput & { reportUsage: (event: UsageEvent) => void };
const nativeUsage = {
  input_tokens: 17,
  output_tokens: 4,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 2,
};
const usage: UsageEvent = {
  type: 'usage',
  usageId: 'native-usage-1',
  usage: {
    inputTokens: 17,
    cachedInputTokens: 3,
    cacheWriteInputTokens: 2,
    outputTokens: 4,
    raw: nativeUsage,
  },
};

async function fixture(t: TestContext, emit = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'host-usage-')));
  await mkdir(join(root, 'workspace'));
  const fake = createFakeAdapter();
  let input!: ReportingInput;
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [
      {
        ...fake,
        async *execute(value) {
          input = value as ReportingInput;
          if (emit) {
            yield usage;
            yield usage;
          }
          yield* fake.execute(value);
        },
      },
    ],
  });
  t.after(async () => {
    await engine.close({ mode: 'drain', timeoutMs: 1000 });
    await rm(root, { recursive: true, force: true });
  });
  const created = (await engine.call('tasks.create', {
    spec: {
      goal: 'Offline usage contract',
      runtime: { provider: 'fake', model: 'offline' },
      acceptance: { mode: 'human', criteria: ['Fixture review'] },
    },
    idempotencyKey: 'task',
  })) as TaskSnapshot;
  const deadline = performance.now() + 2000;
  while (
    ((await engine.call('tasks.get', { taskId: created.id })) as TaskSnapshot).status !==
    'waiting_approval'
  ) {
    assert.ok(performance.now() < deadline, 'fixture result must reach task review');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return {
    engine,
    input,
    taskId: created.id,
    async events() {
      return ((await engine.call('events.read', { taskId: created.id })) as EventPage).events;
    },
    async records() {
      return (
        (await engine.call('usage.get', { taskId: created.id })) as { records: UsageRecord[] }
      ).records;
    },
  };
}

test('AC-P06 failed Claude terminals preserve the same reported usage as success', async () => {
  for (const subtype of ['error_max_turns', 'success']) {
    const observed: UsageEvent[] = [];
    const adapter = createClaudeAdapter({
      query: withClaudeProcess(() =>
        (async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'native-session' };
          yield {
            type: 'result',
            subtype,
            session_id: 'native-session',
            ...(subtype === 'success' ? { result: 'done' } : { is_error: true, errors: ['limit'] }),
            usage: nativeUsage,
          };
        })(),
      ),
    });
    const input: ReportingInput = {
      taskId: 'task',
      sessionId: 'session',
      dispatchId: 'dispatch',
      providerSessionId: null,
      workspace: process.cwd(),
      stateDir: '/private/tmp/unused-host-usage-state',
      model: 'offline',
      prompt: 'fixture',
      permissionProfile: 'read-only',
      signal: new AbortController().signal,
      reportUsage: (event) => observed.push(event),
    };
    const events: RuntimeEvent[] = [];
    try {
      for await (const event of adapter.execute(input)) events.push(event);
      assert.deepEqual(
        events.filter((event) => event.type === 'usage').map((event) => event.usage),
        [usage.usage],
      );
      assert.deepEqual(
        observed.map((event) => event.usage),
        [usage.usage],
      );
      assert.equal(events.at(-1)?.type, subtype === 'success' ? 'result' : 'error');
    } finally {
      await adapter.close();
    }
  }
});

test('AC-P07 yielded duplicate usage produces one durable notification and exact-record read', async (t) => {
  const f = await fixture(t, true);
  const records = await f.records();
  assert.equal(records.length, 1);
  const notifications = (await f.events()).filter((event) => event.type === 'usage.recorded');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].data.usageRecordId, records[0].id);
  assert.equal(notifications[0].data.dispatchId, records[0].dispatchId);
  assert.deepEqual(
    await f.engine.call('usage.getRecord', { usageRecordId: records[0].id }),
    records[0],
  );
  await assert.rejects(f.engine.call('usage.getRecord', { usageRecordId: 'missing' }), {
    code: 'NOT_FOUND',
  });
  await assert.rejects(f.engine.call('usage.getRecord', { usageRecordId: '' }), {
    code: 'VALIDATION_ERROR',
  });
});

test('AC-P07 late usage callback deduplicates and cannot revive a terminal observation', async (t) => {
  const f = await fixture(t, true);
  assert.equal(typeof f.input.reportUsage, 'function');
  const before = await f.engine.call('tasks.get', { taskId: f.taskId });
  const occupancy = await f.engine.call('scheduler.get');
  f.input.reportUsage(usage);
  f.input.reportUsage({ ...usage, usageId: 'late' });
  assert.equal((await f.records()).length, 2);
  assert.equal((await f.events()).filter((event) => event.type === 'usage.recorded').length, 2);
  assert.deepEqual(await f.engine.call('tasks.get', { taskId: f.taskId }), before);
  assert.deepEqual(await f.engine.call('scheduler.get'), occupancy);
  assert.throws(
    () => f.input.reportUsage({ ...usage, usage: { ...usage.usage, inputTokens: 99 } }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  assert.equal((await f.records())[0].inputTokens, 17);
  assert.equal((await f.events()).filter((event) => event.type === 'usage.recorded').length, 2);
});

test('AC-P07 usage row and notification roll back together when event persistence fails', async (t) => {
  const f = await fixture(t);
  assert.equal(typeof f.input.reportUsage, 'function');
  const original = Store.prototype.event;
  Store.prototype.event = function (type, ...rest) {
    if (type === 'usage.recorded') throw new Error('offline event write failure');
    return original.call(this, type, ...rest);
  };
  try {
    assert.throws(() => f.input.reportUsage(usage), /offline event write failure/);
  } finally {
    Store.prototype.event = original;
  }
  assert.equal((await f.records()).length, 0);
  assert.equal((await f.events()).filter((event) => event.type === 'usage.recorded').length, 0);
});

test('AC-P06 resumed or initialized session mismatch cannot publish usage', async () => {
  for (const resumed of [true, false]) {
    const observed: UsageEvent[] = [];
    const adapter = createClaudeAdapter({
      query: withClaudeProcess(() =>
        (async function* () {
          if (!resumed) yield { type: 'system', subtype: 'init', session_id: 'expected' };
          yield {
            type: 'result',
            subtype: 'success',
            session_id: 'wrong',
            result: 'wrong',
            usage: nativeUsage,
          };
        })(),
      ),
    });
    try {
      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute({
        taskId: 't',
        sessionId: 's',
        dispatchId: 'd',
        providerSessionId: resumed ? 'expected' : null,
        workspace: process.cwd(),
        stateDir: '/private/tmp/unused-host-usage-state',
        model: 'offline',
        prompt: 'fixture',
        permissionProfile: 'read-only',
        signal: new AbortController().signal,
        reportUsage: (value) => observed.push(value),
      }))
        events.push(event);
      assert.deepEqual(observed, []);
      assert.equal(
        events.some((event) => event.type === 'usage'),
        false,
      );
      assert.equal(events.at(-1)?.type, 'error');
    } finally {
      await adapter.close();
    }
  }
});

test('AC-P06 cleanup uncertainty and late terminal retain usage with unknown fields', async () => {
  for (const late of [false, true]) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed: UsageEvent[] = [];
    const adapter = createClaudeAdapter({
      cleanupTimeoutMs: 20,
      turnTimeoutMs: 40,
      query: withClaudeProcess(
        () =>
          (async function* () {
            yield { type: 'system', subtype: 'init', session_id: 'expected' };
            if (late) await gate;
            yield {
              type: 'result',
              subtype: 'error_max_turns',
              session_id: 'expected',
              usage: { input_tokens: 17 },
            };
          })(),
        gate,
      ),
    });
    try {
      const events: RuntimeEvent[] = [];
      for await (const event of adapter.execute({
        taskId: 't',
        sessionId: 's',
        dispatchId: 'd',
        providerSessionId: null,
        workspace: process.cwd(),
        stateDir: '/private/tmp/unused-host-usage-state',
        model: 'offline',
        prompt: 'fixture',
        permissionProfile: 'read-only',
        signal: new AbortController().signal,
        reportUsage: (value) => observed.push(value),
      }))
        events.push(event);
      assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
      release();
      const deadline = performance.now() + 2000;
      while (!observed.length) {
        assert.ok(performance.now() < deadline);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.deepEqual(observed[0].usage, {
        inputTokens: 17,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        outputTokens: null,
        raw: { input_tokens: 17 },
      });
      if (!late) assert.equal(events.filter((event) => event.type === 'usage').length, 1);
    } finally {
      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await adapter.close();
    }
  }
});

test('AC-P07 invalid usage never persists and raw payload is a detached snapshot', async (t) => {
  const f = await fixture(t);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const raw of [
    cyclic,
    { secret: undefined },
    new Date(),
    { n: Infinity },
    { huge: 'x'.repeat(524289) },
  ]) {
    assert.throws(
      () => f.input.reportUsage({ ...usage, usage: { ...usage.usage, raw: raw as never } }),
      { code: 'INVALID_RUNTIME_CONTRACT' },
    );
  }
  assert.throws(
    () => f.input.reportUsage({ ...usage, usage: { ...usage.usage, inputTokens: -1 } }),
    { code: 'INVALID_RUNTIME_CONTRACT' },
  );
  assert.equal((await f.records()).length, 0);
  const raw = { input_tokens: 17, nested: { fixture: true } };
  f.input.reportUsage({ ...usage, usage: { ...usage.usage, raw } });
  raw.nested.fixture = false;
  assert.deepEqual((await f.records())[0].raw, { input_tokens: 17, nested: { fixture: true } });
});

test('AC-P07 persisting late usage does not suppress the dispatch deadline check', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'usage-budget-')));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  let mono = 0;
  let statusAfterUsage: string | undefined;
  const fake = createFakeAdapter();
  const engine = await createEngine({
    workspace,
    stateDir: join(root, 'state'),
    timeouts: { acceptanceMs: 50, turnMs: 100 },
    clock: {
      wallNow: () => Date.parse('2026-09-20T00:00:00Z') + mono,
      monotonicNow: () => mono,
      setTimer: () => () => {},
    },
    adapters: [
      {
        ...fake,
        async *execute(input) {
          yield { type: 'accepted', providerSessionId: 'offline' };
          // Delayed timer delivery: the monotonic deadline elapsed before the next observation.
          mono = 200;
          yield { ...usage, usageId: 'before-check' };
          statusAfterUsage = (
            (await engine.call('tasks.get', { taskId: input.taskId })) as TaskSnapshot
          ).status;
          yield { ...usage, usageId: 'late-after-check' };
        },
      },
    ],
  });
  t.after(async () => {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  });
  const task = (await engine.call('tasks.create', {
    spec: {
      goal: 'Deadline remains authoritative',
      runtime: { provider: 'fake', model: 'offline' },
      acceptance: { mode: 'human', criteria: ['Review'] },
    },
    idempotencyKey: 'budget',
  })) as TaskSnapshot;
  for (let index = 0; index < 5; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    statusAfterUsage,
    'blocked',
    'persist the deadline while still retaining late observations',
  );
  assert.equal(
    ((await engine.call('tasks.get', { taskId: task.id })) as TaskSnapshot).status,
    'blocked',
  );
  assert.equal(
    ((await engine.call('usage.get', { taskId: task.id })) as { records: UsageRecord[] }).records
      .length,
    2,
  );
});
