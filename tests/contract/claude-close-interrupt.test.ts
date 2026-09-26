import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createClaudeAdapter,
  type ClaudeAdapterConfig,
  type ClaudeQueryRequest,
} from '../../packages/adapter-claude/src/index.ts';
import { createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';
import { claudeProcess } from '../fixtures/claude-process.ts';

// SPEC-0022 C: close({mode:'interrupt'}) with the Claude adapter. The host extends the native
// options, so the adapter needs the host's stop proof, as in the downstream report.

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() >= end) throw new Error('Fixture condition timed out');
    await delay(5);
  }
}

/**
 * An offline Claude whose turn runs until it is interrupted. By default it then reports a structured
 * abort; with `answers: false` it never answers the interrupt.
 */
function interruptibleClaude({ answers = true } = {}) {
  const state = { queries: 0, interrupts: 0, observed: 0, turnStarted: false };
  const config: ClaudeAdapterConfig = {
    extendOptions: () => ({}),
    observeExecutionStop: async () => {
      state.observed++;
      return true;
    },
    cleanupTimeoutMs: 2000,
    query: (request: ClaudeQueryRequest) => {
      state.queries++;
      const child = claudeProcess(request);
      const queue: IteratorResult<unknown>[] = [];
      let waiting: ((step: IteratorResult<unknown>) => void) | undefined;
      const push = (step: IteratorResult<unknown>) => {
        if (waiting) {
          const resolve = waiting;
          waiting = undefined;
          resolve(step);
        } else queue.push(step);
      };
      void (async () => {
        const prompt = (request.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        await prompt.next();
        push({ done: false, value: { type: 'system', subtype: 'init', session_id: 'native' } });
        push({
          done: false,
          value: {
            type: 'stream_event',
            session_id: 'native',
            parent_tool_use_id: null,
            event: { type: 'message_start' },
          },
        });
        state.turnStarted = true;
      })();
      return {
        interrupt() {
          state.interrupts++;
          if (!answers) return new Promise<void>(() => {});
          push({
            done: false,
            value: {
              type: 'result',
              session_id: 'native',
              subtype: 'error_during_execution',
              is_error: true,
              terminal_reason: 'aborted_streaming',
              errors: ['interrupted'],
              usage: { input_tokens: 3, output_tokens: 2 },
            },
          });
          push({ done: true, value: undefined });
          return Promise.resolve({ still_queued: [] });
        },
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              queue.length
                ? Promise.resolve(queue.shift()!)
                : new Promise<IteratorResult<unknown>>((resolve) => {
                    waiting = resolve;
                  }),
            return: async () => ({ done: true as const, value: undefined }),
          };
        },
        close() {
          child.stdin.end();
        },
      };
    },
  } as ClaudeAdapterConfig;
  return { state, config };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-close-interrupt-')));
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  await mkdir(workspace);
  await mkdir(stateDir, { mode: 0o700 });
  /** `onAdapterClose` runs when the engine starts to close the Claude adapter. */
  const open = (config: ClaudeAdapterConfig, interruptMs?: number, onAdapterClose?: () => void) => {
    const adapter = createClaudeAdapter(config);
    const close = adapter.close!;
    if (onAdapterClose)
      adapter.close = () => {
        onAdapterClose();
        return close();
      };
    return createOrchestrator({
      workspace,
      stateDir,
      adapters: [adapter],
      providers: { claude: { model: 'offline' } },
      storage: { emergencyBytes: 4096 },
      ...(interruptMs ? { timeouts: { interruptMs } } : {}),
    });
  };
  return { root, open };
}

async function startTurn(
  orch: Awaited<ReturnType<typeof createOrchestrator>>,
  turn: { turnStarted: boolean },
) {
  const task = await orch.tasks.create({
    goal: 'Keep editing until interrupted.',
    runtime: { provider: 'claude', model: 'offline' },
    acceptance: { mode: 'human', criteria: ['A reviewer read the answer'] },
  });
  await until(async () => turn.turnStarted && (await orch.tasks.get(task.id)).status === 'running');
  // Let the adapter observe the turn's first activity, which arms the deferred interrupt.
  await delay(50);
  return task;
}

test('0022-C01 close({mode:"interrupt"}) pauses a running Claude turn as runtime_interrupted with the host stop proof', async () => {
  const { root, open } = await fixture();
  try {
    const claude = interruptibleClaude();
    const orch = await open(claude.config);
    const task = await startTurn(orch, claude.state);
    await orch.close({ mode: 'interrupt', timeoutMs: 10_000 });

    const reopened = await open(interruptibleClaude().config);
    try {
      const after = await reopened.tasks.get(task.id);
      const session = await reopened.sessions.get(after.sessionId!);
      assert.equal(claude.state.interrupts, 1, 'the turn was interrupted once');
      assert.deepEqual(
        {
          status: after.status,
          reason: after.reason,
          observed: claude.state.observed > 0,
          session: session.status,
          quarantined: session.execution?.quarantined ?? false,
        },
        {
          status: 'paused',
          reason: 'runtime_interrupted',
          observed: true,
          session: 'paused',
          quarantined: false,
        },
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('0022-C04 pausing the session with mode interrupt, then a drain close, pauses the turn with the host stop proof', async () => {
  const { root, open } = await fixture();
  try {
    const claude = interruptibleClaude();
    const orch = await open(claude.config);
    const task = await startTurn(orch, claude.state);
    const running = await orch.tasks.get(task.id);
    const session = await orch.sessions.get(running.sessionId!);
    const pause = await orch.sessions.control(
      {
        sessionId: session.id,
        expectedGeneration: session.generation,
        expectedRevision: session.revision,
        expectedDispatchId: session.activeDispatchId,
        expectedState: session.status,
      },
      { action: 'pause', mode: 'interrupt' },
    );
    const paused = await pause.wait({ timeoutMs: 10_000 });
    const after = await orch.tasks.get(task.id);
    await orch.close({ mode: 'drain', timeoutMs: 10_000 });
    assert.equal(paused.status, 'completed');
    assert.equal(claude.state.interrupts, 1);
    assert.deepEqual(
      { status: after.status, reason: after.reason, observed: claude.state.observed > 0 },
      { status: 'paused', reason: 'runtime_interrupted', observed: true },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** While `run` runs, closing a SQLite database takes `ms` longer, as on a loaded CI disk. */
async function withSlowDatabaseClose<T>(ms: number, run: () => Promise<T>): Promise<T> {
  const close = DatabaseSync.prototype.close;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  DatabaseSync.prototype.close = function (this: DatabaseSync) {
    close.call(this);
    Atomics.wait(pause, 0, 0, ms);
  };
  try {
    return await run();
  } finally {
    DatabaseSync.prototype.close = close;
  }
}

/**
 * Closes with mode interrupt, or `mode`, while a turn ignores the interrupt. Returns the time of the
 * whole close, the time until the engine started to close the adapters, which ends the wait of
 * SPEC-0022 C02, and the task.
 */
async function closeUnanswered(
  timeoutMs: number,
  interruptMs?: number,
  slowDatabaseCloseMs = 0,
  mode: 'interrupt' | 'pause' = 'interrupt',
) {
  const { root, open } = await fixture();
  try {
    const claude = interruptibleClaude({ answers: false });
    let adapterCloseAt: number | undefined;
    const orch = await open(claude.config, interruptMs, () => {
      adapterCloseAt ??= performance.now();
    });
    const task = await startTurn(orch, claude.state);
    const begin = performance.now();
    const close = () => orch.close({ mode, timeoutMs });
    try {
      await (slowDatabaseCloseMs ? withSlowDatabaseClose(slowDatabaseCloseMs, close) : close());
    } catch (error) {
      await orch.close({ mode: 'interrupt', timeoutMs }).catch(() => {});
      throw error;
    }
    const elapsed = performance.now() - begin;
    assert.ok(adapterCloseAt !== undefined, 'the engine closed the adapter');
    const reopened = await open(interruptibleClaude().config);
    try {
      return {
        elapsed,
        waited: adapterCloseAt - begin,
        interrupts: claude.state.interrupts,
        task: await reopened.tasks.get(task.id),
      };
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('0022-C02 0022-C03 the close waits up to timeouts.interruptMs, then closes the adapters', async () => {
  const { elapsed, interrupts, task } = await closeUnanswered(10_000, 300);
  assert.equal(interrupts, 1);
  assert.ok(elapsed >= 290, `closed after ${elapsed} ms, before the 300 ms wait ended`);
  assert.ok(elapsed < 5_000, `closed after ${elapsed} ms`);
  // A turn that did not answer keeps the conservative outcome.
  assert.equal(task.status, 'blocked');
  assert.match(task.reason ?? '', /^outcome_unknown/);
});

// The budget bounds the wait, not the synchronous writes around it, such as the final database
// close (SPEC-0023 F03), so these tests time the wait: until the engine starts to close the adapters.
test('0022-C02 the close waits at most half of its timeoutMs', async () => {
  const { waited } = await closeUnanswered(1_000);
  assert.ok(waited >= 490, `closed the adapters after ${waited} ms, before half of the budget`);
  assert.ok(waited < 1_000, `closed the adapters after ${waited} ms`);
});

test('0022-C02 a slow database close does not count against the half-budget wait', async () => {
  const { elapsed, waited } = await closeUnanswered(1_000, undefined, 600);
  assert.ok(elapsed >= 1_100, `the database close was not slowed: closed after ${elapsed} ms`);
  assert.ok(waited >= 490, `closed the adapters after ${waited} ms, before half of the budget`);
  assert.ok(waited < 1_000, `closed the adapters after ${waited} ms`);
});

// SPEC-0028 S: a pausing close interrupts as mode interrupt does, and pauses what it interrupted as
// owner_shutdown.
test('0028-S01 close({mode:"pause"}) pauses a running Claude turn as owner_shutdown with the host stop proof', async () => {
  const { root, open } = await fixture();
  try {
    const claude = interruptibleClaude();
    const orch = await open(claude.config);
    const task = await startTurn(orch, claude.state);
    try {
      await orch.close({ mode: 'pause', timeoutMs: 10_000 });
    } finally {
      await orch.close({ mode: 'interrupt', timeoutMs: 10_000 }).catch(() => {});
    }

    const reopened = await open(interruptibleClaude().config);
    try {
      const after = await reopened.tasks.get(task.id);
      const session = await reopened.sessions.get(after.sessionId!);
      assert.equal(claude.state.interrupts, 1, 'the turn was interrupted once');
      assert.deepEqual(
        {
          status: after.status,
          reason: after.reason,
          observed: claude.state.observed > 0,
          session: session.status,
          quarantined: session.execution?.quarantined ?? false,
        },
        {
          status: 'paused',
          reason: 'owner_shutdown',
          observed: true,
          session: 'paused',
          quarantined: false,
        },
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('0028-S02 a turn that does not answer a pausing close keeps outcome_unknown', async () => {
  const { interrupts, task } = await closeUnanswered(10_000, 300, 0, 'pause');
  assert.equal(interrupts, 1);
  assert.equal(task.status, 'blocked');
  assert.match(task.reason ?? '', /^outcome_unknown/);
});

test('0028-S02 a turn that a session pause interrupted first keeps runtime_interrupted', async () => {
  const { root, open } = await fixture();
  try {
    const claude = interruptibleClaude();
    const orch = await open(claude.config);
    const task = await startTurn(orch, claude.state);
    const running = await orch.tasks.get(task.id);
    const session = await orch.sessions.get(running.sessionId!);
    const pause = await orch.sessions.control(
      {
        sessionId: session.id,
        expectedGeneration: session.generation,
        expectedRevision: session.revision,
        expectedDispatchId: session.activeDispatchId,
        expectedState: session.status,
      },
      { action: 'pause', mode: 'interrupt' },
    );
    await pause.wait({ timeoutMs: 10_000 });
    try {
      await orch.close({ mode: 'pause', timeoutMs: 10_000 });
    } finally {
      await orch.close({ mode: 'interrupt', timeoutMs: 10_000 }).catch(() => {});
    }
    const reopened = await open(interruptibleClaude().config);
    try {
      const after = await reopened.tasks.get(task.id);
      assert.deepEqual([after.status, after.reason], ['paused', 'runtime_interrupted']);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
