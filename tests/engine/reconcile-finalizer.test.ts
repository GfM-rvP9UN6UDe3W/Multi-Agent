import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  Engine,
  EventPage,
  OperationSnapshot,
  RuntimeAdapter,
  SchedulerSnapshot,
  SessionSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

const spec = {
  goal: 'offline finalizer contract',
  runtime: { provider: 'claude', model: 'fixture' },
  acceptance: { mode: 'human', criteria: ['review'] },
};
const evidence = {
  source: 'owner_attestation',
  summary: 'Owner independently checked the fixture',
  localResources: 'stopped',
  remoteExecution: 'stopped',
  sideEffects: 'resolved',
  outcome: 'completed',
  result: 'done',
};
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const end = performance.now() + 3000;
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    assert.ok(performance.now() < end, 'fixture state did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function result(op: OperationSnapshot): Record<string, any> {
  assert.ok(op.result && typeof op.result === 'object' && !Array.isArray(op.result));
  return op.result;
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'finalizer-'));
  const workspace = join(root, 'workspace'),
    stateDir = join(root, 'state');
  await mkdir(workspace);
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 5,
    query: () => ({
      close() {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', session_id: 'native', result: 'done' };
      },
    }),
  });
  let engine = await createEngine({
    workspace,
    stateDir,
    adapters: [adapter, createFakeAdapter()],
    limits: { maxActiveSessions: 1 },
  });
  t.after(async () => {
    adapter.close = async () => {};
    await engine.close({ timeoutMs: 500 });
    await rm(root, { recursive: true, force: true });
  });
  const read = <T>(method: string, params = {}) => engine.call(method, params) as Promise<T>;
  const task = await read<TaskSnapshot>('tasks.create', { spec, idempotencyKey: 'unknown' });
  await until(
    () => read<TaskSnapshot>('tasks.get', { taskId: task.id }),
    (value) => value.status === 'blocked',
  );
  const session = await read<SessionSnapshot>('sessions.get', { sessionId: task.sessionId });
  const params = {
    target: {
      sessionId: session.id,
      expectedGeneration: session.generation,
      expectedRevision: session.revision,
      expectedDispatchId: session.activeDispatchId,
      expectedState: session.status,
    },
    evidence,
    idempotencyKey: 'owner-key',
  };
  return {
    adapter,
    task,
    session,
    params,
    stateDir,
    read,
    call: (owner = true, p = params) =>
      engine.call('sessions.reconcile', p, { owner }) as Promise<OperationSnapshot>,
    lookup: () =>
      read<OperationSnapshot>('operations.lookup', {
        method: 'sessions.reconcile',
        scope: session.id,
        idempotencyKey: 'owner-key',
      }),
    events: () => read<EventPage>('events.read', { limit: 256 }),
    scheduler: () => read<SchedulerSnapshot>('scheduler.get'),
    async restart() {
      // The fixture launched no processes; this drops only its old in-memory bookkeeping.
      adapter.close = async () => {};
      await engine.close({ timeoutMs: 500 });
      engine = await createEngine({ workspace, stateDir, adapters: [createFakeAdapter()] });
    },
  };
}

for (const invalid of [true, {}, 'not a finalizer']) {
  test(`AC-R04.6 non-function prepare result ${JSON.stringify(invalid)} is rejected before commit`, async (t) => {
    const f = await fixture(t);
    f.adapter.prepareUnobservedCleanup = (() =>
      invalid) as unknown as RuntimeAdapter['prepareUnobservedCleanup'];
    await assert.rejects(f.call(), { code: 'INVALID_RUNTIME_CONTRACT' });
    assert.equal(f.adapter.hasActiveResources(f.session.id), true);
    assert.equal((await f.scheduler()).executionOccupied, 1);
    await assert.rejects(f.lookup(), { code: 'NOT_FOUND' });
    assert.equal(
      (await f.events()).events.filter((event) => event.type.startsWith('session.resource')).length,
      0,
    );
  });
}

test('AC-R04.6 a throwing prepare rolls back and allows a corrected attempt with the same key', async (t) => {
  const f = await fixture(t);
  const original = f.adapter.prepareUnobservedCleanup!;
  f.adapter.prepareUnobservedCleanup = () => {
    throw new Error('fixture prepare failure');
  };
  await assert.rejects(f.call(), { code: 'INVALID_RUNTIME_CONTRACT' });
  await assert.rejects(f.lookup(), { code: 'NOT_FOUND' });
  assert.equal((await f.scheduler()).executionOccupied, 1);
  f.adapter.prepareUnobservedCleanup = original;
  assert.equal((await f.call()).status, 'completed');
});

test('AC-R04.6 a failed finalizer stays pending and same-key owner retry completes the original operation', async (t) => {
  const f = await fixture(t);
  const original = f.adapter.prepareUnobservedCleanup!;
  let prepares = 0,
    attempts = 0;
  f.adapter.prepareUnobservedCleanup = (target) => {
    prepares++;
    const finish = original(target)!;
    return () => {
      if (++attempts === 1) throw new Error('fixture finalizer failure');
      finish();
    };
  };
  await assert.rejects(
    f.call(),
    (error: any) =>
      error.code === 'RESOURCE_CLEANUP_INCOMPLETE' &&
      error.details.auditCommitted === true &&
      typeof error.details.operationId === 'string',
  );
  const pending = await f.lookup();
  assert.equal(pending.status, 'persisted');
  assert.equal(result(pending).resourceCleanup.status, 'pending');
  assert.equal(result(pending).unobservedResourcesReconciled, false);
  assert.equal((await f.read<TaskSnapshot>('tasks.get', { taskId: f.task.id })).status, 'paused');
  assert.equal(f.adapter.hasActiveResources(f.session.id), true);
  assert.ok((await f.scheduler()).reasons.includes('RESOURCE_CLEANUP_PENDING'));
  const queued = await f.read<TaskSnapshot>('tasks.create', {
    spec: { ...spec, runtime: { provider: 'fake', model: 'fixture' } },
    idempotencyKey: 'next-task',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.read<TaskSnapshot>('tasks.get', { taskId: queued.id })).status, 'queued');
  await assert.rejects(f.call(false), { code: 'UNAUTHORIZED' });
  await assert.rejects(
    f.call(true, { ...f.params, evidence: { ...evidence, summary: 'changed' } }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  assert.equal(attempts, 1);
  const completed = await f.call();
  assert.equal(completed.id, pending.id);
  assert.equal(completed.status, 'completed');
  assert.equal(result(completed).resourceCleanup.status, 'completed');
  assert.equal(result(completed).unobservedResourcesReconciled, true);
  assert.deepEqual(await f.call(), completed);
  assert.equal(prepares, 1);
  assert.equal(attempts, 2);
  assert.equal(f.adapter.hasActiveResources(f.session.id), false);
  await until(
    () => f.read<TaskSnapshot>('tasks.get', { taskId: queued.id }),
    (value) => value.status === 'waiting_approval',
  );
  const events = (await f.events()).events;
  assert.equal(events.filter((event) => event.type === 'session.reconciled').length, 1);
  assert.equal(events.filter((event) => event.type === 'session.resources_reconciled').length, 1);
});

test('AC-R04.6 persistence failure after finalization retries only the completion receipt', async (t) => {
  const f = await fixture(t);
  const db = new DatabaseSync(join(f.stateDir, 'store.sqlite'));
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER fail_cleanup_ack BEFORE UPDATE ON operations
    WHEN NEW.method = 'sessions.reconcile' AND json_extract(NEW.data, '$.status') = 'completed'
    BEGIN SELECT RAISE(ABORT, 'fixture acknowledgement failure'); END`);
  const original = f.adapter.prepareUnobservedCleanup!;
  let attempts = 0;
  f.adapter.prepareUnobservedCleanup = (target) => {
    const finish = original(target)!;
    return () => {
      attempts++;
      finish();
    };
  };
  await assert.rejects(f.call(), { code: 'RESOURCE_CLEANUP_INCOMPLETE' });
  assert.equal(attempts, 1);
  assert.equal(f.adapter.hasActiveResources(f.session.id), false);
  const pending = await f.lookup();
  assert.equal(pending.status, 'persisted');
  assert.equal(
    (await f.events()).events.filter((event) => event.type === 'session.resources_reconciled')
      .length,
    0,
  );
  db.exec('DROP TRIGGER fail_cleanup_ack');
  const completed = await f.call();
  assert.equal(completed.id, pending.id);
  assert.equal(completed.status, 'completed');
  assert.equal(
    attempts,
    1,
    'a completed memory disposition must not run again after an acknowledgement failure',
  );
});

test('AC-R04.6 restart cannot silently turn an unavailable finalizer into a successful receipt', async (t) => {
  const f = await fixture(t);
  f.adapter.prepareUnobservedCleanup = () => () => {
    throw new Error('retained fixture');
  };
  await assert.rejects(f.call(), { code: 'RESOURCE_CLEANUP_INCOMPLETE' });
  const pending = await f.lookup();
  await f.restart();
  const recovered = await f.lookup();
  assert.equal(recovered.id, pending.id);
  assert.equal(recovered.status, 'outcome_unknown');
  assert.equal(result(recovered).unobservedResourcesReconciled, false);
  await assert.rejects(
    f.call(),
    (error: any) =>
      error.code === 'RESOURCE_CLEANUP_INCOMPLETE' && error.details.operationId === pending.id,
  );
});

test('AC-R04.6 a rejected async finalizer is observed and can be explicitly retried', async (t) => {
  const f = await fixture(t);
  const original = f.adapter.prepareUnobservedCleanup!;
  let attempts = 0;
  f.adapter.prepareUnobservedCleanup = (target) => {
    const finish = original(target)!;
    return () => {
      if (++attempts === 1) return Promise.reject(new Error('async fixture failure'));
      finish();
    };
  };
  await assert.rejects(f.call(), { code: 'RESOURCE_CLEANUP_INCOMPLETE' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result(await f.lookup()).unobservedResourcesReconciled, false);
  assert.equal((await f.call()).status, 'completed');
  assert.equal(attempts, 2);
});

test(
  'AC-R04.6 a pending async finalizer is not awaited indefinitely or invoked twice',
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t);
    const original = f.adapter.prepareUnobservedCleanup!;
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    t.after(() => resolve());
    let attempts = 0;
    f.adapter.prepareUnobservedCleanup = (target) => {
      const finish = original(target)!;
      return () => {
        attempts++;
        return gate.then(finish);
      };
    };
    await assert.rejects(f.call(), { code: 'RESOURCE_CLEANUP_INCOMPLETE' });
    await assert.rejects(f.call(), { code: 'RESOURCE_CLEANUP_INCOMPLETE' });
    assert.equal(attempts, 1);
    resolve();
    await new Promise((done) => setImmediate(done));
    assert.equal(
      (await f.lookup()).status,
      'persisted',
      'settlement alone does not complete the receipt',
    );
    assert.equal((await f.call()).status, 'completed');
    assert.equal(attempts, 1);
  },
);

test('AC-R04.6 a returning finalizer cannot hide still-retained adapter resources', async (t) => {
  const f = await fixture(t);
  const original = f.adapter.prepareUnobservedCleanup!;
  let attempts = 0;
  f.adapter.prepareUnobservedCleanup = (target) => {
    const finish = original(target)!;
    return () => {
      if (++attempts > 1) finish();
    };
  };
  await assert.rejects(f.call(), { code: 'RESOURCE_CLEANUP_INCOMPLETE' });
  assert.equal((await f.lookup()).status, 'persisted');
  assert.equal(f.adapter.hasActiveResources(f.session.id), true);
  assert.equal((await f.call()).status, 'completed');
});
