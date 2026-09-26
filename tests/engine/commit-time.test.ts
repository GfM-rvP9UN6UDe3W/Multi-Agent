import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  ApprovalRequest,
  Engine,
  EngineClock,
  EngineConfig,
  EventEnvelope,
  EventPage,
  OperationSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0030 B: the engine reads its clock once per transaction, and every time it writes there is
// that reading.

const DAY = 86_400_000;
type Delivered = TaskSnapshot & { deliveredAt?: string };
type Store = { db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } } };

/** A clock one day ahead of the process clock that advances at each reading, so that two
 * readings never agree. */
function ticking(): EngineClock {
  let last = 0;
  return {
    wallNow: () => (last = Math.max(last + 1, Date.now() + DAY)),
    monotonicNow: () => performance.now(),
    setTimer(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
}
async function setup(overrides: Partial<EngineConfig> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-commit-time-')));
  await mkdir(join(root, 'workspace'));
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
    clock: ticking(),
    verificationRules: [
      {
        id: 'pass',
        version: '1',
        argv: [process.execPath, '-e', 'process.exit(0)'],
        cwdRelative: '.',
        timeoutMs: 10_000,
        permissionProfile: 'read-only',
        success: { exitCode: 0 },
      },
    ],
    ...overrides,
  } as EngineConfig);
  return {
    engine,
    store: (engine as unknown as { store: Store }).store,
    async close() {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function create(engine: Engine, acceptance: Record<string, unknown>) {
  return (await engine.call('tasks.create', {
    spec: { goal: 'Deliver', runtime: { provider: 'fake', model: 'fixture' }, acceptance },
    idempotencyKey: crypto.randomUUID(),
  })) as Delivered;
}
async function until(engine: Engine, id: string, status: string) {
  let task: Delivered | undefined;
  for (let i = 0; i < 1000; i++) {
    task = (await engine.call('tasks.get', { taskId: id })) as Delivered;
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${id} did not become ${status}; last ${task?.status}/${task?.reason}`);
}
async function events(engine: Engine, taskId?: string): Promise<EventEnvelope[]> {
  const page = (await engine.call('events.read', {
    ...(taskId ? { taskId } : {}),
    limit: 1000,
  })) as EventPage;
  return page.events;
}
const last = (list: EventEnvelope[], type: string) =>
  list.filter((event) => event.type === type).at(-1)!;

test('0030-B01 a delivery, its task times and the events of its change have one time', async () => {
  const f = await setup();
  try {
    const human = await create(f.engine, { mode: 'human', criteria: ['Review'] });
    const offered = await until(f.engine, human.id, 'waiting_approval');
    const humanEvents = await events(f.engine, human.id);
    const waiting = last(humanEvents, 'task.waiting_approval');
    assert.equal(offered.deliveredAt, waiting.occurredAt);
    assert.equal(offered.updatedAt, waiting.occurredAt);
    // The request for review is committed with the change.
    assert.equal(last(humanEvents, 'approval.requested').occurredAt, waiting.occurredAt);

    const checks = await create(f.engine, {
      mode: 'checks',
      ruleRefs: [{ id: 'pass', version: '1' }],
    });
    const passed = await until(f.engine, checks.id, 'completed');
    const completed = last(await events(f.engine, checks.id), 'task.completed');
    assert.equal(passed.deliveredAt, completed.occurredAt);
    assert.equal(passed.updatedAt, completed.occurredAt);
    // A task's creation and its first event share a time too.
    assert.equal(checks.createdAt, (await events(f.engine, checks.id))[0].occurredAt);
  } finally {
    await f.close();
  }
});

test('0030-B02 task and dispatch times follow the engine clock, not the process clock', async () => {
  const f = await setup();
  try {
    const task = await create(f.engine, { mode: 'human', criteria: ['Review'] });
    const offered = await until(f.engine, task.id, 'waiting_approval');
    const dispatches = (
      f.store.db.prepare('SELECT data FROM dispatches').all() as { data: string }[]
    ).map((row) => JSON.parse(row.data) as { taskId: string; createdAt: string });
    const times = {
      createdAt: offered.createdAt,
      updatedAt: offered.updatedAt,
      deliveredAt: offered.deliveredAt!,
      dispatchCreatedAt: dispatches.find((dispatch) => dispatch.taskId === task.id)!.createdAt,
    };
    for (const [name, time] of Object.entries(times)) {
      const ahead = Date.parse(time) - Date.now();
      assert.ok(Math.abs(ahead - DAY) < 60_000, `${name} ${time} is not on the engine clock`);
    }
  } finally {
    await f.close();
  }
});

test('0030-B03 events of one transaction share a time, and times never decrease by cursor', async () => {
  const f = await setup();
  try {
    const task = await create(f.engine, { mode: 'human', criteria: ['Review'] });
    const offered = await until(f.engine, task.id, 'waiting_approval');
    const approval = (await f.engine.call('approvals.get', {
      approvalId: offered.approvalId,
    })) as ApprovalRequest;
    const decided = (await f.engine.call('approvals.decide', {
      approvalId: offered.approvalId,
      decision: { choice: 'approve', expectedRevision: approval.revision },
      idempotencyKey: crypto.randomUUID(),
    })) as OperationSnapshot;
    await until(f.engine, task.id, 'completed');
    const all = await events(f.engine);
    const ofDecision = all.filter((event) => event.operationId === decided.id);
    assert.ok(ofDecision.length >= 2, JSON.stringify(ofDecision.map((event) => event.type)));
    assert.deepEqual(
      [...new Set(ofDecision.map((event) => event.occurredAt))],
      [ofDecision[0].occurredAt],
      JSON.stringify(ofDecision.map((event) => [event.type, event.occurredAt])),
    );
    for (let i = 1; i < all.length; i++)
      assert.ok(
        all[i].occurredAt >= all[i - 1].occurredAt,
        `${all[i - 1].type} ${all[i - 1].occurredAt} then ${all[i].type} ${all[i].occurredAt}`,
      );
  } finally {
    await f.close();
  }
});
