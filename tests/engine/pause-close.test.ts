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
  RuntimeAdapter,
  RuntimeInput,
  SessionSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0028 S: close({ mode: 'pause' }) pauses what it interrupts as owner_shutdown.

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-pause-close-')));
  await mkdir(join(root, 'workspace'));
  const config: EngineConfig = {
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    // A turn that runs until it is interrupted, then reports its interrupted terminal.
    adapters: [createFakeAdapter({ delayMs: 60_000 })],
    limits: { maxActiveSessions: 1 },
  };
  return {
    config,
    root,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function create(engine: Engine, goal: string) {
  return (await engine.call('tasks.create', {
    spec: {
      goal,
      runtime: { provider: 'fake', model: 'fixture' },
      acceptance: { mode: 'human', criteria: ['Review'] },
    },
    idempotencyKey: crypto.randomUUID(),
  })) as TaskSnapshot;
}
async function wait(engine: Engine, id: string, status: string) {
  for (let i = 0; i < 400; i++) {
    const task = (await engine.call('tasks.get', { taskId: id })) as TaskSnapshot;
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${id} did not become ${status}`);
}
/** Starts one running and one queued task, closes with `mode` and reopens the store. */
async function closeWith(mode: 'drain' | 'interrupt' | 'pause') {
  const f = await setup();
  try {
    const engine = await createEngine(f.config);
    const running = await create(engine, 'running turn');
    await wait(engine, running.id, 'running');
    const queued = await create(engine, 'queued task');
    let closed: { operationId: string };
    try {
      closed = await engine.close({ mode, timeoutMs: 5000 });
    } catch (error) {
      await engine.close({ mode: 'interrupt', timeoutMs: 5000 }).catch(() => {});
      throw error;
    }
    const reopened = await createEngine(f.config);
    try {
      const read = async (id: string) =>
        (await reopened.call('tasks.get', { taskId: id })) as TaskSnapshot;
      const events = (
        (await reopened.call('events.read', { taskId: running.id, limit: 1000 })) as EventPage
      ).events;
      const shutdown = (await reopened.call('operations.get', {
        operationId: closed.operationId,
      })) as OperationSnapshot;
      return {
        running: await read(running.id),
        queued: await read(queued.id),
        reasons: events
          .filter((event) => event.type.startsWith('task.'))
          .map((event) => (event.data as { reason: string | null }).reason),
        shutdown,
        waitStarted: (
          (await reopened.call('events.read', { limit: 1000 })) as EventPage
        ).events.find((event) => event.type === 'shutdown.wait_started'),
      };
    } finally {
      await reopened.close({ mode: 'interrupt', timeoutMs: 1000 });
    }
  } finally {
    await f.cleanup();
  }
}

test('0028-S01 0028-S02 a pausing close pauses the interrupted turn and the queued task as owner_shutdown', async () => {
  const { running, queued, reasons, shutdown, waitStarted } = await closeWith('pause');
  assert.deepEqual([running.status, running.reason], ['paused', 'owner_shutdown']);
  assert.deepEqual([queued.status, queued.reason], ['paused', 'owner_shutdown']);
  assert.ok(!reasons.includes('runtime_interrupted'), `task events: ${JSON.stringify(reasons)}`);
  assert.equal(shutdown.status, 'completed');
  assert.equal(shutdown.lifecycle?.mayHaveBeenSent, true);
  assert.deepEqual((waitStarted?.data as { mode: string }).mode, 'pause');
});

test('0028-S03 an interrupting close still marks the turn runtime_interrupted', async () => {
  const { running, queued } = await closeWith('interrupt');
  assert.deepEqual([running.status, running.reason], ['paused', 'runtime_interrupted']);
  assert.deepEqual([queued.status, queued.reason], ['paused', 'owner_shutdown']);
});

test('0028-S04 host.shutdown accepts the pause mode and still refuses unknown modes', async () => {
  const f = await setup();
  const engine = await createEngine(f.config);
  try {
    await assert.rejects(
      engine.call('host.shutdown', { mode: 'stop', timeoutMs: 1000 }, { owner: true }),
      { code: 'VALIDATION_ERROR' },
    );
    const hello = (await engine.call('initialize', {
      protocolVersion: '2.0',
      sdkVersion: 'test',
    })) as { capabilities: { workflow: Record<string, unknown> } };
    assert.equal(hello.capabilities.workflow.pauseClose, true);
    const closed = (await engine.call(
      'host.shutdown',
      { mode: 'pause', timeoutMs: 1000 },
      { owner: true },
    )) as { status: string };
    assert.equal(closed.status, 'closed');
  } finally {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    await f.cleanup();
  }
});

test('0028-S02 a turn that a session pause is still interrupting keeps runtime_interrupted', async () => {
  const f = await setup();
  const base = createFakeAdapter({ delayMs: 60_000 });
  // The runtime answers an interrupt 200 ms late, so the close comes while the pause is in progress.
  const slow: RuntimeAdapter = {
    ...base,
    async *execute(input: RuntimeInput) {
      for await (const event of base.execute(input)) {
        if (event.type === 'interrupted') await new Promise((resolve) => setTimeout(resolve, 200));
        yield event;
      }
    },
  };
  const config = { ...f.config, adapters: [slow] };
  try {
    const engine = await createEngine(config);
    let taskId = '';
    try {
      const task = await create(engine, 'running turn');
      taskId = task.id;
      await wait(engine, task.id, 'running');
      const session = (await engine.call('sessions.get', {
        sessionId: task.sessionId,
      })) as SessionSnapshot;
      await engine.call('sessions.control', {
        target: {
          sessionId: session.id,
          expectedGeneration: session.generation,
          expectedRevision: session.revision,
          expectedDispatchId: session.activeDispatchId,
          expectedState: session.status,
        },
        command: { action: 'pause', mode: 'interrupt' },
        idempotencyKey: 'pause-session',
      });
      assert.equal(
        ((await engine.call('tasks.get', { taskId })) as TaskSnapshot).status,
        'running',
      );
      await engine.close({ mode: 'pause', timeoutMs: 5000 });
    } finally {
      await engine.close({ mode: 'interrupt', timeoutMs: 5000 }).catch(() => {});
    }
    const reopened = await createEngine(config);
    try {
      const after = (await reopened.call('tasks.get', { taskId })) as TaskSnapshot;
      assert.deepEqual([after.status, after.reason], ['paused', 'runtime_interrupted']);
    } finally {
      await reopened.close({ mode: 'interrupt', timeoutMs: 1000 });
    }
  } finally {
    await f.cleanup();
  }
});
