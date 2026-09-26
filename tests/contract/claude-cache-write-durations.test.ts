import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import type { RuntimeEvent, RuntimeInput } from '../../packages/engine/src/types.ts';
import { withClaudeProcess } from '../fixtures/claude-process.ts';

// SPEC-0030 A01: the Claude adapter splits cache writes by duration only when the split adds up.

type UsageEvent = Extract<RuntimeEvent, { type: 'usage' }>;
const counts = {
  input_tokens: 17,
  output_tokens: 4,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 12,
};
const plain = {
  inputTokens: 17,
  cachedInputTokens: 3,
  cacheWriteInputTokens: 12,
  outputTokens: 4,
};

async function usageOf(nativeUsage: Record<string, unknown>) {
  const observed: UsageEvent[] = [];
  const adapter = createClaudeAdapter({
    query: withClaudeProcess(() =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'native-session' };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'native-session',
          result: 'done',
          usage: nativeUsage,
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
    stateDir: '/private/tmp/unused-cache-write-state',
    model: 'offline',
    prompt: 'fixture',
    permissionProfile: 'read-only',
    signal: new AbortController().signal,
    reportUsage: (event: UsageEvent) => observed.push(event),
  } as RuntimeInput;
  const yielded: UsageEvent[] = [];
  try {
    for await (const event of adapter.execute(input))
      if (event.type === 'usage') yielded.push(event);
  } finally {
    await adapter.close();
  }
  assert.deepEqual(
    observed.map((event) => event.usage),
    yielded.map((event) => event.usage),
  );
  assert.equal(yielded.length, 1);
  const { raw, ...usage } = yielded[0].usage;
  assert.deepEqual(raw, nativeUsage, 'raw keeps the native usage');
  return usage;
}

test('0030-A01 the Claude adapter reports the split of its cache writes when it adds up', async () => {
  assert.deepEqual(
    await usageOf({
      ...counts,
      cache_creation: { ephemeral_5m_input_tokens: 9, ephemeral_1h_input_tokens: 3 },
    }),
    { ...plain, cacheWrite5mInputTokens: 9, cacheWrite1hInputTokens: 3 },
  );
  assert.deepEqual(
    await usageOf({
      ...counts,
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    }),
    { ...plain, cacheWriteInputTokens: 0, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 0 },
  );
});

test('0030-A01 the Claude adapter reports no split that does not add up or is not two counts', async () => {
  for (const [name, cacheCreation] of [
    ['more than the cache writes', { ephemeral_5m_input_tokens: 9, ephemeral_1h_input_tokens: 4 }],
    ['one duration', { ephemeral_5m_input_tokens: 12 }],
    ['a string', { ephemeral_5m_input_tokens: '9', ephemeral_1h_input_tokens: 3 }],
    ['a negative count', { ephemeral_5m_input_tokens: 13, ephemeral_1h_input_tokens: -1 }],
    ['a fraction', { ephemeral_5m_input_tokens: 11.5, ephemeral_1h_input_tokens: 0.5 }],
    ['null', null],
    ['absent', undefined],
  ] as const)
    assert.deepEqual(
      await usageOf({
        ...counts,
        ...(cacheCreation === undefined ? {} : { cache_creation: cacheCreation }),
      }),
      plain,
      name,
    );
  // Without a cache-write count there is nothing to split.
  const { cache_creation_input_tokens: _count, ...withoutCount } = counts;
  assert.deepEqual(
    await usageOf({
      ...withoutCount,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    }),
    { ...plain, cacheWriteInputTokens: null },
  );
});
