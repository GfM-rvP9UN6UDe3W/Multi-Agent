import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  Engine,
  EngineConfig,
  EventPage,
  RuntimeAdapter,
  SchedulerSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0027 F: an embedding host hears at once that the engine stopped after an internal failure.

type Failure = { step: string; code: string; at: string };
const spec = (goal: string) => ({
  goal,
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['Review'] },
});
/** Directories for one engine, removed after the engines passed to `defer` closed. */
function scope(t: TestContext) {
  const roots: string[] = [];
  const closers: (() => unknown)[] = [];
  t.after(async () => {
    for (const close of closers.reverse()) await Promise.resolve(close()).catch(() => {});
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  return {
    directories() {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-fatal-notice-')));
      roots.push(root);
      mkdirSync(join(root, 'work'));
      return { workspace: join(root, 'work'), stateDir: join(root, 'state') };
    },
    defer: (engine: Engine) =>
      closers.push(() => engine.close({ mode: 'interrupt', timeoutMs: 1000 })),
  };
}
function warnings(t: TestContext) {
  const seen: string[] = [];
  const listen = (warning: Error) => seen.push(warning.message);
  process.on('warning', listen);
  t.after(() => process.off('warning', listen));
  return seen;
}
/** Resolves with the first value, or fails after `ms` (a watchdog, not a timing assertion). */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms).unref(),
    ),
  ]);
}
const failedEvents = async (engine: Engine) =>
  ((await engine.call('events.read', { limit: 1000 })) as EventPage).events.filter(
    (event) => event.type === 'scheduler.failed',
  );

test('0027-F01 0027-F02 onFatal hears the first failure once, after scheduler.failed was committed', async (t) => {
  const cleanup = scope(t);
  let armed = false;
  let faultAt = 0;
  const calls: { failure: Failure; latencyMs: number; seen: Promise<unknown> }[] = [];
  let heard!: (value: Failure) => void;
  const fatal = new Promise<Failure>((resolve) => (heard = resolve));
  let engine!: Engine;
  engine = await createEngine({
    ...cleanup.directories(),
    adapters: [createFakeAdapter()],
    storageFault: (point) => {
      if (!armed || point !== 'artifact.prepared') return;
      faultAt ||= performance.now();
      throw new Error('simulated disk failure');
    },
    onFatal: (failure: Failure) => {
      // What a host sees from inside the callback: reads still work, writes are refused.
      const seen = Promise.all([
        engine.call('scheduler.get', {}),
        engine.call('events.read', { limit: 1000 }),
        engine.call('tasks.create', { spec: spec('after'), idempotencyKey: 'after' }).then(
          () => 'accepted',
          (error: { code?: string }) => error.code,
        ),
      ]);
      calls.push({ failure, latencyMs: performance.now() - faultAt, seen });
      heard(failure);
    },
  } as EngineConfig);
  cleanup.defer(engine);

  armed = true;
  await engine.call('tasks.create', {
    spec: spec('A result that cannot be written'),
    idempotencyKey: 'x',
  });
  const failure = await within(fatal, 10_000, 'onFatal');
  // The fake runtime stores its execution evidence first, so that write fails first (0025-F01).
  assert.deepEqual(
    { step: failure.step, code: failure.code },
    { step: 'execution evidence persistence', code: 'INTERNAL_ERROR' },
  );
  assert.ok(!Number.isNaN(Date.parse(failure.at)));
  assert.ok(calls[0].latencyMs < 1000, `notified ${calls[0].latencyMs} ms after the fault`);
  const [scheduler, page, refused] = (await calls[0].seen) as [
    SchedulerSnapshot,
    EventPage,
    string,
  ];
  assert.ok(scheduler.reasons.includes('SCHEDULER_FAILED'), JSON.stringify(scheduler.reasons));
  assert.equal(refused, 'HOST_STOPPING');
  const committed = page.events.filter((event) => event.type === 'scheduler.failed');
  assert.equal(committed.length, 1, 'the event was committed before the callback');
  assert.deepEqual(committed[0].data, failure);

  // A later failure of the same stop neither calls it again nor replaces the first failure. The
  // stopped engine starts nothing that could fail, so the second failure is reported directly.
  (engine as unknown as { stopAfterFailure(step: string, error: unknown): void }).stopAfterFailure(
    'a later step',
    new Error('failed again'),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 1);
  assert.equal((await failedEvents(engine)).length, 1);
  const again = await engine
    .call('tasks.create', { spec: spec('later'), idempotencyKey: 'later' })
    .then(
      () => assert.fail('tasks.create succeeded'),
      (error: { details?: { failure?: Failure } }) => error.details?.failure,
    );
  assert.deepEqual(again, failure);
});

test('0027-F02 a degraded store still calls onFatal and writes no event', async (t) => {
  const cleanup = scope(t);
  let armed = false;
  let heard!: (value: Failure) => void;
  const fatal = new Promise<Failure>((resolve) => (heard = resolve));
  const engine = await createEngine({
    ...cleanup.directories(),
    adapters: [createFakeAdapter()],
    storageFault: (point) => {
      if (armed && point === 'artifact.prepared')
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    },
    onFatal: (failure: Failure) => heard(failure),
  } as EngineConfig);
  cleanup.defer(engine);
  armed = true;
  await engine.call('tasks.create', { spec: spec('Disk full'), idempotencyKey: 'x' });
  const failure = await within(fatal, 10_000, 'onFatal');
  assert.equal(failure.step, 'execution evidence persistence');
  assert.deepEqual(await failedEvents(engine), []);
});

test('0027-F01 a requested close does not call onFatal, and a throwing callback only warns', async (t) => {
  const cleanup = scope(t);
  const seen = warnings(t);
  let called = 0;
  const quiet = await createEngine({
    ...cleanup.directories(),
    adapters: [createFakeAdapter()],
    onFatal: () => called++,
  } as EngineConfig);
  await quiet.call('tasks.create', { spec: spec('Normal work'), idempotencyKey: 'x' });
  await quiet.close({ mode: 'interrupt', timeoutMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(called, 0);

  let armed = false;
  let heard!: () => void;
  const fatal = new Promise<void>((resolve) => (heard = resolve));
  const engine = await createEngine({
    ...cleanup.directories(),
    adapters: [createFakeAdapter()],
    storageFault: (point) => {
      if (armed && point === 'artifact.prepared') throw new Error('simulated disk failure');
    },
    onFatal: () => {
      heard();
      throw new Error('host callback failed');
    },
  } as EngineConfig);
  cleanup.defer(engine);
  armed = true;
  await engine.call('tasks.create', { spec: spec('Fails'), idempotencyKey: 'y' });
  await within(fatal, 10_000, 'onFatal');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    seen.some((message) => message.includes('host callback failed')),
    JSON.stringify(seen),
  );
  const scheduler = (await engine.call('scheduler.get', {})) as SchedulerSnapshot;
  assert.ok(scheduler.reasons.includes('SCHEDULER_FAILED'));
});

test('0027-F03 a failed storage collection and a failed usage write warn', async (t) => {
  const cleanup = scope(t);
  const seen = warnings(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const collecting = await createEngine({
    ...cleanup.directories(),
    adapters: [createFakeAdapter()],
  });
  cleanup.defer(collecting);
  (collecting as unknown as { storage: { collect(): void } }).storage.collect = () => {
    throw new Error('collection failed');
  };
  t.mock.timers.tick(3_600_000);
  // Process warnings are delivered on a later tick.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    seen.some(
      (message) => /storage collection/i.test(message) && message.includes('collection failed'),
    ),
    JSON.stringify(seen),
  );
  t.mock.timers.reset();

  const base = createFakeAdapter();
  const reporting: RuntimeAdapter = {
    ...base,
    async *execute(input) {
      for await (const event of base.execute(input)) {
        yield event;
        if (event.type === 'accepted')
          yield {
            type: 'usage',
            usageId: 'u1',
            usage: {
              inputTokens: 1,
              cachedInputTokens: null,
              cacheWriteInputTokens: null,
              outputTokens: 1,
              raw: {},
            },
          };
      }
    },
  };
  const engine = await createEngine({ ...cleanup.directories(), adapters: [reporting] });
  cleanup.defer(engine);
  (engine as unknown as { accounting: { record(): void } }).accounting.record = () => {
    throw new Error('usage write failed');
  };
  await engine.call('tasks.create', { spec: spec('Reports usage'), idempotencyKey: 'x' });
  for (let i = 0; i < 400 && !seen.some((message) => /usage persistence/i.test(message)); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(
    seen.some(
      (message) => /usage persistence/i.test(message) && message.includes('usage write failed'),
    ),
    JSON.stringify(seen),
  );
});
