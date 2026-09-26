import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import { Store } from '../../packages/engine/src/store.ts';
import { createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import type { EventPage } from '../../packages/engine/src/types.ts';

// SPEC-0027 C: events.read tells a caller's mistake from a cursor after which the reader must
// resynchronize.

/** Temporary directories, removed after everything registered with `defer` closed. */
function directories(t: { after: (fn: () => Promise<void>) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-cursor-errors-')));
  const closers: (() => unknown)[] = [];
  t.after(async () => {
    for (const close of closers.reverse()) await Promise.resolve(close()).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'work'));
  return {
    workspace: join(root, 'work'),
    stateDir: join(root, 'state'),
    defer: (close: () => unknown) => closers.push(close),
  };
}
const expired = (details: Record<string, unknown>) => (error: unknown) => {
  const failure = error as { code?: string; details?: Record<string, unknown> };
  assert.equal(failure.code, 'CURSOR_EXPIRED');
  assert.deepEqual(failure.details, details);
  return true;
};

test('0027-C01 a malformed cursor and a non-zero cursor without its storeId are validation errors', async (t) => {
  const { defer, ...paths } = directories(t);
  const engine = await createEngine({ ...paths, adapters: [createFakeAdapter()] });
  defer(() => engine.close({ mode: 'interrupt', timeoutMs: 1000 }));
  await engine.call('tasks.create', {
    spec: {
      goal: 'Write events',
      runtime: { provider: 'fake', model: 'fixture' },
      acceptance: { mode: 'human', criteria: ['Review'] },
    },
    idempotencyKey: 'events',
  });
  const first = (await engine.call('events.read', {})) as EventPage;
  assert.ok(first.events.length > 0);
  for (const afterCursor of ['x1', '-1', '1.5', ' 1'])
    await assert.rejects(engine.call('events.read', { afterCursor, storeId: first.storeId }), {
      code: 'VALIDATION_ERROR',
    });
  // The mistake that looked like collected history: a saved cursor without its storeId.
  await assert.rejects(engine.call('events.read', { afterCursor: first.cursor }), {
    code: 'VALIDATION_ERROR',
  });
  // Reading from the start needs no storeId.
  const again = (await engine.call('events.read', { afterCursor: '0' })) as EventPage;
  assert.equal(again.events[0].eventId, first.events[0].eventId);
});

test('0027-C02 CURSOR_EXPIRED says why the reader must resynchronize', async (t) => {
  const { workspace, stateDir, defer } = directories(t);
  const store = new Store(workspace, stateDir);
  defer(() => store.close());
  for (const type of ['one', 'two', 'three']) store.event(type, {});
  const base = { retentionFloorCursor: '0', lastCursor: '3', currentStoreId: store.storeId };
  // Another store's cursor, as after a rollover or an import.
  assert.throws(
    () => store.events('1', 'another-store', undefined, 10),
    expired({ reason: 'store_changed', ...base }),
  );
  assert.throws(
    () => store.events('0', 'another-store', undefined, 10),
    expired({ reason: 'store_changed', ...base }),
  );
  // A store with fewer events than the cursor, as after restoring an older copy.
  assert.throws(
    () => store.events('9', store.storeId, undefined, 10),
    expired({ reason: 'ahead_of_store', ...base }),
  );
  // Events after the cursor were collected.
  store.setMetadata('retentionFloorCursor', '2');
  assert.throws(
    () => store.events('1', store.storeId, undefined, 10),
    expired({ reason: 'below_retention_floor', ...base, retentionFloorCursor: '2' }),
  );
  assert.deepEqual(
    store.events('2', store.storeId, undefined, 10).events.map((event) => event.type),
    ['three'],
  );
});

test('0027-C02 the embedded SDK passes the reason and cursors in the error data', async (t) => {
  const { defer, ...paths } = directories(t);
  const orch = await createOrchestrator({
    ...paths,
    adapters: [createFakeAdapter()],
    storage: { emergencyBytes: 4096 },
  });
  defer(() => orch.close({ mode: 'interrupt', timeoutMs: 1000 }));
  await orch.tasks.create({
    goal: 'Write events',
    runtime: { provider: 'fake', model: 'fixture' },
    acceptance: { mode: 'human', criteria: ['Review'] },
  });
  const page = await orch.events.read();
  assert.notEqual(page.cursor, '0');
  await assert.rejects(
    orch.events.read({ afterCursor: page.cursor, storeId: 'another-store' }),
    (error: { code?: string; data?: Record<string, unknown> }) => {
      assert.equal(error.code, 'CURSOR_EXPIRED');
      assert.equal(error.data?.reason, 'store_changed');
      assert.equal(error.data?.currentStoreId, orch.info.storeId);
      assert.equal(error.data?.retentionFloorCursor, '0');
      assert.equal(error.data?.lastCursor, page.cursor);
      return true;
    },
  );
  await assert.rejects(orch.events.read({ afterCursor: page.cursor }), {
    code: 'VALIDATION_ERROR',
  });
});
