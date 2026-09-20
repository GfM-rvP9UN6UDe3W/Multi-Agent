import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  createClaudeAdapter,
  type ClaudeAdapterConfig,
  type ClaudeQueryRequest,
} from '../../packages/adapter-claude/src/index.ts';
import type {
  ExecutionEvidence,
  RuntimeEvent,
  RuntimeInput,
} from '../../packages/engine/src/types.ts';
import { claudeProcess, stubbornClaudeProcess } from '../fixtures/claude-process.ts';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 500): Promise<void> {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() >= end) throw new Error('Fixture condition timed out');
    await delay(2);
  }
}
function setup(
  t: TestContext,
  settings: {
    interrupt?: 'reject' | 'hang' | 'missing';
    holdChild?: boolean;
    beforeActivity?: boolean;
    options?: Record<string, unknown>;
    observeExecutionStop?: ClaudeAdapterConfig['observeExecutionStop'];
    interruptTimeoutMs?: number;
  } = {},
) {
  const control = new AbortController();
  const events: RuntimeEvent[] = [],
    evidence: ExecutionEvidence[] = [],
    usage: RuntimeEvent[] = [];
  let request!: ClaudeQueryRequest;
  let interrupts = 0,
    inputClosed = false,
    settled = false;
  let message: unknown;
  let second: Promise<unknown> | undefined;
  let child: ReturnType<typeof claudeProcess> | undefined;
  const queue: IteratorResult<unknown>[] = [];
  let waiting: ((step: IteratorResult<unknown>) => void) | undefined;
  const push = (value: unknown) => {
    const step = { done: false as const, value };
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(step);
    } else queue.push(step);
  };
  const activity = () =>
    push({
      type: 'stream_event',
      session_id: 'native',
      parent_tool_use_id: null,
      event: { type: 'message_start' },
    });
  const adapter = createClaudeAdapter({
    requestTimeoutMs: 1000,
    turnTimeoutMs: 2000,
    // Classification tests use the normal cleanup allowance. Only the held-child case
    // intentionally exercises incomplete cleanup with a short budget.
    cleanupTimeoutMs: settings.holdChild ? 40 : 1000,
    interruptTimeoutMs: settings.interruptTimeoutMs ?? 250,
    options: settings.options,
    observeExecutionStop: settings.observeExecutionStop,
    query: (value: ClaudeQueryRequest) => {
      request = value;
      const held = settings.holdChild ? stubbornClaudeProcess(value) : undefined;
      child = held?.child ?? claudeProcess(value);
      void (async () => {
        await held?.ready;
        if (typeof value.prompt !== 'string') {
          const iterator = (value.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
          message = (await iterator.next()).value;
          second = iterator.next().then((step) => {
            inputClosed = step.done === true;
            return step;
          });
        }
        push({ type: 'system', subtype: 'init', session_id: 'native' });
        if (!settings.beforeActivity) activity();
      })();
      return {
        ...(settings.interrupt === 'missing'
          ? {}
          : {
              interrupt() {
                interrupts++;
                if (settings.interrupt === 'reject')
                  return Promise.reject(new Error('PRIVATE_INTERRUPT_ERROR'));
                if (settings.interrupt === 'hang') return new Promise<void>(() => {});
                return Promise.resolve({ still_queued: [] });
              },
            }),
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
          if (!settings.holdChild) child?.stdin.end();
        },
      };
    },
  } as ClaudeAdapterConfig);
  const input: RuntimeInput = {
    taskId: 'task',
    sessionId: 'session',
    dispatchId: 'dispatch',
    generation: 2,
    providerSessionId: 'native',
    model: 'offline',
    workspace: process.cwd(),
    stateDir: '/tmp/claude-interruption-state',
    prompt: 'One controlled prompt',
    permissionProfile: 'read-only',
    signal: control.signal,
    reportExecutionEvidence: (value) => evidence.push(value),
    reportUsage: (value) => usage.push(value),
  };
  const done = (async () => {
    for await (const event of adapter.execute(input)) events.push(event);
    settled = true;
  })();
  t.after(async () => {
    push(result());
    child?.kill('SIGKILL');
    await adapter.close().catch(() => {});
    await done;
  });
  return {
    adapter,
    input,
    control,
    events,
    evidence,
    usage,
    push,
    activity,
    done,
    get request() {
      return request;
    },
    get interrupts() {
      return interrupts;
    },
    get settled() {
      return settled;
    },
    get inputClosed() {
      return inputClosed;
    },
    get message() {
      return message;
    },
    get second() {
      return second;
    },
  };
}
function result(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    session_id: 'native',
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: 'aborted_streaming',
    errors: ['interrupted'],
    usage: { input_tokens: 3, output_tokens: 2 },
    ...overrides,
  };
}

test('AC-I01 Claude owns one open streaming prompt and advertises interruption', async (t) => {
  const s = setup(t);
  await until(() => s.events.some((e) => e.type === 'accepted'));
  assert.equal(s.adapter.capabilities().interrupt, true);
  assert.equal(typeof s.request.prompt, 'object');
  assert.equal(
    (s.request.options as unknown as Record<string, unknown>).includePartialMessages,
    true,
  );
  assert.equal(s.request.options.resume, 'native');
  assert.deepEqual((s.message as { message: unknown }).message, {
    role: 'user',
    content: s.input.prompt,
  });
  assert.match((s.message as { uuid: string }).uuid, /^[0-9a-f-]{36}$/);
  assert.equal(s.inputClosed, false);
  s.push(
    result({ subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'done' }),
  );
  await s.done;
  await s.second;
  assert.equal(s.inputClosed, true);
});

test('AC-I01 partial-message observation cannot be overridden and interrupt budget is validated', () => {
  assert.throws(
    () =>
      createClaudeAdapter({
        options: { includePartialMessages: false },
      } as unknown as ClaudeAdapterConfig),
    { code: 'INVALID_ADAPTER_CONFIG' },
  );
  for (const value of [0, -1, NaN, Infinity, 1.5])
    assert.throws(
      () => createClaudeAdapter({ interruptTimeoutMs: value } as ClaudeAdapterConfig),
      /interruptTimeoutMs/,
    );
});

for (const beforeActivity of [false, true])
  test(`AC-I02 interrupt request waits for turn activity and then terminal (startup=${beforeActivity})`, async (t) => {
    const s = setup(t, { beforeActivity });
    await until(() => s.events.some((e) => e.type === 'accepted'));
    s.control.abort();
    if (beforeActivity) {
      await delay(10);
      assert.equal(s.interrupts, 0);
      s.push({ type: 'assistant', session_id: 'native', parent_tool_use_id: 'subagent' });
      await delay(5);
      assert.equal(s.interrupts, 0);
      s.activity();
    }
    await until(() => s.interrupts === 1);
    assert.equal(s.request.options.abortController.signal.aborted, false);
    assert.equal(s.settled, false);
    assert.equal(s.inputClosed, false);
    s.push(result());
    await s.done;
    assert.equal(s.interrupts, 1);
    assert.equal(s.events.at(-1)?.type, 'interrupted');
    assert.equal(s.usage.length, 1);
    assert.equal(s.evidence.at(-1)?.localResources, 'stopped');
  });

for (const reason of ['aborted_tools', 'completed', 'api_error', undefined])
  test(`AC-I02 structured terminal classification preserves ${reason ?? 'missing reason'}`, async (t) => {
    const s = setup(t);
    await until(() => s.events.some((e) => e.type === 'accepted'));
    s.control.abort();
    await until(() => s.interrupts === 1);
    s.push(
      result(
        reason === 'completed'
          ? {
              subtype: 'success',
              is_error: false,
              terminal_reason: reason,
              result: 'natural completion',
            }
          : { terminal_reason: reason },
      ),
    );
    await s.done;
    assert.equal(
      s.events.at(-1)?.type,
      reason === 'aborted_tools' ? 'interrupted' : reason === 'completed' ? 'result' : 'error',
    );
    if (s.events.at(-1)?.type === 'error')
      assert.equal((s.events.at(-1) as { outcome: string }).outcome, 'failed');
  });

for (const interrupt of ['hang', 'reject', 'missing'] as const)
  test(`AC-I03 ${interrupt} interrupt without terminal is bounded and unknown`, async (t) => {
    const s = setup(t, { interrupt, interruptTimeoutMs: 30 });
    await until(() => s.events.some((e) => e.type === 'accepted'));
    const start = performance.now();
    s.control.abort();
    await s.done;
    assert.ok(performance.now() - start < 500);
    assert.equal((s.events.at(-1) as { outcome: string }).outcome, 'unknown');
    assert.equal(
      s.events.some((e) => e.type === 'interrupted'),
      false,
    );
    assert.equal(
      s.evidence.some((e) => e.remoteExecution === 'stopped'),
      false,
    );
    assert.equal(s.interrupts, interrupt === 'missing' ? 0 : 1);
  });

for (const interrupt of ['reject', 'hang'] as const)
  test(`AC-I03 ${interrupt} acknowledgement does not discard an independently matched abort terminal`, async (t) => {
    const s = setup(t, { interrupt });
    await until(() => s.events.some((e) => e.type === 'accepted'));
    s.control.abort();
    await until(() => s.interrupts === 1);
    s.push(result());
    await s.done;
    assert.equal(s.events.at(-1)?.type, 'interrupted');
  });

test('AC-I02 cancellation before init waits for activity without aborting the native controller', async (t) => {
  const s = setup(t);
  assert.equal(s.events.length, 0);
  s.control.abort();
  await until(() => s.interrupts === 1);
  assert.equal(s.request.options.abortController.signal.aborted, false);
  s.push(result());
  await s.done;
  assert.equal(s.events.at(-1)?.type, 'interrupted');
});

test('AC-I03 startup without activity cannot send a blind interrupt and has a bounded deadline', async (t) => {
  const s = setup(t, { beforeActivity: true, interruptTimeoutMs: 25 });
  await until(() => s.events.some((e) => e.type === 'accepted'));
  s.control.abort();
  s.push({ type: 'stream_event', session_id: 'unrelated', event: { type: 'message_start' } });
  await s.done;
  assert.equal(s.interrupts, 0);
  assert.equal((s.events.at(-1) as { outcome: string }).outcome, 'unknown');
});

for (const observation of [false, true])
  test(`AC-I03 interrupted expanded execution requires independent host proof (${observation})`, async (t) => {
    const s = setup(t, {
      options: { systemPrompt: 'host policy' },
      observeExecutionStop: async (context) => {
        assert.equal(context.terminal.type, 'interrupted');
        assert.equal(context.target.dispatchId, 'dispatch');
        return observation;
      },
    });
    await until(() => s.events.some((e) => e.type === 'accepted'));
    s.control.abort();
    s.push(result());
    await s.done;
    assert.equal(s.evidence.at(-1)?.localResources, 'stopped');
    assert.equal(s.evidence.at(-1)?.remoteExecution, observation ? 'stopped' : 'unknown');
  });

test('AC-I03 wrong-session terminal cannot confirm interruption or usage', async (t) => {
  const s = setup(t);
  await until(() => s.events.some((e) => e.type === 'accepted'));
  s.control.abort();
  s.push(result({ session_id: 'other' }));
  await s.done;
  assert.equal((s.events.at(-1) as { outcome: string }).outcome, 'unknown');
  assert.equal(s.usage.length, 0);
});

test('AC-I03 local cleanup and expanded execution proof remain independent of interrupt', async (t) => {
  const s = setup(t, {
    holdChild: true,
    options: { systemPrompt: 'host' },
    observeExecutionStop: async () => true,
  });
  await until(() => s.events.some((e) => e.type === 'accepted'));
  s.control.abort();
  s.push(result());
  await s.done;
  assert.equal((s.events.at(-1) as { outcome: string }).outcome, 'unknown');
  assert.equal(s.adapter.hasActiveResources('session'), true);
  assert.equal(
    s.evidence.some((e) => e.localResources === 'stopped'),
    false,
  );
  assert.equal(s.usage.length, 1);
});

test('AC-I03 interrupt timeout retains a late terminal and its original usage identity', async (t) => {
  const s = setup(t, { interruptTimeoutMs: 25 });
  await until(() => s.events.some((e) => e.type === 'accepted'));
  s.control.abort();
  await s.done;
  assert.equal((s.events.at(-1) as { outcome: string }).outcome, 'unknown');
  s.push(result());
  await until(() => s.usage.length === 1);
  assert.equal(s.evidence.find((e) => e.terminal)?.terminal?.type, 'interrupted');
  assert.ok(s.evidence.every((e) => e.dispatchId === 'dispatch' && e.generation === 2));
});
