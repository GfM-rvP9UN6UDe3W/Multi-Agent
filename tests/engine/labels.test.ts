import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import {
  createClaudeAdapter,
  type ClaudeAdapterConfig,
} from '../../packages/adapter-claude/src/index.ts';
import { Orchestrator, createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import type {
  Engine,
  EngineConfig,
  EventPage,
  Json,
  RuntimeAdapter,
  RuntimeInput,
  SessionSnapshot,
  TaskListResult,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0027 L: host labels and metadata on tasks and sessions, and the task chain in RuntimeInput.

type Tools = { call(name: string, args: unknown): Promise<unknown> };
type Labeled = RuntimeInput & {
  parentTaskId?: string | null;
  rootTaskId?: string;
  label?: string | null;
  metadata?: Json | null;
  sessionLabel?: string | null;
  sessionMetadata?: Json | null;
  orchestrationTools?: Tools;
};

/** A fake runtime that records each dispatch input and can call bound tools first. */
function recording(act?: (input: Labeled) => Promise<void>) {
  const base = createFakeAdapter();
  const inputs: Labeled[] = [];
  const adapter: RuntimeAdapter = {
    ...base,
    async *execute(input) {
      inputs.push(input as Labeled);
      await act?.(input as Labeled);
      yield* base.execute(input);
    },
  };
  return { adapter, inputs };
}
async function setup(adapter: RuntimeAdapter, overrides: Partial<EngineConfig> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-labels-')));
  await mkdir(join(root, 'workspace'));
  const engine = await createEngine({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [adapter],
    ...overrides,
  });
  return {
    engine,
    store: (engine as unknown as { store: { db: { prepare(sql: string): { all(): unknown } } } })
      .store,
    async close() {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
      await rm(root, { recursive: true, force: true });
    },
  };
}
const spec = (extra: Record<string, unknown> = {}) => ({
  goal: 'A labeled task',
  runtime: { provider: 'fake', model: 'fixture' },
  acceptance: { mode: 'human' as const, criteria: ['Review'] },
  ...extra,
});
const create = async (engine: Engine, extra: Record<string, unknown> = {}, key?: string) =>
  (await engine.call('tasks.create', {
    spec: spec(extra),
    idempotencyKey: key ?? crypto.randomUUID(),
  })) as TaskSnapshot;
async function wait(engine: Engine, id: string, status: string) {
  let task: TaskSnapshot | undefined;
  for (let i = 0; i < 400; i++) {
    task = (await engine.call('tasks.get', { taskId: id })) as TaskSnapshot;
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${id} did not become ${status}; last ${task?.status}/${task?.reason}`);
}
const nested = (depth: number): Json => (depth <= 1 ? {} : { next: nested(depth - 1) });
const labelOf = (value: unknown) => (value as { spec?: { label?: unknown } }).spec?.label;
const metadataOf = (value: unknown) => (value as { spec?: { metadata?: unknown } }).spec?.metadata;

test('0027-L01 labels and metadata are bounded, returned in snapshots and part of the request digest', async () => {
  const f = await setup(recording().adapter);
  try {
    const info = (await f.engine.call('initialize', {
      protocolVersion: '2.0',
      sdkVersion: 'test',
    })) as { capabilities: { workflow: Record<string, unknown> } };
    assert.equal(info.capabilities.workflow.labels, true);
    const metadata = { agent: 'reviewer', thread: { id: 't-1', task_id: 'kept as written' } };
    const task = await create(f.engine, { label: 'group:alpha', metadata }, 'labeled');
    assert.equal(labelOf(task), 'group:alpha');
    assert.deepEqual(metadataOf(task), metadata);
    const read = (await f.engine.call('tasks.get', { taskId: task.id })) as TaskSnapshot;
    assert.equal(labelOf(read), 'group:alpha');
    assert.deepEqual(metadataOf(read), metadata);
    // The same key with another label is another request.
    await assert.rejects(create(f.engine, { label: 'group:beta', metadata }, 'labeled'), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await assert.rejects(create(f.engine, { label: 'group:alpha' }, 'labeled'), {
      code: 'IDEMPOTENCY_CONFLICT',
    });

    // 256 UTF-8 bytes is the longest label; 'é' is two bytes.
    assert.equal(labelOf(await create(f.engine, { label: 'é'.repeat(128) })), 'é'.repeat(128));
    // A JSON object of 4096 encoded bytes, 16 levels deep, is the largest metadata.
    const room = 4096 - JSON.stringify({ text: '' }).length;
    assert.ok(await create(f.engine, { metadata: { text: 'x'.repeat(room) } }));
    assert.ok(await create(f.engine, { metadata: nested(16) }));
    for (const invalid of [
      { label: '' },
      { label: 'é'.repeat(128) + 'x' },
      { label: 7 },
      { metadata: [] },
      { metadata: 'text' },
      { metadata: null },
      { metadata: { text: 'x'.repeat(room + 1) } },
      { metadata: nested(17) },
    ])
      await assert.rejects(
        create(f.engine, invalid),
        { code: 'VALIDATION_ERROR' },
        JSON.stringify(invalid).slice(0, 80),
      );

    const session = (await f.engine.call('sessions.open', {
      spec: { runtime: { provider: 'fake', model: 'fixture' }, label: 'group:alpha', metadata },
      idempotencyKey: 'session',
    })) as SessionSnapshot & { label?: string; metadata?: Json };
    assert.equal(session.label, 'group:alpha');
    assert.deepEqual(session.metadata, metadata);
    const again = (await f.engine.call('sessions.get', { sessionId: session.id })) as {
      label?: string;
      metadata?: Json;
    };
    assert.equal(again.label, 'group:alpha');
    assert.deepEqual(again.metadata, metadata);
    await assert.rejects(
      f.engine.call('sessions.open', {
        spec: { runtime: { provider: 'fake', model: 'fixture' }, label: '' },
        idempotencyKey: 'bad-session',
      }),
      { code: 'VALIDATION_ERROR' },
    );
  } finally {
    await f.close();
  }
});

test('0027-L02 the engine passes labels to what it creates; the host passes its own', async () => {
  const delegated: TaskSnapshot[] = [];
  let delegatedOnce = false;
  const runtime = recording(async (input) => {
    if (!input.prompt.startsWith('parent') || delegatedOnce) return;
    delegatedOnce = true;
    delegated.push(
      (await input.orchestrationTools!.call('work_delegate', {
        goal: 'child work',
        contextPlan: { requestedMode: 'fresh', independent: true },
        idempotencyKey: 'child',
      })) as unknown as TaskSnapshot,
    );
  });
  const f = await setup(runtime.adapter, { tools: { enabled: true } });
  try {
    const metadata = { agent: 'planner' };
    const parent = await create(f.engine, { goal: 'parent', label: 'group:alpha', metadata });
    await wait(f.engine, parent.id, 'waiting_approval');
    // A delegated child and the session the engine opened for it inherit.
    assert.equal(delegated.length, 1);
    const child = (await f.engine.call('tasks.get', { taskId: delegated[0].id })) as TaskSnapshot;
    assert.equal(child.spec.parentTaskId, parent.id);
    assert.equal(labelOf(child), 'group:alpha');
    assert.deepEqual(metadataOf(child), metadata);
    const childSession = (await f.engine.call('sessions.get', {
      sessionId: child.sessionId,
    })) as { label?: string; metadata?: Json };
    assert.equal(childSession.label, 'group:alpha');
    assert.deepEqual(childSession.metadata, metadata);
    // The session the engine opened for the parent takes the parent's.
    const parentSession = (await f.engine.call('sessions.get', {
      sessionId: parent.sessionId,
    })) as SessionSnapshot & { label?: string; metadata?: Json };
    assert.equal(parentSession.label, 'group:alpha');
    assert.deepEqual(parentSession.metadata, metadata);

    // A child the host creates carries only what the host passed.
    const hostChild = await create(f.engine, { goal: 'host child', parentTaskId: parent.id });
    assert.equal(labelOf(hostChild), undefined);
    assert.equal(metadataOf(hostChild), undefined);
    const relabeled = await create(f.engine, {
      goal: 'relabeled child',
      parentTaskId: parent.id,
      label: 'group:beta',
    });
    assert.equal(labelOf(relabeled), 'group:beta');
    assert.equal(metadataOf(relabeled), undefined);

    // A session the host opens carries what the host passed; a fork takes its source's.
    const opened = (await f.engine.call('sessions.open', {
      spec: { runtime: { provider: 'fake', model: 'fixture' } },
      idempotencyKey: 'plain-session',
    })) as SessionSnapshot & { label?: string };
    assert.equal(opened.label, undefined);
    const pending = await wait(f.engine, parent.id, 'waiting_approval');
    const approval = (await f.engine.call('approvals.get', {
      approvalId: pending.approvalId,
    })) as { revision: number };
    await f.engine.call('approvals.decide', {
      approvalId: pending.approvalId,
      decision: { choice: 'approve', expectedRevision: approval.revision },
      idempotencyKey: 'approve-parent',
    });
    const snapshot = await wait(f.engine, parent.id, 'completed');
    const source = (await f.engine.call('sessions.get', {
      sessionId: parent.sessionId,
    })) as SessionSnapshot;
    const fork = (await f.engine.call('sessions.fork', {
      target: {
        sessionId: source.id,
        expectedGeneration: source.generation,
        expectedRevision: source.revision,
        expectedDispatchId: source.activeDispatchId,
        expectedState: source.status,
      },
      snapshotRef: snapshot.artifactRefs[0],
      idempotencyKey: 'fork',
    })) as SessionSnapshot & { label?: string; metadata?: Json };
    assert.equal(fork.label, 'group:alpha');
    assert.deepEqual(fork.metadata, metadata);
  } finally {
    await f.close();
  }
});

test('0027-L03 tasks.list finds a label through its index and pages', async () => {
  const f = await setup(recording().adapter);
  try {
    const alpha = [
      await create(f.engine, { label: 'group:alpha' }),
      await create(f.engine, { label: 'group:beta' }),
      await create(f.engine, { label: 'group:alpha' }),
      await create(f.engine),
      await create(f.engine, { label: 'group:alpha' }),
    ].filter((task) => labelOf(task) === 'group:alpha');
    const first = (await f.engine.call('tasks.list', {
      label: 'group:alpha',
      limit: 2,
    })) as TaskListResult;
    assert.deepEqual(
      first.tasks.map((task) => task.id),
      alpha.slice(0, 2).map((task) => task.id),
    );
    assert.ok(first.nextCursor);
    const rest = (await f.engine.call('tasks.list', {
      label: 'group:alpha',
      limit: 2,
      afterCursor: first.nextCursor,
    })) as TaskListResult;
    assert.deepEqual(
      rest.tasks.map((task) => task.id),
      [alpha[2].id],
    );
    assert.equal(rest.nextCursor, null);
    assert.deepEqual(
      ((await f.engine.call('tasks.list', { label: 'group:none' })) as TaskListResult).tasks,
      [],
    );
    for (const pair of [
      { label: 'group:alpha', sessionId: alpha[0].sessionId },
      { label: 'group:alpha', parentTaskId: alpha[0].id },
    ])
      await assert.rejects(f.engine.call('tasks.list', pair), { code: 'VALIDATION_ERROR' });
    const plan = f.store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT rowid AS ordinal,data FROM tasks WHERE json_extract(data,'$.spec.label')='group:alpha' AND rowid>0 ORDER BY rowid LIMIT 3",
      )
      .all() as { detail: string }[];
    assert.ok(
      plan.some((row) => row.detail.includes('tasks_label')),
      JSON.stringify(plan),
    );
  } finally {
    await f.close();
  }
});

test('0027-L04 RuntimeInput carries the task chain, labels and frozen copies of metadata', async () => {
  const runtime = recording();
  const f = await setup(runtime.adapter);
  try {
    const metadata = { agent: 'reviewer', nested: { level: 2 } };
    const root = await create(f.engine, { goal: 'root', label: 'group:alpha', metadata });
    await wait(f.engine, root.id, 'waiting_approval');
    const session = (await f.engine.call('sessions.open', {
      spec: {
        runtime: { provider: 'fake', model: 'fixture' },
        label: 'session:reviewer',
        metadata: { seat: 3 },
      },
      idempotencyKey: 'session',
    })) as SessionSnapshot;
    const child = await create(f.engine, {
      goal: 'child',
      parentTaskId: root.id,
      contextPlan: { requestedMode: 'reuse', independent: true, candidateSessionId: session.id },
    });
    await wait(f.engine, child.id, 'waiting_approval');
    const grandchild = await create(f.engine, { goal: 'grandchild', parentTaskId: child.id });
    await wait(f.engine, grandchild.id, 'waiting_approval');

    const byTask = (id: string) => runtime.inputs.find((input) => input.taskId === id)!;
    const pick = (input: Labeled) => ({
      parentTaskId: input.parentTaskId,
      rootTaskId: input.rootTaskId,
      label: input.label,
      metadata: input.metadata,
      sessionLabel: input.sessionLabel,
      sessionMetadata: input.sessionMetadata,
    });
    assert.deepEqual(pick(byTask(root.id)), {
      parentTaskId: null,
      rootTaskId: root.id,
      label: 'group:alpha',
      metadata,
      sessionLabel: 'group:alpha',
      sessionMetadata: metadata,
    });
    assert.deepEqual(pick(byTask(child.id)), {
      parentTaskId: root.id,
      rootTaskId: root.id,
      label: null,
      metadata: null,
      sessionLabel: 'session:reviewer',
      sessionMetadata: { seat: 3 },
    });
    assert.deepEqual(pick(byTask(grandchild.id)), {
      parentTaskId: child.id,
      rootTaskId: root.id,
      label: null,
      metadata: null,
      sessionLabel: null,
      sessionMetadata: null,
    });
    const given = byTask(root.id).metadata as { nested: { level: number } };
    assert.ok(Object.isFrozen(given) && Object.isFrozen(given.nested));
    assert.throws(() => {
      given.nested.level = 99;
    }, TypeError);
    assert.deepEqual(metadataOf(await f.engine.call('tasks.get', { taskId: root.id })), metadata);
  } finally {
    await f.close();
  }
});

test('0027-L04 the Claude adapter shows the labels to extendOptions', async () => {
  let seen: Labeled | undefined;
  const adapter = createClaudeAdapter({
    extendOptions: ({ input }: { input: RuntimeInput }) => {
      seen = input as Labeled;
      return {};
    },
    observeExecutionStop: async () => true,
    query: () => {
      throw new Error('offline fixture: no model call');
    },
  } as ClaudeAdapterConfig);
  const f = await setup(adapter, { providers: { claude: { model: 'offline' } } });
  try {
    const task = (await f.engine.call('tasks.create', {
      spec: {
        goal: 'Show the labels',
        runtime: { provider: 'claude', model: 'offline' },
        acceptance: { mode: 'human', criteria: ['Review'] },
        label: 'group:alpha',
        metadata: { agent: 'reviewer' },
      },
      idempotencyKey: 'claude',
    })) as TaskSnapshot;
    for (let i = 0; i < 400 && !seen; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(seen, 'extendOptions ran');
    assert.equal(seen.taskId, task.id);
    assert.equal(seen.parentTaskId, null);
    assert.equal(seen.rootTaskId, task.id);
    assert.equal(seen.label, 'group:alpha');
    assert.deepEqual(seen.metadata, { agent: 'reviewer' });
    assert.equal(seen.sessionLabel, 'group:alpha');
  } finally {
    await f.close();
  }
});

test('0027-L05 task events carry the label', async () => {
  const f = await setup(recording().adapter);
  try {
    const labeled = await create(f.engine, { label: 'group:alpha' });
    const plain = await create(f.engine);
    await wait(f.engine, labeled.id, 'waiting_approval');
    await wait(f.engine, plain.id, 'waiting_approval');
    const events = async (taskId: string) =>
      ((await f.engine.call('events.read', { taskId, limit: 1000 })) as EventPage).events.filter(
        (event) => event.type.startsWith('task.'),
      );
    const withLabel = await events(labeled.id);
    assert.ok(withLabel.length >= 3, JSON.stringify(withLabel.map((event) => event.type)));
    assert.ok(withLabel.every((event) => event.data.label === 'group:alpha'));
    const without = await events(plain.id);
    assert.ok(without.length >= 3);
    assert.ok(without.every((event) => !('label' in event.data)));
  } finally {
    await f.close();
  }
});

test('0027-L01 0027-L03 the TypeScript SDK sends labels and refuses them to a host without the feature', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-labels-sdk-')));
  await mkdir(join(root, 'workspace'));
  const orch = await createOrchestrator({
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    adapters: [createFakeAdapter()],
    storage: { emergencyBytes: 4096 },
  });
  t.after(async () => {
    await orch.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const task = await orch.tasks.create({
    ...spec(),
    label: 'group:alpha',
    metadata: { agent: 'reviewer' },
  });
  assert.equal(task.initial.spec.label, 'group:alpha');
  const listed = await orch.tasks.list({ label: 'group:alpha' });
  assert.deepEqual(
    listed.tasks.map((item) => item.id),
    [task.id],
  );
  const session = await orch.sessions.open({
    runtime: { provider: 'fake', model: 'fixture' },
    label: 'session:reviewer',
  });
  assert.equal(session.label, 'session:reviewer');

  // A host that does not list workflow.labels never receives the fields.
  const sent: string[] = [];
  const legacy = new Orchestrator(
    {
      async call(method: string) {
        sent.push(method);
        throw new Error('not reached');
      },
      disconnect() {},
    },
    {
      ...orch.info,
      capabilities: {
        ...orch.info.capabilities,
        workflow: { ...(orch.info.capabilities.workflow as object), labels: undefined },
      },
    },
    true,
  );
  await assert.rejects(legacy.tasks.create({ ...spec(), label: 'group:alpha' }), {
    code: 'UNSUPPORTED_CAPABILITY',
  });
  await assert.rejects(legacy.tasks.create({ ...spec(), metadata: { agent: 'reviewer' } }), {
    code: 'UNSUPPORTED_CAPABILITY',
  });
  await assert.rejects(
    legacy.sessions.open({ runtime: { provider: 'fake', model: 'fixture' }, label: 'x' }),
    { code: 'UNSUPPORTED_CAPABILITY' },
  );
  await assert.rejects(legacy.tasks.list({ label: 'group:alpha' }), {
    code: 'UNSUPPORTED_CAPABILITY',
  });
  assert.deepEqual(sent, []);
});
