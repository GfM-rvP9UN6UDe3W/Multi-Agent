import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, createFakeAdapter, openReadOnlyEngine } from '../fixtures/engine.ts';
import type {
  Engine,
  EngineConfig,
  RuntimeAdapter,
  RuntimeInput,
  SessionSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';

// SPEC-0029 D: a task that a close paused says so, and whether its turn was running.

type Marked = TaskSnapshot & { pausedByClose?: { operationId: string; wasRunning: boolean } };

async function setup(adapter: RuntimeAdapter = createFakeAdapter({ delayMs: 60_000 })) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-close-markers-')));
  await mkdir(join(root, 'workspace'));
  const config: EngineConfig = {
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    // Each turn runs until it is interrupted, and one execution slot keeps the second task queued.
    adapters: [adapter],
    limits: { maxActiveSessions: 1 },
  };
  return { config, cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function create(engine: Engine, goal: string) {
  return (await engine.call('tasks.create', {
    spec: {
      goal,
      runtime: { provider: 'fake', model: 'fixture' },
      acceptance: { mode: 'human', criteria: ['Review'] },
    },
    idempotencyKey: crypto.randomUUID(),
  })) as Marked;
}
const get = async (engine: Engine, id: string) =>
  (await engine.call('tasks.get', { taskId: id })) as Marked;
async function wait(engine: Engine, id: string, status: string) {
  for (let i = 0; i < 400; i++) {
    const task = await get(engine, id);
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${id} did not become ${status}`);
}

for (const mode of ['interrupt', 'pause'] as const)
  test(`0029-D01 a ${mode} close marks the interrupted turn as running and the queued task as queued`, async () => {
    const f = await setup();
    try {
      const engine = await createEngine(f.config);
      let running: Marked, queued: Marked, operationId: string;
      try {
        running = await create(engine, 'running turn');
        await wait(engine, running.id, 'running');
        queued = await create(engine, 'queued task');
        assert.equal((await get(engine, queued.id)).pausedByClose, undefined);
        operationId = (await engine.close({ mode, timeoutMs: 5000 })).operationId;
      } finally {
        await engine.close({ mode: 'interrupt', timeoutMs: 5000 }).catch(() => {});
      }
      const reopened = await createEngine(f.config);
      try {
        const turn = await get(reopened, running.id);
        const waiting = await get(reopened, queued.id);
        assert.equal(turn.status, 'paused');
        assert.equal(turn.reason, mode === 'pause' ? 'owner_shutdown' : 'runtime_interrupted');
        assert.deepEqual(turn.pausedByClose, { operationId, wasRunning: true });
        assert.deepEqual([waiting.status, waiting.reason], ['paused', 'owner_shutdown']);
        assert.deepEqual(waiting.pausedByClose, { operationId, wasRunning: false });

        // D03: the mark leaves with the pause.
        await reopened.call('tasks.resume', { taskId: running.id, idempotencyKey: 'resume' });
        const resumed = await get(reopened, running.id);
        assert.notEqual(resumed.status, 'paused');
        assert.equal(resumed.pausedByClose, undefined);
        await reopened.call('tasks.cancel', { taskId: queued.id, idempotencyKey: 'cancel' });
        const cancelled = await wait(reopened, queued.id, 'cancelled');
        assert.equal(cancelled.pausedByClose, undefined);
      } finally {
        await reopened.close({ mode: 'interrupt', timeoutMs: 1000 });
      }
    } finally {
      await f.cleanup();
    }
  });

test('0029-D01 a drain close marks the queued tasks it pauses', async () => {
  const f = await setup(createFakeAdapter({ delayMs: 50 }));
  try {
    const engine = await createEngine(f.config);
    let running: Marked, queued: Marked, operationId: string;
    try {
      running = await create(engine, 'short turn');
      await wait(engine, running.id, 'running');
      queued = await create(engine, 'queued task');
      operationId = (await engine.close({ mode: 'drain', timeoutMs: 5000 })).operationId;
    } finally {
      await engine.close({ mode: 'interrupt', timeoutMs: 5000 }).catch(() => {});
    }
    const reader = await openReadOnlyEngine({ stateDir: f.config.stateDir });
    try {
      const turn = (await reader.call('tasks.get', { taskId: running.id })) as Marked;
      const waiting = (await reader.call('tasks.get', { taskId: queued.id })) as Marked;
      assert.equal(turn.status, 'waiting_approval', 'the drained turn delivered');
      assert.equal(turn.pausedByClose, undefined);
      assert.deepEqual(waiting.pausedByClose, { operationId, wasRunning: false });
    } finally {
      await reader.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('0029-D02 a turn that a session pause is interrupting is not marked by the close', async () => {
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
  const f = await setup(slow);
  try {
    const engine = await createEngine(f.config);
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
      await engine.close({ mode: 'pause', timeoutMs: 5000 });
    } finally {
      await engine.close({ mode: 'interrupt', timeoutMs: 5000 }).catch(() => {});
    }
    const reopened = await createEngine(f.config);
    try {
      const after = await get(reopened, taskId);
      assert.deepEqual([after.status, after.reason], ['paused', 'runtime_interrupted']);
      assert.equal(after.pausedByClose, undefined);
    } finally {
      await reopened.close({ mode: 'interrupt', timeoutMs: 1000 });
    }
  } finally {
    await f.cleanup();
  }
});
