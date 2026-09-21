import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import type { RuntimeEvent, RuntimeInput } from '../../packages/engine/src/types.ts';

function input(signal = new AbortController().signal): RuntimeInput {
  return {
    taskId: 'task-deadline',
    sessionId: 'session-deadline',
    dispatchId: 'dispatch-deadline',
    providerSessionId: null,
    model: 'fixture',
    workspace: process.cwd(),
    stateDir: '/tmp/claude-deadline-fixture',
    prompt: 'Read only',
    permissionProfile: 'read-only',
    signal,
  };
}

async function within<T>(promise: Promise<T>, ms = 300): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('test timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test('Claude acceptance deadline bounds a never-settling first next and aborts SDK query', async () => {
  let requestController: AbortController | undefined;
  let returned = false;
  const adapter = createClaudeAdapter({
    requestTimeoutMs: 30,
    cleanupTimeoutMs: 20,
    query: (request) => {
      requestController = request.options.abortController;
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<unknown>>(() => {}),
            return: async () => {
              returned = true;
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  });
  const events = await within(collect(adapter.execute(input())));
  assert.equal(events.length, 1);
  assert.equal((events[0] as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.match(
    (events[0] as Extract<RuntimeEvent, { type: 'error' }>).message,
    /acceptance.*timed out/i,
  );
  assert.equal(requestController?.signal.aborted, true);
  assert.equal(returned, true);
  await assert.rejects(adapter.close(), /cleanup.*unconfirmed/i);
});

test('Claude terminal deadline is absolute after acceptance and never invents interruption', async () => {
  let calls = 0;
  const adapter = createClaudeAdapter({
    requestTimeoutMs: 100,
    turnTimeoutMs: 35,
    cleanupTimeoutMs: 20,
    query: () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            calls++;
            if (calls === 1)
              return {
                done: false,
                value: { type: 'system', subtype: 'init', session_id: 'claude-deadline' },
              };
            return new Promise<IteratorResult<unknown>>(() => {});
          },
          async return() {
            return { done: true, value: undefined };
          },
        };
      },
    }),
  });
  const events = await within(collect(adapter.execute(input())));
  assert.deepEqual(events.slice(0, 1), [
    { type: 'accepted', providerSessionId: 'claude-deadline' },
  ]);
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.match(
    (events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).message,
    /terminal.*timed out/i,
  );
  assert.equal(
    events.some((event) => event.type === 'interrupted'),
    false,
  );
});

test('Claude terminal deadline is not extended by unrelated stream messages', async () => {
  let calls = 0;
  const adapter = createClaudeAdapter({
    requestTimeoutMs: 100,
    turnTimeoutMs: 35,
    cleanupTimeoutMs: 20,
    query: () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            calls++;
            if (calls === 1)
              return {
                done: false,
                value: { type: 'system', subtype: 'init', session_id: 'chatty' },
              };
            await new Promise((resolve) => setTimeout(resolve, 2));
            return { done: false, value: { type: 'assistant', session_id: 'chatty' } };
          },
          async return() {
            return { done: true, value: undefined };
          },
        };
      },
    }),
  });
  const events = await within(collect(adapter.execute(input())));
  assert.equal(events[0]?.type, 'accepted');
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.match(
    (events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).message,
    /terminal.*timed out/i,
  );
});

test('Claude cleanup timeout stays bounded and adapter.close rejects unconfirmed resource', async () => {
  const adapter = createClaudeAdapter({
    requestTimeoutMs: 20,
    cleanupTimeoutMs: 25,
    query: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<unknown>>(() => {}),
          return: () => new Promise<IteratorResult<unknown>>(() => {}),
        };
      },
    }),
  });
  const events = await within(collect(adapter.execute(input())));
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  await assert.rejects(within(adapter.close!()), /cleanup.*unconfirmed/i);
});

test('Claude late iterator return without process observation keeps cleanup unconfirmed', async () => {
  let finishReturn!: () => void;
  const returned = new Promise<IteratorResult<unknown>>((resolve) => {
    finishReturn = () => resolve({ done: true, value: undefined });
  });
  const adapter = createClaudeAdapter({
    requestTimeoutMs: 20,
    cleanupTimeoutMs: 20,
    query: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<unknown>>(() => {}),
          return: () => returned,
        };
      },
    }),
  });
  const events = await within(collect(adapter.execute(input())));
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  const resources = adapter as typeof adapter & {
    hasActiveResources?: (sessionId: string) => boolean;
  };
  assert.equal(resources.hasActiveResources?.('session-deadline'), true);
  assert.equal(resources.hasActiveResources?.('another-session'), false);
  await assert.rejects(adapter.close!(), /cleanup.*unconfirmed/i);
  finishReturn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(resources.hasActiveResources?.('session-deadline'), true);
  await assert.rejects(adapter.close(), /cleanup.*unconfirmed/i);
});

test('Claude iterator.return done:false does not release the active resource lease', async () => {
  const adapter = createClaudeAdapter({
    requestTimeoutMs: 20,
    cleanupTimeoutMs: 20,
    query: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<unknown>>(() => {}),
          return: async () => ({ done: false, value: 'still-active' }),
        };
      },
    }),
  });
  const events = await within(collect(adapter.execute(input())));
  const resources = adapter as typeof adapter & {
    hasActiveResources?: (sessionId: string) => boolean;
  };
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.equal(resources.hasActiveResources?.('session-deadline'), true);
  await assert.rejects(adapter.close!(), /cleanup.*unconfirmed/i);
});

test('Claude suppresses a successful result when local cleanup is unconfirmed', async () => {
  let first = true;
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 20,
    query: () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (!first) return { done: true, value: undefined };
            first = false;
            return {
              done: false,
              value: {
                type: 'result',
                subtype: 'success',
                session_id: 'upstream-done',
                result: 'done',
              },
            };
          },
          return: () => new Promise<IteratorResult<unknown>>(() => {}),
        };
      },
    }),
  });
  const events = await within(collect(adapter.execute(input())));
  assert.equal(events[0]?.type, 'accepted');
  assert.equal(
    events.some((event) => event.type === 'result'),
    false,
  );
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  await assert.rejects(adapter.close!(), /cleanup.*unconfirmed/i);
});

test('Claude Query.close cannot confirm cleanup while process observation is missing', async () => {
  let closed = false;
  const adapter = createClaudeAdapter({
    requestTimeoutMs: 20,
    cleanupTimeoutMs: 25,
    query: () => ({
      close() {
        closed = true;
      },
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<unknown>>(() => {}),
          return: () => new Promise<IteratorResult<unknown>>(() => {}),
        };
      },
    }),
  });
  const events = await within(collect(adapter.execute(input())));
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.equal(closed, true);
  await assert.rejects(adapter.close(), /cleanup.*unconfirmed/i);
});

test('Claude observes a late next rejection after timeout', async () => {
  let rejectLate!: (error: Error) => void;
  const late = new Promise<IteratorResult<unknown>>((_, reject) => {
    rejectLate = reject;
  });
  const adapter = createClaudeAdapter({
    requestTimeoutMs: 20,
    cleanupTimeoutMs: 20,
    query: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => late,
          return: async () => ({ done: true, value: undefined }),
        };
      },
    }),
  });
  const events = await within(collect(adapter.execute(input())));
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  rejectLate(new Error('late SDK rejection'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(adapter.close(), /cleanup.*unconfirmed/i);
});

test('Claude observes next rejection when cancellation wins before wait registration', async () => {
  let closeCalled = false;
  const adapter = createClaudeAdapter({
    requestTimeoutMs: 30,
    cleanupTimeoutMs: 20,
    query: (request) => {
      request.options.abortController.abort();
      return {
        close() {
          closeCalled = true;
        },
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              throw new Error('late next rejection');
            },
            async return() {
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  });
  const events = await within(collect(adapter.execute(input())));
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.equal(closeCalled, true);
  await new Promise((resolve) => setTimeout(resolve, 10)); // Node's test runner flags an unhandled rejection.
});

test('Claude observes next rejection when acceptance deadline expired before wait registration', async () => {
  let closeCalled = false;
  let submitted = false;
  let acceptanceChecks = 0;
  const executionBudget: RuntimeInput['executionBudget'] = {
    policyVersion: 2,
    enteredAt: '1970-01-01T00:00:00.000Z',
    acceptanceDeadlineAt: '1970-01-01T00:00:00.001Z',
    deadlineAt: '1970-01-01T00:00:00.100Z',
    effectiveAcceptanceMs: 1,
    effectiveTurnMs: 100,
    acceptanceSource: 'test',
    turnSource: 'test',
    remainingAcceptanceMs: () => (acceptanceChecks++ === 0 ? 1 : 0),
    remainingTurnMs: () => 100,
  };
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 20,
    query: () => {
      submitted = true;
      return {
        close() {
          closeCalled = true;
        },
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              throw new Error('late expired rejection');
            },
            async return() {
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  });
  const events = await within(collect(adapter.execute({ ...input(), executionBudget })));
  assert.equal(submitted, true);
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.equal(closeCalled, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test('Claude acceptance deadline does not stretch when wall clock jumps backward', async (t) => {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  const adapter = createClaudeAdapter({
    requestTimeoutMs: 35,
    cleanupTimeoutMs: 20,
    query: () => ({
      [Symbol.asyncIterator]() {
        offset = -120_000;
        return {
          next: () => new Promise<IteratorResult<unknown>>(() => {}),
          return: async () => ({ done: true, value: undefined }),
        };
      },
    }),
  });
  const events = await within(collect(adapter.execute(input())));
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.match(
    (events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).message,
    /acceptance.*timed out/i,
  );
});

test('Claude closes Query when async iterator acquisition throws', async () => {
  let closeCalled = false;
  const adapter = createClaudeAdapter({
    query: () => ({
      close() {
        closeCalled = true;
      },
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        throw new Error('iterator setup failed');
      },
    }),
  });
  const events = await collect(adapter.execute(input()));
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.equal(closeCalled, true);
  await assert.rejects(adapter.close(), /cleanup.*unconfirmed/i);
});

test('Claude consumer stop uses bounded cleanup; close rejects a hung return', async () => {
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 25,
    query: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({
            done: false,
            value: { type: 'system', subtype: 'init', session_id: 'consumer-stop' },
          }),
          return: () => new Promise<IteratorResult<unknown>>(() => {}),
        };
      },
    }),
  });
  await within(
    (async () => {
      for await (const event of adapter.execute(input())) if (event.type === 'accepted') break;
    })(),
  );
  await assert.rejects(within(adapter.close!()), /cleanup.*unconfirmed/i);
});

test('Claude adapter.close aborts an active query and refuses an unconfirmed stop', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const adapter = createClaudeAdapter({
    requestTimeoutMs: 1000,
    cleanupTimeoutMs: 25,
    query: () => {
      started();
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<unknown>>(() => {}),
            return: () => new Promise<IteratorResult<unknown>>(() => {}),
          };
        },
      };
    },
  });
  const execution = collect(adapter.execute(input()));
  await within(ready);
  await assert.rejects(within(adapter.close!()), /cleanup.*unconfirmed/i);
  const events = await within(execution);
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
});

test('Claude pre-submit abort never calls query and finite positive deadlines are required', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const adapter = createClaudeAdapter({
    query: () => {
      called = true;
      throw new Error('not reached');
    },
  });
  assert.deepEqual(await collect(adapter.execute(input(controller.signal))), [
    { type: 'interrupted' },
  ]);
  assert.equal(called, false);
  for (const value of [0, -1, Infinity, NaN, 2_147_483_648]) {
    assert.throws(() => createClaudeAdapter({ requestTimeoutMs: value }), /requestTimeoutMs/);
  }
});
