import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import type { RuntimeEvent, RuntimeInput } from '../../packages/engine/src/types.ts';
import { withClaudeProcess } from '../fixtures/claude-process.ts';

// SPEC-0031 A: the Claude adapter reports the calls outside the main loop from `modelUsage`.

type UsageEvent = Extract<RuntimeEvent, { type: 'usage' }>;
const MODEL = 'claude-sonnet-4-6';
const mainLoop = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 12,
  cache_creation: { ephemeral_5m_input_tokens: 9, ephemeral_1h_input_tokens: 3 },
};
/** A `modelUsage` entry with the main loop's counts, plus `extra`. */
const entry = (extra: Record<string, unknown> = {}, add = [0, 0, 0, 0]) => ({
  inputTokens: 100 + add[0],
  outputTokens: 20 + add[1],
  cacheReadInputTokens: 5 + add[2],
  cacheCreationInputTokens: 12 + add[3],
  webSearchRequests: 0,
  costUSD: 0.01,
  contextWindow: 200000,
  maxOutputTokens: 32000,
  ...extra,
});
const mainObservation = {
  usageId: 'dispatch:result',
  usage: {
    inputTokens: 100,
    cachedInputTokens: 5,
    cacheWriteInputTokens: 12,
    cacheWrite5mInputTokens: 9,
    cacheWrite1hInputTokens: 3,
    outputTokens: 20,
    raw: mainLoop,
  },
};

/** Runs one scripted dispatch and returns its usage observations, as reported and as yielded. */
async function observationsOf(result: Record<string, unknown>) {
  const reported: UsageEvent[] = [];
  const adapter = createClaudeAdapter({
    query: withClaudeProcess(() =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'native-session' };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'native-session',
          result: 'done',
          usage: mainLoop,
          ...result,
        };
      })(),
    ),
  });
  const input = {
    taskId: 'task',
    sessionId: 'session',
    dispatchId: 'dispatch',
    providerSessionId: null,
    workspace: process.cwd(),
    stateDir: '/private/tmp/unused-outside-usage-state',
    model: MODEL,
    prompt: 'fixture',
    permissionProfile: 'read-only',
    signal: new AbortController().signal,
    reportUsage: (event: UsageEvent) => reported.push(event),
  } as RuntimeInput;
  const events: RuntimeEvent[] = [];
  try {
    for await (const event of adapter.execute(input)) events.push(event);
  } finally {
    await adapter.close();
  }
  const yielded = events.filter((event): event is UsageEvent => event.type === 'usage');
  assert.deepEqual(reported, yielded, 'reported and yielded observations are the same');
  // SPEC-0031 timing: every observation comes before the terminal.
  const terminal = events.findIndex((event) => event.type === 'result' || event.type === 'error');
  assert.ok(
    events.every((event, index) => event.type !== 'usage' || index < terminal),
    JSON.stringify(events.map((event) => event.type)),
  );
  return yielded.map(({ usageId, usage }) => ({ usageId, usage }));
}

test('0031-A01 0031-A05 a result without calls outside the main loop has only its main observation', async () => {
  assert.deepEqual(await observationsOf({}), [mainObservation]);
  assert.deepEqual(await observationsOf({ modelUsage: { [MODEL]: entry() } }), [mainObservation]);
  assert.deepEqual(await observationsOf({ modelUsage: 'not an object' }), [mainObservation]);
});

test('0031-A02 0031-A03 the main model reports what its main loop left out, under the dispatch’s model', async () => {
  const main = entry({ canonicalModel: MODEL }, [7000, 700, 0, 300]);
  assert.deepEqual(await observationsOf({ modelUsage: { [MODEL]: main } }), [
    mainObservation,
    {
      usageId: `dispatch:outside:${MODEL}`,
      usage: {
        inputTokens: 7000,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 300,
        outputTokens: 700,
        raw: main,
      },
    },
  ]);
  // Found by its canonical model, or as the only key; its observation still names no model.
  for (const [key, extra] of [
    [`${MODEL}[1m]`, { canonicalModel: MODEL }],
    ['sonnet', {}],
  ] as const) {
    const observed = await observationsOf({
      modelUsage: { [key]: entry(extra, [1, 0, 0, 0]) },
    });
    assert.deepEqual(
      observed.slice(1).map(({ usageId, usage }) => [usageId, usage.inputTokens, 'model' in usage]),
      [[`dispatch:outside:${key}`, 1, false]],
      key,
    );
  }
  // With another model beside it, only the canonical model tells which key ran the main loop.
  const other = {
    inputTokens: 3,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  const observed = await observationsOf({
    modelUsage: {
      'vendor-model': other,
      [`${MODEL}[1m]`]: entry({ canonicalModel: MODEL }, [1, 0, 0, 0]),
    },
  });
  assert.deepEqual(
    observed.slice(1).map(({ usageId, usage }) => [usageId, usage.inputTokens, usage.model]),
    [
      ['dispatch:outside:vendor-model', 3, 'vendor-model'],
      [`dispatch:outside:${MODEL}[1m]`, 1, undefined],
    ],
  );
});

test('0031-A02 0031-A03 another model reports all its calls under its canonical model or its key', async () => {
  const haiku = {
    inputTokens: 50,
    outputTokens: 5,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 40,
    canonicalModel: 'claude-haiku-4-5',
  };
  const other = {
    inputTokens: 3,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  assert.deepEqual(
    await observationsOf({
      modelUsage: {
        [MODEL]: entry(),
        'claude-haiku-4-5-20251001': haiku,
        'vendor-model': other,
      },
    }),
    [
      mainObservation,
      {
        usageId: 'dispatch:outside:claude-haiku-4-5-20251001',
        usage: {
          inputTokens: 50,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 40,
          outputTokens: 5,
          model: 'claude-haiku-4-5',
          raw: haiku,
        },
      },
      {
        usageId: 'dispatch:outside:vendor-model',
        usage: {
          inputTokens: 3,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 1,
          model: 'vendor-model',
          raw: other,
        },
      },
    ],
  );
});

test('0031-A02 a long model key takes a digest in the observation’s ID', async () => {
  const key = `vendor/${'x'.repeat(300)}`;
  const [, observation] = await observationsOf({
    modelUsage: { [MODEL]: entry(), [key]: entry({ canonicalModel: 'vendor-long' }) },
  });
  assert.match(observation.usageId, /^dispatch:outside:sha256-[0-9a-f]{32}$/);
  assert.equal(observation.usage.model, 'vendor-long');
});

test('0031-A04 an unknown main model, a missing count and a negative remainder are unknown, not guessed', async () => {
  const unknown = {
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
  };
  const two = { 'model-a': entry(), 'model-b': entry() };
  assert.deepEqual(await observationsOf({ modelUsage: two }), [
    mainObservation,
    { usageId: 'dispatch:outside:unknown', usage: { ...unknown, raw: two } },
  ]);
  const lacking = { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0 };
  const below = entry({}, [-60, 0, 0, 0]);
  assert.deepEqual(
    await observationsOf({ modelUsage: { [MODEL]: below, 'vendor-model': lacking } }),
    [
      mainObservation,
      { usageId: `dispatch:outside:${MODEL}`, usage: { ...unknown, raw: below } },
      {
        usageId: 'dispatch:outside:vendor-model',
        usage: { ...unknown, model: 'vendor-model', raw: lacking },
      },
    ],
  );
});
