import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createEngine } from '../../packages/engine/src/index.ts';
import { createFakeAdapter } from '../../packages/engine/src/fake.ts';
import type {
  Engine,
  EngineConfig,
  ApprovalRequest,
  SessionSnapshot,
  RuntimeAdapter,
  SchedulerSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

const spec = (goal: string, provider = 'fake') => ({
  goal,
  runtime: { provider, model: 'test' },
  acceptance: { mode: 'human', criteria: ['review offline fixture'] },
});
const create = (engine: Engine, goal: string, provider = 'fake') =>
  engine.call('tasks.create', {
    spec: spec(goal, provider),
    idempotencyKey: goal,
  }) as Promise<TaskSnapshot>;
const task = (engine: Engine, taskId: string) =>
  engine.call('tasks.get', { taskId }) as Promise<TaskSnapshot>;
async function until(check: () => Promise<boolean>): Promise<void> {
  const end = performance.now() + 3000;
  while (!(await check())) {
    assert.ok(performance.now() < end, 'fixture did not reach expected state');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
async function fixture(
  adapters = [createFakeAdapter({ result: 'offline result' })],
  limits?: EngineConfig['limits'],
) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-history-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace);
  const config = { workspace, stateDir: join(dir, 'state'), adapters, limits };
  const engine = await createEngine(config);
  return {
    config,
    engine,
    async close() {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('AC-R01 dispatch work does not multiply historical task and dispatch scans', async (t) => {
  for (const historySize of [30, 60]) {
    await t.test(`${historySize} retained waiting-approval tasks`, async (t) => {
      const f = await fixture();
      try {
        const historicalIds = new Set<string>();
        for (let i = 0; i < historySize; i++) {
          const saved = await create(f.engine, `history-${i}`);
          historicalIds.add(saved.id);
          await until(async () => (await task(f.engine, saved.id)).status === 'waiting_approval');
        }
        await new Promise<void>((resolve) => setImmediate(resolve));

        // Measure decoded persistence records, not elapsed time or a particular SQL spelling.
        // A fixed number of admission checks may scan dispatch history; each historical task
        // must not trigger another scan or be decoded just to reject its non-queued status.
        let historicalTasksDecoded = 0;
        let dispatchesDecoded = 0;
        const originalParse = JSON.parse;
        const parsing = t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
          const value: unknown = originalParse(...args);
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const row = value as Record<string, unknown>;
            if (typeof row.id === 'string' && historicalIds.has(row.id) && row.spec)
              historicalTasksDecoded++;
            if (row.executionLease && row.taskId) dispatchesDecoded++;
          }
          return value;
        });
        let next: TaskSnapshot;
        try {
          next = await create(f.engine, 'next');
        } finally {
          parsing.mock.restore();
        }
        t.diagnostic(JSON.stringify({ historySize, historicalTasksDecoded, dispatchesDecoded }));
        assert.ok(
          dispatchesDecoded <= 8 * (historySize + 1),
          `${dispatchesDecoded} decoded dispatch records exceeded a linear admission budget`,
        );
        assert.equal(historicalTasksDecoded, 0, 'non-queued history should stay in SQLite');
        await until(async () => (await task(f.engine, next.id)).status === 'waiting_approval');
        assert.equal((await task(f.engine, next.id)).result, 'offline result');
      } finally {
        await f.close();
      }
    });
  }
});

test('AC-R01 per-task turn limits do not count unrelated history or starve later candidates', async () => {
  const started: string[] = [];
  const base = createFakeAdapter({ result: 'offline result' });
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute(input) {
      started.push(input.taskId);
      yield* base.execute(input);
    },
  };
  const f = await fixture([adapter], { maxTurnsPerTask: 2 });
  const prepareNextTurn = async (saved: TaskSnapshot) => {
    await until(async () => (await task(f.engine, saved.id)).status === 'waiting_approval');
    const current = await task(f.engine, saved.id);
    const session = (await f.engine.call('sessions.get', {
      sessionId: current.sessionId,
    })) as SessionSnapshot;
    await f.engine.call('messages.send', {
      spec: {
        taskId: current.id,
        toSessionId: current.sessionId,
        expectedGeneration: session.generation,
        kind: 'assignment',
        summary: 'one more offline fixture turn',
      },
      idempotencyKey: `message-${current.approvalId}`,
    });
    const approval = (await f.engine.call('approvals.get', {
      approvalId: current.approvalId,
    })) as ApprovalRequest;
    return {
      approvalId: approval.approvalId,
      decision: { choice: 'approve', expectedRevision: approval.revision },
      idempotencyKey: `approval-${approval.approvalId}`,
    };
  };
  try {
    for (const goal of ['unrelated-one', 'unrelated-two']) {
      const saved = await create(f.engine, goal);
      await until(async () => (await task(f.engine, saved.id)).status === 'waiting_approval');
    }
    const limited = await create(f.engine, 'limited');
    await f.engine.call('approvals.decide', await prepareNextTurn(limited));
    const approval = await prepareNextTurn(limited);
    assert.equal(started.filter((id) => id === limited.id).length, 2);

    const exhausted = f.engine.call('approvals.decide', approval);
    const laterPromise = create(f.engine, 'later');
    await exhausted;
    const later = await laterPromise;
    await until(async () => (await task(f.engine, later.id)).status === 'waiting_approval');
    const stopped = await task(f.engine, limited.id);
    assert.equal(stopped.status, 'paused');
    assert.equal(stopped.reason, 'max_turns_reached');
    assert.equal(started.filter((id) => id === limited.id).length, 2);
    assert.equal(started.filter((id) => id === later.id).length, 1);
  } finally {
    await f.close();
  }
});

test('AC-R01 populated schema2 stores regain query indexes without changing history', async () => {
  const f = await fixture();
  let reopened: Engine | undefined;
  try {
    for (const goal of ['first', 'second']) {
      const saved = await create(f.engine, goal);
      await until(async () => (await task(f.engine, saved.id)).status === 'waiting_approval');
    }
    await f.engine.close();
    const old = new DatabaseSync(join(f.config.stateDir, 'store.sqlite'));
    let before: unknown;
    try {
      old.exec('DROP INDEX IF EXISTS tasks_status; DROP INDEX IF EXISTS dispatches_task;');
      before = old.prepare('SELECT id,data FROM tasks ORDER BY rowid').all();
    } finally {
      old.close();
    }
    reopened = await createEngine(f.config);
    assert.equal(reopened.storeId, f.engine.storeId);
    const db = new DatabaseSync(join(f.config.stateDir, 'store.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(db.prepare('SELECT id,data FROM tasks ORDER BY rowid').all(), before);
      assert.equal(
        (
          db.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get() as {
            value: string;
          }
        ).value,
        '2',
      );
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('tasks_status','dispatches_task') ORDER BY name",
        )
        .all() as { name: string }[];
      assert.deepEqual(
        indexes.map((row) => row.name),
        ['dispatches_task', 'tasks_status'],
      );
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT data FROM tasks WHERE json_extract(data, '$.status')='queued' ORDER BY rowid",
        )
        .all() as { detail: string }[];
      assert.ok(plan.some((row) => /USING INDEX tasks_status/.test(row.detail)));
      assert.ok(plan.every((row) => !/TEMP B-TREE/.test(row.detail)));
    } finally {
      db.close();
    }
    const first = await create(reopened, 'new-first');
    const second = await create(reopened, 'new-second');
    for (const saved of [first, second])
      await until(async () => (await task(reopened!, saved.id)).status === 'waiting_approval');
  } finally {
    await reopened?.close({ mode: 'interrupt', timeoutMs: 1000 });
    await f.close();
  }
});

test('AC-R01 preserves FIFO and capacity after a queued candidate loses adapter capability', async () => {
  let supported = true;
  const unavailableBase = createFakeAdapter({ provider: 'unavailable' });
  const unavailable: RuntimeAdapter = {
    ...unavailableBase,
    capabilities: () => ({
      ...unavailableBase.capabilities(),
      executionBudget: {
        version: supported ? 2 : 1,
        acceptanceCapMs: null,
        turnCapMs: null,
      },
    }),
  };
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const base = createFakeAdapter({ result: 'offline result' });
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute(input) {
      started.push(input.prompt);
      let onAbort: () => void = () => {};
      await new Promise<void>((resolve) => {
        onAbort = resolve;
        release.set(input.prompt, resolve);
        input.signal.addEventListener('abort', onAbort, { once: true });
        if (input.signal.aborted) resolve();
      });
      input.signal.removeEventListener('abort', onAbort);
      yield* base.execute(input);
    },
  };
  const f = await fixture([unavailable, adapter]);
  try {
    // Creation validates the provider before the queued microtask runs. Invalidation must
    // pause only the first candidate and must not prevent later candidates from starting.
    const pending = [
      create(f.engine, 'unavailable', 'unavailable'),
      create(f.engine, 'one'),
      create(f.engine, 'two'),
      create(f.engine, 'three'),
    ];
    supported = false;
    const [bad, one, two, three] = await Promise.all(pending);
    await until(async () => started.length === 2);
    assert.deepEqual(started, ['one', 'two']);
    assert.equal((await task(f.engine, bad.id)).status, 'paused');
    assert.match((await task(f.engine, bad.id)).reason!, /UNSUPPORTED_CAPABILITY/);
    assert.equal((await task(f.engine, three.id)).status, 'queued');
    const full = (await f.engine.call('scheduler.get')) as SchedulerSnapshot;
    assert.equal(full.executionOccupied, 2);
    assert.equal(full.canDispatch, false);

    release.get('one')!();
    await until(async () => started.length === 3);
    assert.deepEqual(started, ['one', 'two', 'three']);
    assert.equal(
      ((await f.engine.call('scheduler.get')) as SchedulerSnapshot).executionOccupied,
      2,
    );
    release.get('two')!();
    release.get('three')!();
    for (const current of [one, two, three])
      await until(async () => (await task(f.engine, current.id)).status === 'waiting_approval');
    assert.equal(
      ((await f.engine.call('scheduler.get')) as SchedulerSnapshot).executionOccupied,
      0,
    );
  } finally {
    await f.close();
  }
});
