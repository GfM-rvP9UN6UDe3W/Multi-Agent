import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import { createEngine } from '../fixtures/engine.ts';
import type {
  ExecutionEvidence,
  RuntimeEvent,
  RuntimeInput,
  SchedulerSnapshot,
  SessionSnapshot,
  TaskSnapshot,
} from '../../packages/engine/src/types.ts';
import {
  claudeProcess,
  refuseGroupSignals,
  stubbornClaudeProcess,
} from '../fixtures/claude-process.ts';

function input(evidence: ExecutionEvidence[]): RuntimeInput {
  return {
    taskId: 'cleanup-task',
    sessionId: 'cleanup-session',
    dispatchId: 'cleanup-dispatch',
    providerSessionId: null,
    model: 'fixture',
    workspace: process.cwd(),
    stateDir: '/tmp/unused',
    prompt: 'offline fixture',
    permissionProfile: 'read-only',
    signal: new AbortController().signal,
    reportExecutionEvidence: (item) => evidence.push(item),
  };
}
async function collect(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const result: RuntimeEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

test('AC-R04 close and iterator completion keep a live child held until its observed exit', async (t) => {
  const evidence: ExecutionEvidence[] = [];
  let child!: ChildProcessWithoutNullStreams;
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 20,
    query: (request) => {
      const held = stubbornClaudeProcess(request);
      child = held.child;
      t.after(() => stop(child));
      return {
        close() {},
        async *[Symbol.asyncIterator]() {
          await held.ready;
          yield { type: 'result', subtype: 'success', session_id: 'native', result: 'done' };
        },
      };
    },
  });
  const events = await collect(adapter.execute(input(evidence)));
  assert.equal(child.exitCode, null);
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal(adapter.hasActiveResources('cleanup-session'), true);
  assert.equal(
    evidence.some((item) => item.localResources === 'stopped'),
    false,
  );
  await assert.rejects(adapter.close(), /cleanup.*unconfirmed/i);
  await stop(child);
  assert.equal(adapter.hasActiveResources('cleanup-session'), false);
  assert.equal(evidence.at(-1)?.localResources, 'stopped');
  assert.equal(evidence.at(-1)?.remoteExecution, 'stopped');
  await adapter.close();
});

test('AC-R04 missing process observation remains unknown even after close and return succeed', async () => {
  const evidence: ExecutionEvidence[] = [];
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 10,
    query: () => ({
      close() {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', session_id: 'native', result: 'done' };
      },
    }),
  });
  const events = await collect(adapter.execute(input(evidence)));
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal(adapter.hasActiveResources('cleanup-session'), true);
  assert.equal(
    evidence.some((item) => item.localResources === 'stopped'),
    false,
  );
  await assert.rejects(adapter.close(), /cleanup.*unconfirmed/i);
});

test('AC-R04 actual child exit without a matching terminal never proves remote stop', async (t) => {
  const evidence: ExecutionEvidence[] = [];
  let child!: ChildProcessWithoutNullStreams;
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 500,
    query: (request) => {
      child = claudeProcess(request);
      t.after(() => stop(child));
      return {
        close() {
          child.stdin.end();
        },
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'native' };
        },
      };
    },
  });
  const events = await collect(adapter.execute(input(evidence)));
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal(adapter.hasActiveResources('cleanup-session'), false);
  assert.equal(evidence.at(-1)?.localResources, 'stopped');
  assert.equal(evidence.at(-1)?.remoteExecution, 'unknown');
});

test('AC-R04 factory failure after spawning still cleans only its captured process', async (t) => {
  let child!: ChildProcessWithoutNullStreams;
  const evidence: ExecutionEvidence[] = [];
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 500,
    query: (request) => {
      child = claudeProcess(request);
      t.after(() => stop(child));
      throw new Error('SDK construction failed after launch');
    },
  });
  const events = await collect(adapter.execute(input(evidence)));
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal(adapter.hasActiveResources('cleanup-session'), false);
  assert.equal(child.signalCode, 'SIGTERM');
  assert.equal(evidence.at(-1)?.localResources, 'stopped');
  assert.equal(evidence.at(-1)?.remoteExecution, 'unknown');
  await adapter.close();
});

test('AC-R04 rejecting close and iterator return still require actual owned process exit', async (t) => {
  const evidence: ExecutionEvidence[] = [];
  let child!: ChildProcessWithoutNullStreams;
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 500,
    query: (request) => {
      child = claudeProcess(request);
      t.after(() => stop(child));
      return {
        async close() {
          throw new Error('close rejected');
        },
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return {
                done: false,
                value: { type: 'result', subtype: 'success', session_id: 'native', result: 'done' },
              };
            },
            async return(): Promise<IteratorResult<unknown>> {
              throw new Error('return rejected');
            },
          };
        },
      };
    },
  });
  const events = await collect(adapter.execute(input(evidence)));
  assert.equal(child.signalCode, 'SIGTERM');
  assert.equal(adapter.hasActiveResources('cleanup-session'), false);
  assert.equal(events.at(-1)?.type, 'result');
  assert.equal(evidence.at(-1)?.localResources, 'stopped');
  await adapter.close();
});

test('AC-R04 an owned spawn failure is observed without treating a later process error as exit', async (t) => {
  const evidence: ExecutionEvidence[] = [];
  let child!: ChildProcessWithoutNullStreams;
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 500,
    query: (request) => {
      child = request.options.spawnClaudeCodeProcess({
        command: '/definitely-missing/claude-test-fixture',
        args: [],
        env: {},
        signal: new AbortController().signal,
      });
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
          const [error] = await once(child, 'error');
          throw error;
        },
      };
    },
  });
  const events = await collect(adapter.execute(input(evidence)));
  assert.equal(events.at(-1)?.type, 'error');
  assert.equal(child.pid, undefined);
  assert.equal(adapter.hasActiveResources('cleanup-session'), false);
  assert.equal(evidence.at(-1)?.localResources, 'stopped');
  assert.equal(evidence.at(-1)?.remoteExecution, 'unknown');

  const live = createClaudeAdapter({
    cleanupTimeoutMs: 10,
    query: (request) => {
      const held = stubbornClaudeProcess(request);
      child = held.child;
      t.after(() => stop(child));
      return {
        close() {
          child.emit('error', new Error('error on a live process'));
        },
        async *[Symbol.asyncIterator]() {
          await held.ready;
          yield { type: 'result', subtype: 'success', session_id: 'native', result: 'done' };
        },
      };
    },
  });
  await collect(live.execute(input([])));
  assert.equal(live.hasActiveResources('cleanup-session'), true);
  await stop(child);
  await live.close();
});

test('AC-R04 cleanup seals a saved spawn callback against delayed process creation', async () => {
  let saved!: Parameters<typeof claudeProcess>[0];
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 10,
    query: (request) => {
      saved = request;
      return { close() {}, async *[Symbol.asyncIterator]() {} };
    },
  });
  await collect(adapter.execute(input([])));
  assert.throws(() => claudeProcess(saved), /spawn rejected/);
  assert.equal(adapter.hasActiveResources('cleanup-session'), true);
});

test('AC-R04 all observed child processes must exit before cleanup is confirmed', async (t) => {
  // The children outlive their cleanup only because the adapter may not signal their groups.
  refuseGroupSignals(t);
  const children: ChildProcessWithoutNullStreams[] = [];
  const evidence: ExecutionEvidence[] = [];
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 10,
    query: (request) => {
      const held = [stubbornClaudeProcess(request), stubbornClaudeProcess(request)];
      children.push(...held.map(({ child }) => child));
      t.after(() => Promise.all(children.map(stop)));
      return {
        close() {},
        async *[Symbol.asyncIterator]() {
          await Promise.all(held.map(({ ready }) => ready));
          yield { type: 'result', subtype: 'success', session_id: 'native', result: 'done' };
        },
      };
    },
  });
  await collect(adapter.execute(input(evidence)));
  await stop(children[0]!);
  assert.equal(adapter.hasActiveResources('cleanup-session'), true);
  assert.equal(
    evidence.some((item) => item.localResources === 'stopped'),
    false,
  );
  await stop(children[1]!);
  assert.equal(adapter.hasActiveResources('cleanup-session'), false);
  assert.equal(evidence.at(-1)?.localResources, 'stopped');
  await adapter.close();
});

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!(await check())) {
    assert.ok(performance.now() < deadline, 'fixture state did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('AC-R04 a live Claude child blocks owner release and queued dispatch until late exit', async (t) => {
  // The child outlives its cleanup only because the adapter may not signal its group.
  refuseGroupSignals(t);
  const dir = await mkdtemp(join(tmpdir(), 'claude-cleanup-engine-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace);
  const children: ChildProcessWithoutNullStreams[] = [];
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 20,
    query: (request) => {
      const held = children.length === 0 ? stubbornClaudeProcess(request) : undefined;
      const child = held?.child ?? claudeProcess(request);
      children.push(child);
      const index = children.length;
      return {
        close() {
          if (index > 1) child.stdin.end();
        },
        async *[Symbol.asyncIterator]() {
          await held?.ready;
          if (index > 1) await stop(child);
          yield {
            type: 'result',
            subtype: 'success',
            session_id: `native-${index}`,
            result: 'done',
          };
        },
      };
    },
  });
  const engine = await createEngine({
    workspace,
    stateDir: join(dir, 'state'),
    adapters: [adapter],
    limits: { maxActiveSessions: 1 },
  });
  const scheduler = () => engine.call('scheduler.get', {}) as Promise<SchedulerSnapshot>;
  const task = (taskId: string) => engine.call('tasks.get', { taskId }) as Promise<TaskSnapshot>;
  try {
    const spec = {
      goal: 'offline',
      runtime: { provider: 'claude', model: 'fixture' },
      acceptance: { mode: 'human', criteria: ['review'] },
    };
    const first = (await engine.call('tasks.create', {
      spec,
      idempotencyKey: 'first',
    })) as TaskSnapshot;
    const second = (await engine.call('tasks.create', {
      spec,
      idempotencyKey: 'second',
    })) as TaskSnapshot;
    await until(async () => (await task(first.id)).status === 'blocked');
    assert.equal(children.length, 1);
    assert.equal((await scheduler()).executionOccupied, 1);
    assert.equal((await task(second.id)).status, 'queued');
    const session = (await engine.call('sessions.get', {
      sessionId: first.sessionId,
    })) as SessionSnapshot;
    await assert.rejects(
      engine.call(
        'sessions.reconcile',
        {
          target: {
            sessionId: session.id,
            expectedGeneration: session.generation,
            expectedRevision: session.revision,
            expectedDispatchId: session.activeDispatchId,
            expectedState: session.status,
          },
          evidence: {
            source: 'owner_attestation',
            summary: 'Declared stopped by fixture owner',
            localResources: 'stopped',
            remoteExecution: 'stopped',
            sideEffects: 'unknown',
            outcome: 'unknown',
          },
          idempotencyKey: 'premature-release',
        },
        { owner: true },
      ),
      { code: 'RUNTIME_STILL_ACTIVE' },
    );
    await stop(children[0]!);
    await until(async () => children.length === 2 && (await scheduler()).executionOccupied === 0);
    assert.equal((await scheduler()).quarantined, 1);
    assert.equal((await task(first.id)).status, 'blocked');
    assert.equal((await task(second.id)).status, 'waiting_approval');
  } finally {
    await Promise.all(children.map(stop));
    await engine.close({ timeoutMs: 500 });
    await rm(dir, { recursive: true, force: true });
  }
});
