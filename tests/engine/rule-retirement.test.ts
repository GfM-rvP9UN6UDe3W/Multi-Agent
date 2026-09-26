import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter, openReadOnlyEngine } from '../fixtures/engine.ts';
import type {
  Engine,
  EngineConfig,
  EventPage,
  OperationSnapshot,
  RuntimeAdapter,
  RuntimeInput,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0028 U: retiring verification rules registered at runtime.

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
const retire = (engine: Engine, version: string, key: string = crypto.randomUUID(), id = 'lint') =>
  engine.call(
    'rules.retire',
    { id, version, idempotencyKey: key },
    owner,
  ) as Promise<OperationSnapshot>;
const listed = async (engine: Engine | { call: Engine['call'] }, includeRetired?: boolean) =>
  (
    (await engine.call(
      'rules.list',
      includeRetired === undefined ? {} : { includeRetired },
    )) as Listed
  ).rules.map(
    (item) => `${item.id}/${item.version}/${item.source}${item.retiredAt ? '/retired' : ''}`,
  );
const checks = (version: string, extra: Record<string, unknown> = {}) => ({
  goal: 'Run the checks',
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'checks', ruleRefs: [{ id: 'lint', version }], ...extra },
});
const admit = (engine: Engine, version: string) =>
  engine.call('tasks.create', { spec: checks(version), idempotencyKey: crypto.randomUUID() });

async function setup(prefix: string, overrides: Partial<EngineConfig> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  for (const name of ['work', 'state', 'control', 'stores', 'archives'])
    await mkdir(join(root, name), { mode: 0o700 });
  const config: EngineConfig = {
    workspace: join(root, 'work'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
    verificationRules: [rule('1')] as never,
    ...overrides,
  };
  return { root, config };
}
const stop = (engine: Engine) => engine.close({ mode: 'interrupt', timeoutMs: 1000 });

test('0028-U01 a retired rule leaves the effective rules and refuses new tasks', async () => {
  const { root, config } = await setup('orch-rule-retire-');
  const engine = await createEngine(config);
  try {
    await register(engine, rule('2'));
    await register(engine, rule('3'));
    await assert.rejects(
      engine.call('rules.retire', { id: 'lint', version: '2', idempotencyKey: 'plain' }),
      { code: 'UNAUTHORIZED' },
    );
    const retired = await retire(engine, '2', 'retire-2');
    assert.equal(retired.status, 'completed');
    const result = retired.result as { id: string; version: string; retiredAt: string };
    assert.deepEqual([result.id, result.version], ['lint', '2']);
    assert.equal(new Date(result.retiredAt).toISOString(), result.retiredAt);
    const events = ((await engine.call('events.read', { limit: 1000 })) as EventPage).events;
    const event = events.find((item) => item.type === 'rule.retired');
    assert.deepEqual(event?.data, { id: 'lint', version: '2', retiredAt: result.retiredAt });
    assert.equal(event?.operationId, retired.id);

    assert.deepEqual(await listed(engine), ['lint/1/config', 'lint/3/runtime']);
    assert.deepEqual(await listed(engine, true), [
      'lint/1/config',
      'lint/3/runtime',
      'lint/2/runtime/retired',
    ]);
    await assert.rejects(admit(engine, '2'), { code: 'RULE_RETIRED' });
    await admit(engine, '3');
    // Retiring again changes nothing; the original time stays.
    const again = await retire(engine, '2');
    assert.equal(again.status, 'noop');
    assert.equal((again.result as { retiredAt: string }).retiredAt, result.retiredAt);
    assert.equal(
      (await retire(engine, '2', 'retire-2')).id,
      retired.id,
      'the same key returns the same operation',
    );
    await assert.rejects(retire(engine, '9'), { code: 'UNKNOWN_VERIFICATION_RULE' });
    await assert.rejects(retire(engine, '1', undefined, 'other'), {
      code: 'UNKNOWN_VERIFICATION_RULE',
    });
    await assert.rejects(
      engine.call('rules.retire', { id: 'lint', idempotencyKey: 'no-version' }, owner),
      { code: 'VALIDATION_ERROR' },
    );
  } finally {
    await stop(engine).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('0028-U01 a retired rule no longer counts toward the 1000 effective rules', async () => {
  const { root, config } = await setup('orch-rule-limit-');
  const engine = await createEngine(config);
  try {
    for (let i = 2; i <= 1000; i++) await register(engine, rule(String(i)));
    await assert.rejects(register(engine, rule('1001')), { code: 'VALIDATION_ERROR' });
    await retire(engine, '500');
    assert.equal((await register(engine, rule('1001'))).status, 'completed');
    await assert.rejects(register(engine, rule('1002')), { code: 'VALIDATION_ERROR' });
  } finally {
    await stop(engine).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('0028-U02 a task admitted before its rule was retired verifies and retries with its copy', async () => {
  const { root, config } = await setup('orch-rule-frozen-');
  const marker = join(root, 'marker');
  const base = createFakeAdapter();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute(input: RuntimeInput) {
      for await (const event of base.execute(input)) {
        if (event.type !== 'accepted') await gate;
        yield event;
      }
    },
  };
  const engine = await createEngine({ ...config, adapters: [adapter] });
  try {
    // Fails on its first run and passes on the next one.
    const flaky = rule('2', {
      argv: [
        process.execPath,
        '-e',
        `const fs = require('node:fs'); if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0); fs.writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(1);`,
      ],
      timeoutMs: 10_000,
    });
    await register(engine, flaky);
    const task = (await engine.call('tasks.create', {
      spec: checks('2', { maxRepairs: 1 }),
      idempotencyKey: 'frozen',
    })) as TaskSnapshot;
    for (let i = 0; i < 400; i++) {
      if (
        ((await engine.call('tasks.get', { taskId: task.id })) as TaskSnapshot).status === 'running'
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await retire(engine, '2');
    release();
    let done: TaskSnapshot | undefined;
    for (let i = 0; i < 1000; i++) {
      done = (await engine.call('tasks.get', { taskId: task.id })) as TaskSnapshot;
      if (['completed', 'blocked', 'failed'].includes(done.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(done?.status, 'completed', `${done?.status}/${done?.reason}`);
    assert.equal(done?.verificationAttempts, 2, 'the repair retry ran the retired rule again');
  } finally {
    release();
    await stop(engine).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('0028-U03 configured rules cannot be retired, and a retired version cannot be registered again', async () => {
  const { root, config } = await setup('orch-rule-refuse-');
  const engine = await createEngine(config);
  try {
    await assert.rejects(retire(engine, '1'), { code: 'VALIDATION_ERROR' });
    await register(engine, rule('2'));
    await retire(engine, '2');
    await assert.rejects(register(engine, rule('2')), { code: 'RULE_RETIRED' });
    await assert.rejects(register(engine, rule('2', { timeoutMs: 2000 })), {
      code: 'RULE_RETIRED',
    });
    assert.equal((await register(engine, rule('2.1'))).status, 'completed');
  } finally {
    await stop(engine).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('0028-U04 retirement survives a restart, and a retired row never conflicts with the configuration', async () => {
  const { root, config } = await setup('orch-rule-restart-');
  let engine = await createEngine(config);
  try {
    await register(engine, rule('2'));
    await retire(engine, '2');
    await stop(engine);
    engine = await createEngine(config);
    assert.deepEqual(await listed(engine, true), ['lint/1/config', 'lint/2/runtime/retired']);
    await assert.rejects(admit(engine, '2'), { code: 'RULE_RETIRED' });
    await stop(engine);
    // The configuration now defines lint@2 differently; the retired row does not take part.
    engine = await createEngine({
      ...config,
      verificationRules: [rule('1'), rule('2', { timeoutMs: 5 })] as never,
    });
    assert.deepEqual(await listed(engine), ['lint/1/config', 'lint/2/config']);
    await admit(engine, '2');
    await stop(engine);
    const reader = await openReadOnlyEngine({ stateDir: config.stateDir });
    try {
      assert.deepEqual(await listed(reader), []);
      assert.deepEqual(await listed(reader, true), ['lint/2/runtime/retired']);
    } finally {
      await reader.close();
    }
  } finally {
    await stop(engine).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('0028-U04 a rollover and an import carry retired rules', async () => {
  const { root, config } = await setup('orch-rule-switch-', {});
  const managed: EngineConfig = {
    ...config,
    stores: {
      controlDir: join(root, 'control'),
      storesRoot: join(root, 'stores'),
      archiveRoot: join(root, 'archives'),
    },
  };
  let engine = await createEngine(managed);
  const call = (method: string, params: Record<string, unknown>) =>
    engine.call(method, params, owner);
  try {
    await register(engine, rule('2'));
    await register(engine, rule('3'));
    await retire(engine, '2');
    const rollover = (await call('stores.rollover', { idempotencyKey: 'roll' })) as {
      status: string;
    };
    assert.equal(rollover.status, 'completed');
    for (const phase of ['switched', 'restarted']) {
      assert.deepEqual(
        await listed(engine, true),
        ['lint/1/config', 'lint/3/runtime', 'lint/2/runtime/retired'],
        phase,
      );
      await assert.rejects(admit(engine, '2'), { code: 'RULE_RETIRED' });
      if (phase === 'switched') {
        await stop(engine);
        engine = await createEngine(managed);
      }
    }
    const backup = (await call('storage.backup', { idempotencyKey: 'backup' })) as {
      backupId: string;
    };
    await retire(engine, '3');
    assert.deepEqual(await listed(engine), ['lint/1/config']);
    await call('stores.import', { backupId: backup.backupId, idempotencyKey: 'import' });
    for (const phase of ['imported', 'restarted']) {
      assert.deepEqual(
        await listed(engine, true),
        ['lint/1/config', 'lint/3/runtime', 'lint/2/runtime/retired'],
        phase,
      );
      if (phase === 'imported') {
        await stop(engine);
        engine = await createEngine(managed);
      }
    }
  } finally {
    await stop(engine).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
