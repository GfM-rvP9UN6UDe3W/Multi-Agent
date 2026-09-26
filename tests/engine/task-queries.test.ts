import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type {
  Engine,
  EngineConfig,
  RuntimeAdapter,
  RuntimeInput,
  TaskListResult,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0028 P: status filters and reverse order, batch reads, and token totals per root task.

type Store = {
  db: {
    prepare(sql: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown };
  };
};

/** A fake runtime that reports one usage record per dispatch, with counts taken from the goal. */
function reporting(): RuntimeAdapter {
  const base = createFakeAdapter();
  return {
    ...base,
    async *execute(input: RuntimeInput) {
      for await (const event of base.execute(input)) {
        yield event;
        if (event.type === 'accepted') {
          const unknown = input.prompt.includes('unknown usage');
          const size = Number(/size=(\d+)/.exec(input.prompt)?.[1] ?? 1);
          yield {
            type: 'usage',
            usageId: 'u1',
            usage: {
              inputTokens: unknown ? null : size * 10,
              cachedInputTokens: unknown ? null : size,
              cacheWriteInputTokens: null,
              outputTokens: unknown ? null : size * 2,
              raw: { size },
            },
          };
        }
      }
    },
  };
}
async function setup(overrides: Partial<EngineConfig> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-task-queries-')));
  await mkdir(join(root, 'workspace'));
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [reporting()],
    providers: { fake: { models: ['small', 'large'] } },
    ...overrides,
  });
  return {
    engine,
    store: (engine as unknown as { store: Store }).store,
    async close() {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
      await rm(root, { recursive: true, force: true });
    },
  };
}
const spec = (goal: string, extra: Record<string, unknown> = {}) => ({
  goal,
  runtime: { provider: 'fake', model: 'small' },
  acceptance: { mode: 'human' as const, criteria: ['Review'] },
  ...extra,
});
async function create(engine: Engine, goal: string, extra: Record<string, unknown> = {}) {
  return (await engine.call('tasks.create', {
    spec: spec(goal, extra),
    idempotencyKey: crypto.randomUUID(),
  })) as TaskSnapshot;
}
async function wait(engine: Engine, id: string, status: string) {
  let task: TaskSnapshot | undefined;
  for (let i = 0; i < 400; i++) {
    task = (await engine.call('tasks.get', { taskId: id })) as TaskSnapshot;
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${id} did not become ${status}; last ${task?.status}/${task?.reason}`);
}
async function approve(engine: Engine, id: string) {
  const task = await wait(engine, id, 'waiting_approval');
  const approval = (await engine.call('approvals.get', { approvalId: task.approvalId })) as {
    revision: number;
  };
  await engine.call('approvals.decide', {
    approvalId: task.approvalId,
    decision: { choice: 'approve', expectedRevision: approval.revision },
    idempotencyKey: crypto.randomUUID(),
  });
  return wait(engine, id, 'completed');
}
const ids = (page: unknown) => (page as TaskListResult).tasks.map((task) => task.id);

test('0028-P01 tasks.list filters by status, combines it with a label and pages newest first', async () => {
  const f = await setup();
  try {
    const done = await create(f.engine, 'done', { label: 'group:a' });
    await approve(f.engine, done.id);
    const waiting = await create(f.engine, 'waiting', { label: 'group:a' });
    await wait(f.engine, waiting.id, 'waiting_approval');
    const other = await create(f.engine, 'other label', { label: 'group:b' });
    await wait(f.engine, other.id, 'waiting_approval');
    const cancelled = await create(f.engine, 'cancelled', { label: 'group:a' });
    await wait(f.engine, cancelled.id, 'waiting_approval');
    await f.engine.call('tasks.cancel', {
      taskId: cancelled.id,
      idempotencyKey: crypto.randomUUID(),
    });
    await wait(f.engine, cancelled.id, 'cancelled');

    assert.deepEqual(ids(await f.engine.call('tasks.list', { status: ['waiting_approval'] })), [
      waiting.id,
      other.id,
    ]);
    assert.deepEqual(
      ids(
        await f.engine.call('tasks.list', {
          status: ['waiting_approval', 'completed'],
          label: 'group:a',
        }),
      ),
      [done.id, waiting.id],
    );
    // The question "is any task active" answers from the active tasks only.
    assert.deepEqual(
      ids(
        await f.engine.call('tasks.list', {
          status: ['queued', 'waiting_dependency', 'running', 'verifying'],
          limit: 1,
        }),
      ),
      [],
    );
    // Newest first, one task per page, and the cursor continues with older tasks.
    const seen: string[] = [];
    let afterCursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = (await f.engine.call('tasks.list', {
        label: 'group:a',
        order: 'desc',
        limit: 1,
        ...(afterCursor ? { afterCursor } : {}),
      })) as TaskListResult;
      seen.push(...result.tasks.map((task) => task.id));
      if (!result.nextCursor) break;
      afterCursor = result.nextCursor;
    }
    assert.deepEqual(seen, [cancelled.id, waiting.id, done.id]);
    assert.deepEqual(
      ids(await f.engine.call('tasks.list', { order: 'desc', status: ['waiting_approval'] })),
      [other.id, waiting.id],
    );
    assert.deepEqual(ids(await f.engine.call('tasks.list', { order: 'asc', limit: 2 })), [
      done.id,
      waiting.id,
    ]);
    assert.deepEqual(ids(await f.engine.call('tasks.list', { order: 'desc', limit: 2 })), [
      cancelled.id,
      other.id,
    ]);
    for (const bad of [
      { status: [] },
      { status: ['nope'] },
      { status: ['queued', 'queued'] },
      { status: 'queued' },
      {
        status: [
          'queued',
          'running',
          'waiting_approval',
          'paused',
          'blocked',
          'completed',
          'failed',
          'cancelled',
          'waiting_dependency',
          'verifying',
          'queued',
        ],
      },
      { order: 'newest' },
      { status: ['queued'], label: 'group:a', parentTaskId: done.id },
    ])
      await assert.rejects(f.engine.call('tasks.list', bad), { code: 'VALIDATION_ERROR' });
  } finally {
    await f.close();
  }
});

test('0028-P02 tasks.getMany returns the tasks and the missing IDs in the order requested', async () => {
  const f = await setup();
  try {
    const first = await create(f.engine, 'first');
    const second = await create(f.engine, 'second');
    await wait(f.engine, first.id, 'waiting_approval');
    await wait(f.engine, second.id, 'waiting_approval');
    const result = (await f.engine.call('tasks.getMany', {
      taskIds: [second.id, 'missing-1', first.id, 'missing-0'],
    })) as { tasks: TaskSnapshot[]; missing: string[] };
    assert.deepEqual(
      result.tasks.map((task) => task.id),
      [second.id, first.id],
    );
    assert.equal(result.tasks[0].status, 'waiting_approval');
    assert.deepEqual(result.missing, ['missing-1', 'missing-0']);
    const hundred = Array.from({ length: 100 }, (_, n) => `missing-${n}`);
    assert.equal(
      ((await f.engine.call('tasks.getMany', { taskIds: hundred })) as { missing: string[] })
        .missing.length,
      100,
    );
    for (const bad of [
      { taskIds: [] },
      { taskIds: [...hundred, 'one-more'] },
      { taskIds: [first.id, first.id] },
      { taskIds: [''] },
      { taskIds: first.id },
      {},
    ])
      await assert.rejects(f.engine.call('tasks.getMany', bad), { code: 'VALIDATION_ERROR' });
  } finally {
    await f.close();
  }
});

type Totals = {
  records: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  unknownRecords: number;
};
type Summary = {
  rootTaskId: string;
  byModel: (Totals & { provider: string; model: string | null })[];
  totals: Totals;
  completeness: 'reported' | 'unknown';
};

test('0028-P03 usage.summary totals a root task and its children by model', async () => {
  const f = await setup();
  try {
    const root = await create(f.engine, 'root size=1');
    await approve(f.engine, root.id);
    const child = await create(f.engine, 'child size=2', {
      parentTaskId: root.id,
      runtime: { provider: 'fake', model: 'large' },
    });
    await approve(f.engine, child.id);
    const grandchild = await create(f.engine, 'grandchild size=4', { parentTaskId: child.id });
    await approve(f.engine, grandchild.id);
    const unrelated = await create(f.engine, 'unrelated size=100');
    await approve(f.engine, unrelated.id);

    const summary = (await f.engine.call('usage.summary', { rootTaskId: root.id })) as Summary;
    assert.equal(summary.rootTaskId, root.id);
    assert.deepEqual(summary.byModel, [
      {
        provider: 'fake',
        model: 'large',
        records: 1,
        inputTokens: 20,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 0,
        outputTokens: 4,
        unknownRecords: 0,
      },
      {
        provider: 'fake',
        model: 'small',
        records: 2,
        inputTokens: 50,
        cachedInputTokens: 5,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
        unknownRecords: 0,
      },
    ]);
    assert.deepEqual(summary.totals, {
      records: 3,
      inputTokens: 70,
      cachedInputTokens: 7,
      cacheWriteInputTokens: 0,
      outputTokens: 14,
      unknownRecords: 0,
    });
    assert.equal(summary.completeness, 'reported');

    // A record of an earlier version has no model: its dispatch's session gives it, until that
    // dispatch is collected.
    f.store.db
      .prepare(
        "UPDATE usage SET data=json_remove(data,'$.model','$.sessionId','$.rootTaskId','$.recordedAt')",
      )
      .run();
    assert.deepEqual(
      ((await f.engine.call('usage.summary', { rootTaskId: root.id })) as Summary).byModel.map(
        (entry) => [entry.model, entry.records],
      ),
      [
        ['large', 1],
        ['small', 2],
      ],
    );
    f.store.db
      .prepare("DELETE FROM dispatches WHERE json_extract(data,'$.taskId')=?")
      .run(grandchild.id);
    assert.deepEqual(
      ((await f.engine.call('usage.summary', { rootTaskId: root.id })) as Summary).byModel.map(
        (entry) => [entry.model, entry.records, entry.inputTokens],
      ),
      [
        ['large', 1, 20],
        ['small', 1, 10],
        [null, 1, 40],
      ],
    );

    const unknown = await create(f.engine, 'unknown usage');
    await approve(f.engine, unknown.id);
    const partial = (await f.engine.call('usage.summary', { rootTaskId: unknown.id })) as Summary;
    assert.equal(partial.completeness, 'unknown');
    assert.equal(partial.totals.unknownRecords, 1);
    assert.equal(partial.totals.inputTokens, 0);

    await assert.rejects(f.engine.call('usage.summary', { rootTaskId: child.id }), {
      code: 'VALIDATION_ERROR',
    });
    await assert.rejects(f.engine.call('usage.summary', { rootTaskId: 'missing' }), {
      code: 'NOT_FOUND',
    });
    await assert.rejects(f.engine.call('usage.summary', {}), { code: 'VALIDATION_ERROR' });
  } finally {
    await f.close();
  }
});

test('0028-P03 a root task without records is unknown, with zero totals', async () => {
  const f = await setup({ adapters: [createFakeAdapter()] });
  try {
    const root = await create(f.engine, 'no usage');
    await wait(f.engine, root.id, 'waiting_approval');
    const summary = (await f.engine.call('usage.summary', { rootTaskId: root.id })) as Summary;
    assert.deepEqual(summary, {
      rootTaskId: root.id,
      byModel: [],
      totals: {
        records: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        unknownRecords: 0,
      },
      completeness: 'unknown',
    });
  } finally {
    await f.close();
  }
});

/** Records every statement the store prepares while `run` runs. */
async function statements(store: Store, run: () => Promise<unknown>): Promise<string[]> {
  const db = store.db as unknown as { prepare(sql: string): unknown };
  const prepare = db.prepare;
  const seen: string[] = [];
  db.prepare = (sql: string) => {
    seen.push(sql);
    return prepare.call(store.db, sql);
  };
  try {
    await run();
  } finally {
    db.prepare = prepare;
  }
  return seen;
}
/** The query plan steps of `sql` that read `tables`, whole or through an index. */
function plans(store: Store, sql: string[], tables: string[]): string[] {
  const steps: string[] = [];
  for (const statement of new Set(sql)) {
    if (!tables.some((table) => new RegExp(`\\b${table}\\b`).test(statement))) continue;
    for (const step of store.db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all() as {
      detail: string;
    }[])
      steps.push(step.detail);
  }
  return steps;
}
/** Steps that read a whole table or index, under its name or an alias; searches are fine. */
const wholeTable = (steps: string[]) => steps.filter((step) => /^SCAN /.test(step));

test('0028-P04 the new queries and usage.get search indexes instead of reading whole tables', async () => {
  const f = await setup();
  try {
    const root = await create(f.engine, 'root size=1');
    await approve(f.engine, root.id);
    const child = await create(f.engine, 'child size=2', { parentTaskId: root.id });
    await approve(f.engine, child.id);
    const tables = ['tasks', 'usage'];
    const active = await statements(f.store, () =>
      f.engine.call('tasks.list', {
        status: ['queued', 'waiting_dependency', 'running', 'verifying'],
        limit: 1,
      }),
    );
    const activePlan = plans(f.store, active, tables);
    assert.deepEqual(wholeTable(activePlan), [], 'tasks.list with status');
    assert.ok(
      activePlan.some((step) => step.includes('tasks_status')),
      JSON.stringify(activePlan),
    );
    const newest = await statements(f.store, () =>
      f.engine.call('tasks.list', { status: ['completed'], order: 'desc', limit: 1 }),
    );
    assert.deepEqual(wholeTable(plans(f.store, newest, tables)), [], 'newest first');
    const many = await statements(f.store, () =>
      f.engine.call('tasks.getMany', { taskIds: [root.id, child.id, 'missing'] }),
    );
    assert.deepEqual(wholeTable(plans(f.store, many, tables)), [], 'tasks.getMany');
    const summary = await statements(f.store, () =>
      f.engine.call('usage.summary', { rootTaskId: root.id }),
    );
    const summaryPlan = plans(f.store, summary, tables);
    assert.deepEqual(wholeTable(summaryPlan), [], 'usage.summary');
    for (const index of ['tasks_root', 'usage_task'])
      assert.ok(
        summaryPlan.some((step) => step.includes(index)),
        `${index}: ${JSON.stringify(summaryPlan)}`,
      );
    const usage = await statements(f.store, () => f.engine.call('usage.get', { taskId: child.id }));
    const usagePlan = plans(f.store, usage, tables);
    assert.deepEqual(wholeTable(usagePlan), [], 'usage.get');
    assert.ok(
      usagePlan.some((step) => step.includes('usage_task')),
      JSON.stringify(usagePlan),
    );
  } finally {
    await f.close();
  }
});
