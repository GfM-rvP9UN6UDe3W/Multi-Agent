// SPEC-0026 Z02: the Claude MCP server where neither Zod nor the Claude Agent SDK can be resolved.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const hidden = /^(?:zod|@anthropic-ai\/claude-agent-sdk)(?:\/|$)/;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (hidden.test(specifier))
      throw Object.assign(new Error(`Cannot find package '${specifier}' (hidden by the test)`), {
        code: 'ERR_MODULE_NOT_FOUND',
      });
    return nextResolve(specifier, context);
  },
});
// The workspace has both installed; the test is meaningful only while the hook hides them.
for (const name of ['zod', '@anthropic-ai/claude-agent-sdk'])
  await assert.rejects(import(name), { code: 'ERR_MODULE_NOT_FOUND' });

const { createClaudeMcpServer } = await import('../../packages/adapter-claude/src/mcp.ts');
const { ORCHESTRATION_TOOLS } = await import('../../packages/engine/src/tools.ts');
const { connectMcp } = await import('./mcp-transport.ts');
const calls: string[] = [];
const mcp = await connectMcp(
  await createClaudeMcpServer({
    definitions: ORCHESTRATION_TOOLS,
    async call(name) {
      calls.push(name);
      return { ok: true };
    },
  }),
);
const listed = (await mcp.request('tools/list')).result.tools.map(
  (tool: { name: string }) => tool.name,
);
const called = await mcp.request('tools/call', {
  name: 'work_read',
  arguments: { request: { kind: 'task', id: 'task' } },
});
assert.equal(called.result.isError, undefined, JSON.stringify(called));
process.stdout.write(JSON.stringify({ listed, calls }) + '\n');
