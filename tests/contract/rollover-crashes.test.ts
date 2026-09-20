import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngine } from '../../packages/engine/src/index.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import { Store } from '../../packages/engine/src/store.ts';
const points = [
  'preparing.before',
  'preparing.after',
  ...['archiving', 'archive_verified', 'new_prepared', 'old_retired', 'committed'].flatMap(
    (phase) => [`${phase}.before`, `${phase}.after_action`, `${phase}.after`],
  ),
  'committed.manifest_committed',
];
for (const point of points)
  test(`B15 actual owner crash at rollover.${point} recovers only the original switch`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-roll-crash-')));
    for (const name of ['work', 'state', 'control', 'stores', 'archives'])
      mkdirSync(join(root, name), { mode: 0o700 });
    const config = {
      workspace: join(root, 'work'),
      stateDir: join(root, 'state'),
      storage: { emergencyBytes: 4096, minFreeBytes: 0 },
      stores: {
        controlDir: join(root, 'control'),
        storesRoot: join(root, 'stores'),
        archiveRoot: join(root, 'archives'),
      },
    };
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));
    let engine: Awaited<ReturnType<typeof createEngine>> | undefined;
    try {
      const child = spawnSync(
        process.execPath,
        [
          new URL('../fixtures/rollover-crash.ts', import.meta.url).pathname,
          configPath,
          `rollover.${point}`,
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(child.status, 73, child.stderr);
      const interrupted = JSON.parse(
        readFileSync(join(config.stores.controlDir, 'manifest.json'), 'utf8'),
      );
      const record = Object.values(interrupted.rollovers)[0] as any;
      assert.ok(record.rolloverId);
      engine = await createEngine({ ...config, adapters: [createFakeAdapter()] });
      const result = (await engine.call(
        'stores.rollover',
        { expectedStoreId: record.oldStoreId, idempotencyKey: 'crash-rollover' },
        { owner: true },
      )) as any;
      assert.equal(result.rolloverId, record.rolloverId);
      assert.equal(result.status, 'completed');
      assert.notEqual(engine.storeId, record.oldStoreId);
      const snapshot = (await engine.call('state.snapshot')) as any;
      assert.deepEqual(snapshot.items, []);
      assert.throws(() => new Store(config.workspace, config.stateDir), { code: 'STORE_RETIRED' });
      await assert.rejects(
        engine.call('tasks.create', {
          expectedStoreId: record.oldStoreId,
          idempotencyKey: 'old',
          spec: {},
        }),
        { code: 'STORE_NAMESPACE_MISMATCH' },
      );
    } finally {
      await engine?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
