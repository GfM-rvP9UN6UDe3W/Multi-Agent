import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type { Engine, SchedulerSnapshot } from '../../packages/engine/src/types.ts';

// SPEC-0025 F: a host that stopped after an internal failure says so.

const spec = (goal: string) => ({
  goal,
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['Review'] },
});
const reasons = async (engine: Engine) =>
  ((await engine.call('scheduler.get', {})) as SchedulerSnapshot).reasons;
const refusal = (engine: Engine, key: string) =>
  engine.call('tasks.create', { spec: spec(key), idempotencyKey: key }).then(
    () => assert.fail('tasks.create succeeded'),
    (error: unknown) =>
      error as { code: string; message: string; details: Record<string, unknown> },
  );

test('0025-F01 0025-F02 0025-F03 an artifact the engine cannot write stops it, and clients see why', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-host-failure-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'work'));
  let failWrites = false;
  const warnings: string[] = [];
  const onWarning = (warning: Error) => warnings.push(warning.message);
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));
  const engine = await createEngine({
    workspace: join(root, 'work'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
    storageFault: (point) => {
      if (failWrites && point === 'artifact.prepared') throw new Error('simulated disk failure');
    },
  });
  t.after(() => engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {}));
  assert.deepEqual(await reasons(engine), []);

  failWrites = true;
  await engine.call('tasks.create', {
    spec: spec('A result that cannot be written'),
    idempotencyKey: 'x',
  });
  const deadline = performance.now() + 5000;
  while (!(await reasons(engine)).includes('SCHEDULER_FAILED')) {
    assert.ok(performance.now() < deadline, `No SCHEDULER_FAILED: ${await reasons(engine)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(await reasons(engine), ['HOST_STOPPING', 'SCHEDULER_FAILED']);

  const error = await refusal(engine, 'after the failure');
  assert.equal(error.code, 'HOST_STOPPING');
  // The fake runtime reports execution evidence, which is stored as an artifact, before its result;
  // the engine keeps that first failure.
  assert.match(error.message, /execution evidence persistence/);
  assert.match(error.message, /INTERNAL_ERROR/);
  const failure = error.details.failure as { step: string; code: string; at: string };
  assert.deepEqual(
    { step: failure.step, code: failure.code },
    { step: 'execution evidence persistence', code: 'INTERNAL_ERROR' },
  );
  assert.ok(!Number.isNaN(Date.parse(failure.at)), 'the failure has a time');
  assert.ok(
    warnings.some((warning) => warning.includes('simulated disk failure')),
    'the host still prints the full error',
  );
});

test('0025-F03 a stop on request keeps its message and reports no failure', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-host-stop-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'work'));
  const engine = await createEngine({
    workspace: join(root, 'work'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
  });
  const closed = engine.close({ mode: 'drain', timeoutMs: 2000 });
  try {
    const error = await refusal(engine, 'while closing');
    assert.equal(error.code, 'HOST_STOPPING');
    assert.equal(error.message, 'Engine is stopping');
    assert.equal(error.details.failure, undefined);
  } finally {
    await closed;
  }
});
