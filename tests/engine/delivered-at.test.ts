import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter, openReadOnlyEngine } from '../fixtures/engine.ts';
import type {
  ApprovalRequest,
  Engine,
  EngineConfig,
  RuntimeAdapter,
  RuntimeInput,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0029 B: the time a task last delivered a result, on the task itself.

type Delivered = TaskSnapshot & { deliveredAt?: string };

async function setup(adapter: RuntimeAdapter, overrides: Partial<EngineConfig> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-delivered-at-')));
  await mkdir(join(root, 'workspace'));
  const stateDir = join(root, 'state');
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir,
    adapters: [adapter],
    ...overrides,
  });
  return {
    root,
    engine,
    stateDir,
    async close() {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}
const get = async (engine: Engine, id: string) =>
  (await engine.call('tasks.get', { taskId: id })) as Delivered;
async function until(engine: Engine, id: string, check: (task: Delivered) => boolean) {
  let task: Delivered | undefined;
  for (let i = 0; i < 1000; i++) {
    task = await get(engine, id);
    if (check(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${id} never reached the state; last ${task?.status}/${task?.reason}`);
}
async function decide(engine: Engine, approvalId: string, choice: string, comment?: string) {
  const approval = (await engine.call('approvals.get', { approvalId })) as ApprovalRequest;
  await engine.call('approvals.decide', {
    approvalId,
    decision: {
      choice,
      expectedRevision: approval.revision,
      ...(comment ? { comment } : {}),
    },
    idempotencyKey: crypto.randomUUID(),
  });
}

test('0029-B01 a human task’s deliveredAt follows each review of its result, not a runtime permission', async () => {
  const base = createFakeAdapter();
  let dispatches = 0;
  // The second dispatch asks for a runtime permission before it delivers.
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute(input: RuntimeInput) {
      dispatches++;
      if (dispatches === 2) {
        // The resumed native session keeps its identity.
        const native = input.providerSessionId ?? `fake-${input.sessionId}`;
        yield { type: 'accepted', providerSessionId: native };
        await input.requestPermission!({
          requestId: 'tool-1',
          toolName: 'Read',
          permission: { path: 'notes.txt' },
          providerSessionId: native,
        });
        yield* base.execute(input);
        return;
      }
      yield* base.execute(input);
    },
  };
  const f = await setup(adapter, { runtimeApprovals: { enabled: true } });
  try {
    const created = (await f.engine.call('tasks.create', {
      spec: {
        goal: 'Deliver twice',
        runtime: { provider: 'fake', model: 'fixture' },
        acceptance: { mode: 'human', criteria: ['Review'] },
      },
      idempotencyKey: 'deliver',
    })) as Delivered;
    assert.equal(created.deliveredAt, undefined, 'a new task has delivered nothing');
    const first = await until(f.engine, created.id, (t) => t.status === 'waiting_approval');
    assert.equal(first.deliveredAt, first.updatedAt, 'the review of its result');
    await decide(f.engine, first.approvalId!, 'revise', 'Say it again');
    // The revised turn waits for a runtime permission: that review is not a delivery.
    const permission = await until(
      f.engine,
      created.id,
      (t) => t.status === 'waiting_approval' && t.reason === 'runtime_permission',
    );
    assert.equal(permission.deliveredAt, first.deliveredAt);
    await decide(f.engine, permission.approvalId!, 'approve');
    const second = await until(
      f.engine,
      created.id,
      (t) =>
        t.status === 'waiting_approval' && t.reason === null && t.approvalId !== first.approvalId,
    );
    assert.equal(second.deliveredAt, second.updatedAt);
    assert.ok(second.deliveredAt! > first.deliveredAt!, 'the later delivery');
    await decide(f.engine, second.approvalId!, 'approve');
    const done = await until(f.engine, created.id, (t) => t.status === 'completed');
    assert.equal(done.deliveredAt, second.deliveredAt, 'an approval is not a delivery');
  } finally {
    await f.close();
  }
});

test('0029-B01 a result offered again after its approval expired counts as a delivery', async () => {
  const f = await setup(createFakeAdapter(), { approvalTtlMs: 200 });
  try {
    const created = (await f.engine.call('tasks.create', {
      spec: {
        goal: 'Deliver, expire, offer again',
        runtime: { provider: 'fake', model: 'fixture' },
        acceptance: { mode: 'human', criteria: ['Review'] },
      },
      idempotencyKey: 'expire',
    })) as Delivered;
    const first = await until(f.engine, created.id, (t) => t.status === 'waiting_approval');
    const expired = await until(
      f.engine,
      created.id,
      (t) => t.status === 'paused' && t.reason === 'approval_expired',
    );
    assert.equal(expired.deliveredAt, first.deliveredAt);
    await f.engine.call('tasks.resume', { taskId: created.id, idempotencyKey: 'resume' });
    const offered = await until(f.engine, created.id, (t) => t.status === 'waiting_approval');
    assert.equal(offered.deliveredAt, offered.updatedAt);
    assert.ok(offered.deliveredAt! > first.deliveredAt!);
  } finally {
    await f.close();
  }
});

function rule(id: string, script: string) {
  return {
    id,
    version: '1',
    argv: [process.execPath, '-e', script],
    cwdRelative: '.',
    timeoutMs: 10_000,
    permissionProfile: 'read-only',
    success: { exitCode: 0 },
  };
}

test('0029-B01 0029-B02 a checks task delivers when its checks pass, not when they fail', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-delivered-checks-')));
  const marker = join(root, 'marker');
  const f = await setup(createFakeAdapter(), {
    verificationRules: [
      // Fails on its first run and passes on the next one.
      rule(
        'flaky',
        `const fs = require('node:fs'); if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0); fs.writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(1);`,
      ),
      rule('broken', 'process.exit(1)'),
    ],
  } as Partial<EngineConfig>);
  try {
    const checks = (id: string, maxRepairs: number) =>
      f.engine.call('tasks.create', {
        spec: {
          goal: `Pass ${id}`,
          runtime: { provider: 'fake', model: 'fixture' },
          acceptance: { mode: 'checks', ruleRefs: [{ id, version: '1' }], maxRepairs },
        },
        idempotencyKey: crypto.randomUUID(),
      }) as Promise<Delivered>;
    const repaired = await checks('flaky', 1);
    const passed = await until(f.engine, repaired.id, (t) => t.status === 'completed');
    assert.equal(passed.verificationAttempts, 2);
    assert.equal(passed.deliveredAt, passed.updatedAt, 'the completion after the repair');
    const failing = await checks('broken', 0);
    const blocked = await until(f.engine, failing.id, (t) => t.status === 'blocked');
    assert.equal(blocked.deliveredAt, undefined, 'a failed check delivers nothing');

    // B02: the field is stored with the task, so a read-only view has it too.
    const reader = await openReadOnlyEngine({ stateDir: f.stateDir });
    try {
      const offline = (await reader.call('tasks.get', { taskId: repaired.id })) as Delivered;
      assert.equal(offline.deliveredAt, passed.deliveredAt);
    } finally {
      await reader.close();
    }
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});
