import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type { Engine, OperationSnapshot } from '../../packages/engine/src/types.ts';

// SPEC-0030 C: a key names one request. Replaying it after the rule changed returns the first
// operation and changes nothing (SPEC-0001 AC02); a change of a rule's state takes a new key.

const rule = {
  id: 'lint',
  version: 'sha-1',
  argv: ['/usr/bin/true'],
  cwdRelative: '.',
  timeoutMs: 1000,
  permissionProfile: 'read-only',
  success: { exitCode: 0 },
};
const owner = { owner: true };
const register = (engine: Engine, key: string) =>
  engine.call('rules.register', { rule, idempotencyKey: key }, owner) as Promise<OperationSnapshot>;
const retire = (engine: Engine, key: string) =>
  engine.call(
    'rules.retire',
    { id: rule.id, version: rule.version, idempotencyKey: key },
    owner,
  ) as Promise<OperationSnapshot>;
const effective = async (engine: Engine) =>
  ((await engine.call('rules.list', {})) as { rules: { id: string }[] }).rules.some(
    (item) => item.id === rule.id,
  );

test('0030-C01 a key replayed after its rule was retired or reactivated returns its first operation and changes nothing', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-rule-keys-')));
  await mkdir(join(root, 'work'));
  const engine = await createEngine({
    workspace: join(root, 'work'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
  });
  try {
    const registered = await register(engine, 'lint@sha-1');
    const retired = await retire(engine, 'retire lint@sha-1');
    const replayed = await register(engine, 'lint@sha-1');
    assert.equal(replayed.id, registered.id);
    assert.deepEqual(replayed.result, registered.result);
    assert.equal(await effective(engine), false, 'the replay does not reactivate the rule');

    // A new key reactivates it; the earlier retirement's key then retires nothing.
    const reactivated = await register(engine, `lint@sha-1 after ${retired.id}`);
    assert.equal((reactivated.result as { reactivated?: boolean }).reactivated, true);
    const again = await retire(engine, 'retire lint@sha-1');
    assert.equal(again.id, retired.id);
    assert.equal(await effective(engine), true, 'the replay does not retire the rule');
    await retire(engine, `retire lint@sha-1 after ${reactivated.id}`);
    assert.equal(await effective(engine), false);
  } finally {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
