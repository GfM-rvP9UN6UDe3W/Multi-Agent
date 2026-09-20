import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  Engine,
  EngineConfig,
  TaskSnapshot,
  TaskSpec,
} from '../../packages/engine/src/types.ts';

const human: TaskSpec = {
  goal: 'Produce a fixture result',
  runtime: { provider: 'fake', model: 'test' },
  acceptance: { mode: 'human', criteria: ['Inspect evidence'] },
};
async function fixture(options: Partial<EngineConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orch-completion-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const config = {
    workspace,
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
    ...options,
  };
  const engine = await createEngine(config);
  return {
    root,
    workspace,
    engine,
    config,
    async close() {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function create(engine: Engine, spec: unknown = human, key: string = crypto.randomUUID()) {
  return (await engine.call('tasks.create', { spec, idempotencyKey: key })) as TaskSnapshot;
}
async function wait(engine: Engine, id: string, status: string) {
  for (let i = 0; i < 500; i++) {
    const task = (await engine.call('tasks.get', { taskId: id })) as TaskSnapshot;
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(
    `Task did not reach ${status}: ${JSON.stringify(await engine.call('tasks.get', { taskId: id }))}`,
  );
}
async function approve(engine: Engine, id: string, choice = 'approve') {
  const task = await wait(engine, id, 'waiting_approval');
  return engine.call('approvals.decide', {
    approvalId: task.approvalId,
    decision: { choice, expectedRevision: 1 },
    idempotencyKey: crypto.randomUUID(),
  });
}

test('AC-F01 dependencies wait without a slot and wake only after acceptance', async () => {
  const f = await fixture();
  try {
    const parent = await create(f.engine);
    await wait(f.engine, parent.id, 'waiting_approval');
    const dependent = await create(f.engine, { ...human, dependencyTaskIds: [parent.id] });
    assert.equal(dependent.status, 'waiting_dependency');
    assert.equal(
      ((await f.engine.call('scheduler.get')) as { executionOccupied: number }).executionOccupied,
      0,
    );
    await approve(f.engine, parent.id);
    await wait(f.engine, dependent.id, 'waiting_approval');
  } finally {
    await f.close();
  }
});

test('AC-F01 failed dependencies block and invalid dependencies never create tasks', async () => {
  const f = await fixture();
  try {
    await assert.rejects(create(f.engine, { ...human, dependencyTaskIds: ['missing'] }), {
      code: 'NOT_FOUND',
    });
    const parent = await create(f.engine);
    const child = await create(f.engine, { ...human, dependencyTaskIds: [parent.id] });
    await approve(f.engine, parent.id, 'deny');
    assert.equal((await wait(f.engine, child.id, 'blocked')).reason, 'dependency_failed');
    await assert.rejects(
      create(f.engine, { ...human, dependencyTaskIds: [parent.id, parent.id] }),
      { code: 'VALIDATION_ERROR' },
    );
  } finally {
    await f.close();
  }
});

test('AC-F04 workspace writers serialize despite spare execution capacity', async () => {
  const f = await fixture({
    adapters: [createFakeAdapter({ delayMs: 100 })],
    providers: { fake: { permissionProfile: 'workspace-write' } },
  });
  try {
    const a = await create(f.engine);
    const b = await create(f.engine);
    await wait(f.engine, a.id, 'running');
    assert.equal(
      ((await f.engine.call('tasks.get', { taskId: b.id })) as TaskSnapshot).status,
      'queued',
    );
    await wait(f.engine, a.id, 'waiting_approval');
    await wait(f.engine, b.id, 'waiting_approval');
  } finally {
    await f.close();
  }
});

test('AC-F08 registered commands run as real subprocesses and acceptance retains evidence', async () => {
  const f = await fixture({
    verificationRules: [
      {
        id: 'node-ok',
        version: '1',
        argv: [process.execPath, '-e', 'console.log("verified")'],
        cwdRelative: '.',
        timeoutMs: 1000,
        permissionProfile: 'read-only',
        success: { exitCode: 0 },
      },
    ],
  } as Partial<EngineConfig>);
  try {
    const task = await create(f.engine, {
      ...human,
      acceptance: { mode: 'checks', ruleRefs: [{ id: 'node-ok', version: '1' }] },
    });
    const done = await wait(f.engine, task.id, 'completed');
    assert.equal(done.approvalId, null);
    assert.equal(done.artifactRefs.length, 2);
    const events = (await f.engine.call('events.read', { taskId: task.id })) as {
      events: { type: string }[];
    };
    assert.ok(events.events.some((e) => e.type === 'verification.completed'));
  } finally {
    await f.close();
  }
});

test('AC-F08 unknown rules, failed checks and timed-out subprocesses never complete', async () => {
  const f = await fixture({
    verificationRules: [
      {
        id: 'bad',
        version: '1',
        argv: [process.execPath, '-e', 'process.exit(7)'],
        cwdRelative: '.',
        timeoutMs: 1000,
        permissionProfile: 'read-only',
        success: { exitCode: 0 },
      },
      {
        id: 'hang',
        version: '1',
        argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
        cwdRelative: '.',
        timeoutMs: 50,
        permissionProfile: 'read-only',
        success: { exitCode: 0 },
      },
    ],
  } as Partial<EngineConfig>);
  try {
    const spec = (id: string) => ({
      ...human,
      acceptance: { mode: 'checks', ruleRefs: [{ id, version: '1' }] },
    });
    await assert.rejects(create(f.engine, spec('missing')), { code: 'UNKNOWN_VERIFICATION_RULE' });
    for (const id of ['bad', 'hang']) {
      const task = await create(f.engine, spec(id));
      assert.equal((await wait(f.engine, task.id, 'blocked')).reason, 'verification_failed');
    }
  } finally {
    await f.close();
  }
});

test('AC-F08 a check cannot accept a workspace it modified while inspecting', async () => {
  const f = await fixture({
    verificationRules: [
      {
        id: 'changes-code',
        version: '1',
        argv: [process.execPath, '-e', 'require("node:fs").writeFileSync("code.txt","changed")'],
        cwdRelative: '.',
        timeoutMs: 1000,
        permissionProfile: 'read-only',
        success: { exitCode: 0 },
      },
    ],
  } as Partial<EngineConfig>);
  try {
    await writeFile(join(f.workspace, 'code.txt'), 'before');
    const task = await create(f.engine, {
      ...human,
      acceptance: { mode: 'checks', ruleRefs: [{ id: 'changes-code', version: '1' }] },
    });
    assert.equal((await wait(f.engine, task.id, 'blocked')).reason, 'verification_failed');
  } finally {
    await f.close();
  }
});

test('AC-F08 inherited pipes cannot make verification cleanup unbounded', async () => {
  const { verifyRule, normalizeRules } = await import('../../packages/engine/src/verification.ts');
  const f = await fixture();
  const started = performance.now();
  try {
    const [rule] = normalizeRules(f.workspace, [
      {
        id: 'escaped-pipe',
        version: '1',
        cwdRelative: '.',
        timeoutMs: 150,
        permissionProfile: 'read-only',
        success: { exitCode: 0 },
        argv: [
          process.execPath,
          '-e',
          `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{detached:true,stdio:['ignore',1,2]}).unref()`,
        ],
      },
    ]);
    const evidence = await verifyRule(f.workspace, rule!, new AbortController().signal);
    assert.ok(performance.now() - started < 1500, 'cleanup must have its own finite deadline');
    assert.equal(evidence.passed, false);
    assert.equal((evidence as any).resourcesStopped, false);
  } finally {
    await f.close();
  }
});

test('AC-F16 logical session admission is bounded without blocking existing receipts', async () => {
  const f = await fixture({ limits: { maxLogicalSessions: 1 } } as Partial<EngineConfig>);
  try {
    const task = await create(f.engine, human, 'one');
    await wait(f.engine, task.id, 'waiting_approval');
    await assert.rejects(create(f.engine, human, 'two'), { code: 'SESSION_CAPACITY_EXHAUSTED' });
    assert.equal((await create(f.engine, human, 'one')).id, task.id);
    await approve(f.engine, task.id);
    assert.equal((await wait(f.engine, task.id, 'completed')).status, 'completed');
  } finally {
    await f.close();
  }
});

test('AC-F04 a queued task cannot acquire a changed registered write scope', async () => {
  const paths = ['.'];
  const f = await fixture({
    writeScopes: { code: paths },
    providers: { fake: { permissionProfile: 'workspace-write' } },
  });
  try {
    const parent = await create(f.engine);
    await wait(f.engine, parent.id, 'waiting_approval');
    const dependent = await create(f.engine, {
      ...human,
      dependencyTaskIds: [parent.id],
      writeScope: 'code',
    });
    paths[0] = '..';
    await approve(f.engine, parent.id);
    assert.equal((await wait(f.engine, dependent.id, 'blocked')).reason, 'INVALID_WORKSPACE_SCOPE');
    assert.equal(((await f.engine.call('scheduler.get')) as any).executionOccupied, 0);
  } finally {
    await f.close();
  }
});
