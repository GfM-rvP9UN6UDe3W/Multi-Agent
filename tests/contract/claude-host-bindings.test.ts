import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import { ORCHESTRATION_TOOLS } from '../../packages/engine/src/tools.ts';
import { claudeProcess } from '../fixtures/claude-process.ts';
import { connectMcp } from '../fixtures/mcp-transport.ts';

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

test('0026-Z06 an injected Claude query gets the adapter-owned MCP server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-host-binding-'));
  await mkdir(join(root, 'work'));
  await mkdir(join(root, 'state'));
  const servers: unknown[] = [];
  const calls: string[] = [];
  let listed: string[] = [];
  let called: unknown;
  const adapter = createClaudeAdapter({
    query(request) {
      const server = (request.options as { mcpServers?: Record<string, unknown> }).mcpServers
        ?.agent_orch;
      servers.push(server);
      const child = claudeProcess(request);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'native' };
          const mcp = await connectMcp(server);
          listed = (await mcp.request('tools/list')).result.tools.map(
            (tool: { name: string }) => tool.name,
          );
          called = (
            await mcp.request('tools/call', {
              name: 'work_read',
              arguments: { request: { kind: 'task', id: 'task' } },
            })
          ).result;
          yield { type: 'result', subtype: 'success', session_id: 'native', result: 'done' };
        },
        close() {
          child.stdin.end();
        },
      };
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
        async call(name) {
          calls.push(name);
          return { ok: true };
        },
      },
    }))
      events.push(event);
    assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
    assert.equal(servers.length, 1);
    assert.equal((servers[0] as { type?: unknown }).type, 'sdk');
    assert.equal((servers[0] as { name?: unknown }).name, 'agent_orch');
    assert.deepEqual(
      listed,
      ORCHESTRATION_TOOLS.map((tool) => tool.name),
    );
    assert.deepEqual(called, { content: [{ type: 'text', text: '{"ok":true}' }] });
    assert.deepEqual(calls, ['work_read']);
    // The binding still ends with the turn.
    const late = await connectMcp(servers[0]);
    assert.deepEqual(
      (await late.request('tools/call', { name: 'work_read', arguments: { request: {} } })).result,
      { isError: true, content: [{ type: 'text', text: 'STALE_GRANT' }] },
    );
    assert.equal(adapter.hasActiveResources('logical'), false);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});
