import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import type { RuntimeEvent, RuntimeInput } from '../../packages/engine/src/types.ts';

type Evidence = {
  version: number;
  sequence: number;
  dispatchId: string;
  generation: number;
  providerSessionId: string | null;
  source: string;
  localResources: string;
  remoteExecution: string;
  terminal?: RuntimeEvent;
};

function input(extra: Record<string, unknown> = {}): RuntimeInput {
  return {
    taskId: 'task-a2',
    sessionId: 'session-a2',
    dispatchId: 'dispatch-a2',
    providerSessionId: null,
    model: 'fixture',
    workspace: process.cwd(),
    stateDir: '/tmp/claude-a2-fixture',
    prompt: 'Read only',
    permissionProfile: 'read-only',
    signal: new AbortController().signal,
    ...extra,
  };
}

async function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test('A2 Claude declares only explicit provider caps and a terminal-covering evidence channel', () => {
  const defaults = createClaudeAdapter().capabilities();
  assert.deepEqual(defaults.executionBudget, {
    version: 2,
    acceptanceCapMs: null,
    turnCapMs: null,
  });
  assert.deepEqual(defaults.executionEvidence, { version: 1, terminalCoversExecution: true });
  const explicit = createClaudeAdapter({
    requestTimeoutMs: 100,
    turnTimeoutMs: 500,
  }).capabilities();
  assert.deepEqual(explicit.executionBudget, {
    version: 2,
    acceptanceCapMs: 100,
    turnCapMs: 500,
  });
});

test('A2 Claude uses the same total budget before and after acceptance', async () => {
  let remainingTurn = 50;
  const evidence: Evidence[] = [];
  const adapter = createClaudeAdapter({
    query: () => ({
      [Symbol.asyncIterator]() {
        let count = 0;
        return {
          async next() {
            count++;
            if (count === 1)
              return {
                done: false,
                value: { type: 'system', subtype: 'init', session_id: 'provider-a2' },
              };
            remainingTurn = 0;
            return {
              done: false,
              value: {
                type: 'result',
                subtype: 'success',
                session_id: 'provider-a2',
                result: 'late',
              },
            };
          },
          async return() {
            return { done: true, value: undefined };
          },
        };
      },
    }),
  });
  const events = await collect(
    adapter.execute(
      input({
        generation: 7,
        reportExecutionEvidence: (item: Evidence) => evidence.push(item),
        executionBudget: {
          policyVersion: 2,
          enteredAt: new Date().toISOString(),
          acceptanceDeadlineAt: new Date().toISOString(),
          deadlineAt: new Date().toISOString(),
          effectiveAcceptanceMs: 50,
          effectiveTurnMs: 50,
          acceptanceSource: 'host_default',
          turnSource: 'host_default',
          remainingAcceptanceMs: () => 50,
          remainingTurnMs: () => remainingTurn,
        },
      }),
    ),
  );
  assert.equal(events[0]?.type, 'accepted');
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.equal(
    events.some((event) => event.type === 'result'),
    false,
  );
  assert.equal(
    evidence.some((item) => item.source === 'runtime_terminal'),
    true,
  );
});

test('A2 Claude reports matched terminal before cleanup and then full stop', async () => {
  const evidence: Evidence[] = [];
  const adapter = createClaudeAdapter({
    query: () =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'provider-a2' };
        yield { type: 'result', subtype: 'success', session_id: 'provider-a2', result: 'done' };
      })(),
  });
  const events = await collect(
    adapter.execute(
      input({ generation: 7, reportExecutionEvidence: (item: Evidence) => evidence.push(item) }),
    ),
  );
  assert.equal(events.at(-1)?.type, 'result');
  assert.equal(evidence.length, 2);
  assert.deepEqual(
    evidence.map((item) => [item.sequence, item.source, item.localResources, item.remoteExecution]),
    [
      [1, 'runtime_terminal', 'unknown', 'stopped'],
      [2, 'resource_observation', 'stopped', 'stopped'],
    ],
  );
  assert.equal(evidence[0]?.terminal?.type, 'result');
  assert.equal(evidence[0]?.dispatchId, 'dispatch-a2');
  assert.equal(evidence[1]?.generation, 7);
  assert.equal(evidence[1]?.providerSessionId, 'provider-a2');
});

test('A2 Claude retains terminal evidence until delayed iterator cleanup confirms stop', async () => {
  const evidence: Evidence[] = [];
  let finishReturn!: () => void;
  const returned = new Promise<IteratorResult<unknown>>((resolve) => {
    finishReturn = () => resolve({ done: true, value: undefined });
  });
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 10,
    query: () => ({
      [Symbol.asyncIterator]() {
        let count = 0;
        return {
          async next() {
            count++;
            return count === 1
              ? {
                  done: false,
                  value: {
                    type: 'result',
                    subtype: 'success',
                    session_id: 'provider-a2',
                    result: 'done',
                  },
                }
              : { done: true, value: undefined };
          },
          return: () => returned,
        };
      },
    }),
  });
  const events = await collect(
    adapter.execute(input({ reportExecutionEvidence: (item: Evidence) => evidence.push(item) })),
  );
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.deepEqual(
    evidence.map((item) => item.localResources),
    ['unknown'],
  );
  finishReturn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    evidence.map((item) => item.localResources),
    ['unknown', 'stopped'],
  );
  assert.equal(evidence[1]?.remoteExecution, 'stopped');
});

test('A2 Claude does not use a foreign terminal session as stop evidence', async () => {
  const evidence: Evidence[] = [];
  const adapter = createClaudeAdapter({
    query: () =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'expected' };
        yield { type: 'result', subtype: 'success', session_id: 'foreign', result: 'wrong' };
      })(),
  });
  const events = await collect(
    adapter.execute(input({ reportExecutionEvidence: (item: Evidence) => evidence.push(item) })),
  );
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.equal(
    evidence.some((item) => item.remoteExecution === 'stopped'),
    false,
  );
});

test('A2 Claude reports pre-submission rejection with both resources stopped', async () => {
  const evidence: Evidence[] = [];
  const adapter = createClaudeAdapter({
    query: () => {
      throw new Error('must not run');
    },
  });
  const events = await collect(
    adapter.execute(
      input({
        permissionProfile: 'workspace-write',
        reportExecutionEvidence: (item: Evidence) => evidence.push(item),
      }),
    ),
  );
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'failed');
  assert.deepEqual(
    evidence.map((item) => [item.source, item.localResources, item.remoteExecution]),
    [['pre_submission', 'stopped', 'stopped']],
  );
});

test('A2 Claude does not submit after the host budget is already exhausted', async () => {
  const evidence: Evidence[] = [];
  let called = false;
  const adapter = createClaudeAdapter({
    query: () => {
      called = true;
      throw new Error('must not run');
    },
  });
  const events = await collect(
    adapter.execute(
      input({
        reportExecutionEvidence: (item: Evidence) => evidence.push(item),
        executionBudget: {
          policyVersion: 2,
          enteredAt: new Date().toISOString(),
          acceptanceDeadlineAt: new Date().toISOString(),
          deadlineAt: new Date().toISOString(),
          effectiveAcceptanceMs: 1,
          effectiveTurnMs: 1,
          acceptanceSource: 'host_default',
          turnSource: 'host_default',
          remainingAcceptanceMs: () => 0,
          remainingTurnMs: () => 0,
        },
      }),
    ),
  );
  assert.equal(called, false);
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'failed');
  assert.deepEqual(
    evidence.map((item) => [item.source, item.localResources, item.remoteExecution]),
    [['pre_submission', 'stopped', 'stopped']],
  );
});

test('A2 Claude keeps a late matching terminal as resource evidence without reviving the business result', async () => {
  const evidence: Evidence[] = [];
  let finishNext!: () => void;
  let finishReturn!: () => void;
  const late = new Promise<IteratorResult<unknown>>((resolve) => {
    finishNext = () =>
      resolve({
        done: false,
        value: { type: 'result', subtype: 'success', session_id: 'provider-a2', result: 'late' },
      });
  });
  const returned = new Promise<IteratorResult<unknown>>((resolve) => {
    finishReturn = () => resolve({ done: true, value: undefined });
  });
  const adapter = createClaudeAdapter({
    turnTimeoutMs: 20,
    cleanupTimeoutMs: 10,
    query: () => ({
      [Symbol.asyncIterator]() {
        let count = 0;
        return {
          next() {
            count++;
            return count === 1
              ? Promise.resolve({
                  done: false,
                  value: { type: 'system', subtype: 'init', session_id: 'provider-a2' },
                })
              : late;
          },
          return: () => returned,
        };
      },
    }),
  });
  const events = await collect(
    adapter.execute(input({ reportExecutionEvidence: (item: Evidence) => evidence.push(item) })),
  );
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
  assert.equal(
    evidence.some((item) => item.remoteExecution === 'stopped'),
    false,
  );
  finishNext();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    evidence.some((item) => item.source === 'runtime_terminal'),
    true,
  );
  assert.equal(
    evidence.some((item) => item.localResources === 'stopped'),
    false,
  );
  finishReturn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(evidence.at(-1)?.localResources, 'stopped');
  assert.equal(evidence.at(-1)?.remoteExecution, 'stopped');
  assert.equal(evidence.at(-1)?.sequence, 2);
});

test('A2 Claude host budget uses the negotiated monotonic clock without a second local timer', async () => {
  const adapter = createClaudeAdapter({
    query: () =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'host-clock' };
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield { type: 'result', subtype: 'success', session_id: 'host-clock', result: 'done' };
      })(),
  });
  const events = await collect(
    adapter.execute(
      input({
        executionBudget: {
          policyVersion: 2,
          enteredAt: new Date().toISOString(),
          acceptanceDeadlineAt: new Date().toISOString(),
          deadlineAt: new Date().toISOString(),
          effectiveAcceptanceMs: 20,
          effectiveTurnMs: 20,
          acceptanceSource: 'host_default',
          turnSource: 'host_default',
          // The owner controls this monotonic clock and its abort signal.
          remainingAcceptanceMs: () => 20,
          remainingTurnMs: () => 20,
        },
      }),
    ),
  );
  assert.equal(events.at(-1)?.type, 'result');
});

test('A2 Claude rechecks a decreasing host budget while SDK next never settles', async () => {
  let remaining = 20;
  let returned = false;
  const adapter = createClaudeAdapter({
    cleanupTimeoutMs: 20,
    query: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<unknown>>(() => {}),
          async return() {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    }),
  });
  const advance = setTimeout(() => {
    remaining = 0;
  }, 25);
  let guard: NodeJS.Timeout | undefined;
  try {
    const events = await Promise.race([
      collect(
        adapter.execute(
          input({
            executionBudget: {
              policyVersion: 2,
              enteredAt: new Date().toISOString(),
              acceptanceDeadlineAt: new Date().toISOString(),
              deadlineAt: new Date().toISOString(),
              effectiveAcceptanceMs: 20,
              effectiveTurnMs: 20,
              acceptanceSource: 'host_default',
              turnSource: 'host_default',
              remainingAcceptanceMs: () => remaining,
              remainingTurnMs: () => remaining,
            },
          }),
        ),
      ),
      new Promise<never>((_, reject) => {
        guard = setTimeout(
          () => reject(new Error('host budget did not end the stalled SDK wait')),
          200,
        );
      }),
    ]);
    assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'error' }>).outcome, 'unknown');
    assert.equal(returned, true);
  } finally {
    clearTimeout(advance);
    clearTimeout(guard);
  }
});
