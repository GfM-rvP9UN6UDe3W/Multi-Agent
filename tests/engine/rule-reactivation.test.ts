import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  Engine,
  EngineConfig,
  EventPage,
  OperationSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0029 C: registering a retired rule version again with the same content reactivates it.

const rule = (version: string, extra: Record<string, unknown> = {}) => ({
  id: 'lint',
  version,
  argv: ['/usr/bin/true'],
  cwdRelative: '.',
  timeoutMs: 1000,
  permissionProfile: 'read-only',
  success: { exitCode: 0 },
  ...extra,
});
type Listed = { rules: { id: string; version: string; source: string; retiredAt?: string }[] };
const owner = { owner: true };
const register = (engine: Engine, value: unknown, key: string = crypto.randomUUID()) =>
  engine.call(
    'rules.register',
    { rule: value, idempotencyKey: key },
    owner,
  ) as Promise<OperationSnapshot>;
const retire = (engine: Engine, version: string) =>
  engine.call(
    'rules.retire',
    { id: 'lint', version, idempotencyKey: crypto.randomUUID() },
    owner,
  ) as Promise<OperationSnapshot>;
const listed = async (engine: Engine, includeRetired = false) =>
  ((await engine.call('rules.list', includeRetired ? { includeRetired } : {})) as Listed).rules.map(
    (item) => `${item.id}/${item.version}/${item.source}${item.retiredAt ? '/retired' : ''}`,
  );
const admit = (engine: Engine, version: string) =>
  engine.call('tasks.create', {
    spec: {
      goal: 'Run the checks',
      runtime: { provider: 'fake', model: 'fixture' },
      acceptance: { mode: 'checks', ruleRefs: [{ id: 'lint', version }] },
    },
    idempotencyKey: crypto.randomUUID(),
  }) as Promise<TaskSnapshot>;

async function setup(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  for (const name of ['work', 'state', 'control', 'stores', 'archives'])
    await mkdir(join(root, name), { mode: 0o700 });
  const config: EngineConfig = {
    workspace: join(root, 'work'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
    verificationRules: [rule('1')] as never,
    stores: {
      controlDir: join(root, 'control'),
      storesRoot: join(root, 'stores'),
      archiveRoot: join(root, 'archives'),
    },
  };
  return { root, config };
}
const stop = (engine: Engine) => engine.close({ mode: 'interrupt', timeoutMs: 1000 });

test('0029-C01 the same content reactivates a retired version, with an event and a result', async () => {
  const { root, config } = await setup('orch-rule-reactivate-');
  const engine = await createEngine(config);
  try {
    await register(engine, rule('2'));
    await retire(engine, '2');
    await assert.rejects(admit(engine, '2'), { code: 'RULE_RETIRED' });
    const op = await register(engine, rule('2'), 'reactivate');
    assert.equal(op.status, 'completed');
    assert.equal((op.result as { reactivated?: boolean }).reactivated, true);
    assert.equal((op.result as { version: string }).version, '2');
    const events = ((await engine.call('events.read', { limit: 1000 })) as EventPage).events;
    const event = events.find((item) => item.type === 'rule.reactivated');
    assert.deepEqual(event?.data, { id: 'lint', version: '2' });
    assert.equal(event?.operationId, op.id);
    assert.deepEqual(await listed(engine, true), ['lint/1/config', 'lint/2/runtime']);
    const task = await admit(engine, '2');
    assert.equal(task.verificationRules?.[0].version, '2');
    // Registering it again now is an ordinary no-op; other content is a conflict, as for any rule.
    assert.equal((await register(engine, rule('2'))).status, 'noop');
    await assert.rejects(register(engine, rule('2', { timeoutMs: 2000 })), { code: 'CONFLICT' });
    // The same key returns the same operation.
    assert.equal((await register(engine, rule('2'), 'reactivate')).id, op.id);
  } finally {
    await stop(engine).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('0029-C02 a reactivated rule stays effective after a restart, a rollover and an import, and retires again', async () => {
  const { root, config } = await setup('orch-rule-reactivate-switch-');
  let engine = await createEngine(config);
  const call = (method: string, params: Record<string, unknown>) =>
    engine.call(method, params, owner);
  try {
    await register(engine, rule('2'));
    await retire(engine, '2');
    await register(engine, rule('2'));
    await stop(engine);
    engine = await createEngine(config);
    assert.deepEqual(await listed(engine, true), ['lint/1/config', 'lint/2/runtime'], 'restart');
    const rollover = (await call('stores.rollover', { idempotencyKey: 'roll' })) as {
      status: string;
    };
    assert.equal(rollover.status, 'completed');
    assert.deepEqual(await listed(engine, true), ['lint/1/config', 'lint/2/runtime'], 'rollover');
    const backup = (await call('storage.backup', { idempotencyKey: 'backup' })) as {
      backupId: string;
    };
    await retire(engine, '2');
    await call('stores.import', { backupId: backup.backupId, idempotencyKey: 'import' });
    assert.deepEqual(await listed(engine, true), ['lint/1/config', 'lint/2/runtime'], 'import');
    await admit(engine, '2');
    await retire(engine, '2');
    assert.deepEqual(await listed(engine, true), ['lint/1/config', 'lint/2/runtime/retired']);
    await assert.rejects(admit(engine, '2'), { code: 'RULE_RETIRED' });
  } finally {
    await stop(engine).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('0029-C03 reactivation counts toward the 1000 effective rules', async () => {
  const { root, config } = await setup('orch-rule-reactivate-limit-');
  const engine = await createEngine(config);
  try {
    for (let i = 2; i <= 1000; i++) await register(engine, rule(String(i)));
    await retire(engine, '500');
    assert.equal((await register(engine, rule('1001'))).status, 'completed');
    await assert.rejects(register(engine, rule('500')), { code: 'VALIDATION_ERROR' });
    assert.ok((await listed(engine, true)).includes('lint/500/runtime/retired'));
    await assert.rejects(admit(engine, '500'), { code: 'RULE_RETIRED' });
  } finally {
    await stop(engine).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
