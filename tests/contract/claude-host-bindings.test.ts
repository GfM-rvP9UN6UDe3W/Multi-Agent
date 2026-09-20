import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import { ORCHESTRATION_TOOLS } from '../../packages/engine/src/tools.ts';

test('D04 injected Claude query never implicitly resolves an inspection SDK', async () => {
  const adapter = createClaudeAdapter({
    query: async function* () {
      throw new Error('not called');
    },
  });
  try {
    const result = await adapter.inspect!({
      sessionId: 'logical',
      providerSessionId: 'native',
      generation: 1,
      dispatchId: 'dispatch',
      workspace: '/nonexistent-host-workspace',
      stateDir: '/nonexistent-host-state',
      limit: 1,
      timeoutMs: 1000,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.execution, 'unknown');
    assert.match(result.detail!, /config.inspectSession/);
  } finally {
    await adapter.close();
  }
});

test('D04 injected Claude query requires matching MCP binding before submission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-host-binding-'));
  await mkdir(join(root, 'work'));
  await mkdir(join(root, 'state'));
  let queryCalls = 0;
  const adapter = createClaudeAdapter({
    query: async function* () {
      queryCalls++;
    },
  });
  try {
    const events = [];
    for await (const event of adapter.execute({
      taskId: 'task',
      sessionId: 'logical',
      dispatchId: 'dispatch',
      providerSessionId: null,
      model: 'fixture',
      prompt: 'offline',
      workspace: join(root, 'work'),
      stateDir: join(root, 'state'),
      permissionProfile: 'read-only',
      signal: new AbortController().signal,
      orchestrationTools: {
        definitions: ORCHESTRATION_TOOLS,
        async call() {
          throw new Error('not called');
        },
      },
    }))
      events.push(event);
    assert.equal(queryCalls, 0);
    assert.ok(
      events.some(
        (event) => event.type === 'error' && /config.createMcpServer/.test(event.message),
      ),
      JSON.stringify(events),
    );
    assert.equal(adapter.hasActiveResources('logical'), false);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});
