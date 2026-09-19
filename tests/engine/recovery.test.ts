import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngine, createFakeAdapter } from '../../packages/engine/src/index.ts';
import type { TaskSnapshot, RuntimeAdapter, EventPage } from '../../packages/engine/src/types.ts';

test('AC08 SIGKILL releases owner lock but cannot replay an uncertain dispatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-crash-'));
  const workspace = join(dir, 'workspace'),
    stateDir = join(dir, 'state');
  await mkdir(workspace);
  const child = spawn(process.execPath, ['tests/fixtures/crash-owner.ts', workspace, stateDir], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  let calls = 0;
  try {
    const ready = await new Promise<{
      running: TaskSnapshot;
      queued: TaskSnapshot;
      storeId: string;
    }>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Crash fixture startup timed out')), 3000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (output.includes('\n')) {
          clearTimeout(timer);
          resolve(JSON.parse(output.split('\n')[0]));
        }
      });
    });
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const base = createFakeAdapter();
    const adapter: RuntimeAdapter = {
      ...base,
      async *execute(input) {
        calls++;
        yield* base.execute(input);
      },
    };
    const engine = await createEngine({ workspace, stateDir, adapters: [adapter] });
    try {
      assert.equal(engine.storeId, ready.storeId);
      const running = (await engine.call('tasks.get', {
        taskId: ready.running.id,
      })) as TaskSnapshot;
      const queued = (await engine.call('tasks.get', { taskId: ready.queued.id })) as TaskSnapshot;
      assert.equal(running.status, 'blocked');
      assert.match(running.reason!, /outcome_unknown/);
      assert.equal(queued.status, 'paused');
      assert.equal(calls, 0);
      await assert.rejects(
        engine.call('tasks.resume', { taskId: running.id, idempotencyKey: 'unsafe-retry' }),
        { code: 'OUTCOME_UNKNOWN' },
      );
      const page = (await engine.call('events.read', { taskId: running.id })) as EventPage;
      assert.ok(page.events.some((e) => e.type === 'dispatch.started'));
      assert.ok(page.events.some((e) => e.type === 'task.blocked'));
      await engine.call('tasks.resume', { taskId: queued.id, idempotencyKey: 'safe-resume' });
      const end = Date.now() + 1000;
      while (
        ((await engine.call('tasks.get', { taskId: queued.id })) as TaskSnapshot).status !==
          'waiting_approval' &&
        Date.now() < end
      )
        await new Promise((r) => setTimeout(r, 5));
      assert.equal(
        ((await engine.call('tasks.get', { taskId: queued.id })) as TaskSnapshot).status,
        'waiting_approval',
      );
      assert.equal(calls, 1);
    } finally {
      await engine.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
