import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../packages/engine/src/store.ts';
import { StorageGovernance } from '../../packages/engine/src/storage.ts';
const child = new URL('../fixtures/storage-crash.ts', import.meta.url);
for (const point of ['artifact.prepared', 'artifact.renamed', 'artifact.registered'])
  test(`B04 actual artifact writer crash at ${point}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-artifact-crash-')),
      work = join(root, 'work'),
      state = join(root, 'state');
    mkdirSync(work);
    let store: Store | undefined;
    try {
      const result = spawnSync(process.execPath, [child.pathname, work, state, 'artifact', point], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 77, result.stderr);
      store = new Store(work, state);
      const refs = store.all<any>('artifacts');
      assert.equal(refs.length, point === 'artifact.prepared' ? 0 : 1);
      for (const ref of refs) assert.equal(store.artifactText(ref.id), 'durable crash evidence');
    } finally {
      store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
for (const point of [
  'gc.marked',
  'gc.references_checked',
  'gc.quarantined',
  'gc.deleted',
  'gc.registered',
])
  test(`B04 actual artifact collector crash at ${point}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-gc-crash-')),
      work = join(root, 'work'),
      state = join(root, 'state');
    mkdirSync(work);
    let store: Store | undefined;
    try {
      store = new Store(work, state, { now: () => Date.parse('2026-01-01T00:00:00Z') });
      const ref = store.artifact('durable crash evidence');
      store.close();
      store = undefined;
      const result = spawnSync(process.execPath, [child.pathname, work, state, 'gc', point], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 77, result.stderr);
      store = new Store(work, state);
      new StorageGovernance(store, { emergencyBytes: 4096, minFreeBytes: 0 });
      assert.throws(() => store!.artifactText(ref), { code: 'ARTIFACT_HISTORY_EXPIRED' });
      assert.equal(store.all<any>('gc_jobs').filter((job) => job.status === 'pending').length, 0);
    } finally {
      store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
test('B06 actual SQLITE_FULL rolls back operation and latches dispatch fencing', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-full-')),
    work = join(root, 'work');
  mkdirSync(work);
  const store = new Store(work, join(root, 'state'));
  new StorageGovernance(store, { emergencyBytes: 4096, minFreeBytes: 0 });
  try {
    const pages = (store.db.prepare('PRAGMA page_count').get() as { page_count: number })
      .page_count;
    store.db.exec(`PRAGMA max_page_count=${pages + 1}`);
    assert.throws(
      () =>
        store.transaction(() => {
          store.saveOperation(
            {
              id: 'should-rollback',
              method: 'tasks.create',
              scope: 'local',
              idempotencyKey: 'K',
              status: 'completed',
              targetId: 't',
              result: null,
              error: null,
            },
            'digest',
          );
          store.put('tasks', 't', { id: 't', status: 'queued', payload: 'x'.repeat(1024 * 1024) });
        }),
      (error: any) => error.errcode === 13,
    );
    assert.equal(store.findOperation('tasks.create', 'local', 'K'), undefined);
    assert.equal(store.degraded, true);
    assert.equal(existsSync(join(store.stateDir, 'emergency.reserve')), false);
    assert.throws(() => store.put('tasks', 'later', {}), { code: 'STORAGE_DEGRADED' });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('B07 migration verifies complete artifacts and managed history before committing schema', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const { verifyArchive } = await import('../../packages/engine/src/archive.ts');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-migration-'))),
    work = join(root, 'work'),
    state = join(root, 'state');
  mkdirSync(work);
  let store: Store | undefined;
  try {
    store = new Store(work, state);
    const ref = store.artifact('must survive migration');
    const storeId = store.storeId;
    mkdirSync(join(state, 'runtime'), { mode: 0o700 });
    writeFileSync(join(state, 'runtime', 'history.jsonl'), '{"native":"retained"}\n');
    store.close();
    store = undefined;
    const old = new DatabaseSync(join(state, 'store.sqlite'));
    old.prepare("UPDATE metadata SET value='2' WHERE key='schemaVersion'").run();
    old.close();
    assert.throws(
      () =>
        new Store(work, state, {
          fault: (point) => {
            if (point === 'migration.before_commit') throw new Error('owned migration fault');
          },
        }),
      /owned migration fault/,
    );
    const intact = new DatabaseSync(join(state, 'store.sqlite'), { readOnly: true });
    assert.equal(
      (intact.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get() as any).value,
      '2',
    );
    intact.close();
    const bundle = readdirSync(state).find(
      (file) => file.startsWith('store-schema2-') && file.endsWith('.bundle'),
    )!;
    const manifest = verifyArchive(join(state, bundle), { storeId }, true);
    assert.ok(manifest.files.some((file) => file.path === 'runtime/history.jsonl'));
    store = new Store(work, state);
    assert.equal(store.storeId, storeId);
    assert.equal(store.artifactText(ref), 'must survive migration');
    assert.equal(
      readFileSync(join(state, 'runtime', 'history.jsonl'), 'utf8'),
      '{"native":"retained"}\n',
    );
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const stage of ['after_send', 'terminal'])
  test(`B06 real SQLITE_FULL ${stage} prevents admission and restarts without replay`, async () => {
    const { createEngine, createFakeAdapter } = await import('../../packages/engine/src/index.ts');
    const root = mkdtempSync(join(tmpdir(), 'orch-full-engine-')),
      work = join(root, 'work'),
      state = join(root, 'state');
    mkdirSync(work);
    let engine: Awaited<ReturnType<typeof createEngine>> | undefined;
    try {
      const child = spawnSync(
        process.execPath,
        [
          new URL('../fixtures/storage-full-owner.ts', import.meta.url).pathname,
          work,
          state,
          stage,
        ],
        { encoding: 'utf8', timeout: 8000 },
      );
      assert.equal(child.status, 0, child.stderr + child.stdout);
      const result = JSON.parse(child.stdout.trim());
      assert.equal(result.injected, true);
      assert.equal(result.invocations, 1);
      assert.equal(result.degraded, true);
      assert.equal(result.code, 'STORAGE_DEGRADED');
      assert.equal(result.closeCode, 'STORAGE_DEGRADED_CLOSED');
      assert.equal(result.closed, true);
      let replays = 0;
      const base = createFakeAdapter();
      engine = await createEngine({
        workspace: work,
        stateDir: state,
        adapters: [
          {
            ...base,
            async *execute(input) {
              replays++;
              yield* base.execute(input);
            },
          },
        ],
        storage: { emergencyBytes: 4096, minFreeBytes: 0 },
      });
      const recovered = (await engine.call('tasks.get', { taskId: result.taskId })) as any;
      assert.equal(recovered.status, 'blocked');
      assert.match(recovered.reason, /outcome_unknown/);
      assert.equal(replays, 0);
      await assert.rejects(
        engine.call('tasks.resume', {
          expectedStoreId: engine.storeId,
          taskId: result.taskId,
          idempotencyKey: 'no-blind-retry',
        }),
        { code: 'OUTCOME_UNKNOWN' },
      );
    } finally {
      await engine?.close({ mode: 'interrupt', timeoutMs: 1000 });
      rmSync(root, { recursive: true, force: true });
    }
  });
