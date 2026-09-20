import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createClaudeAdapter,
  type ClaudeQueryFactory,
} from '../../packages/adapter-claude/src/index.ts';
import { createClaudeMcpServer } from '../../packages/adapter-claude/src/mcp.ts';
import { ORCHESTRATION_TOOLS } from '../../packages/engine/src/tools.ts';
const path = process.argv[2];
if (!path) throw new Error('Pass the absolute installed SDK module path; no native CLI will run');
const sdk = (await import(pathToFileURL(path).href)) as { query: ClaudeQueryFactory };
const root = await mkdtemp(join(tmpdir(), 'claude-native-mcp-'));
await mkdir(join(root, 'workspace'));
await mkdir(join(root, 'state'));
const calls: string[] = [];
const permissions: string[] = [];
const adapter = createClaudeAdapter({
  createMcpServer: (tools) =>
    createClaudeMcpServer(tools, {
      sdk: sdk as unknown as typeof import('@anthropic-ai/claude-agent-sdk'),
      zod: createRequire(path!)('zod'),
    }),
  query: (req) =>
    sdk.query({
      ...req,
      options: {
        ...req.options,
        spawnClaudeCodeProcess: (native) =>
          req.options.spawnClaudeCodeProcess({
            command: process.execPath,
            args: [fileURLToPath(new URL('./claude-mcp-child.ts', import.meta.url))],
            env: {},
            cwd: req.options.cwd,
            signal: native.signal,
          }),
      },
    }),
  requestTimeoutMs: 5000,
  turnTimeoutMs: 5000,
});
try {
  const events = [];
  for await (const event of adapter.execute({
    taskId: 'task',
    sessionId: 'session',
    dispatchId: 'dispatch',
    providerSessionId: null,
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    model: 'offline',
    prompt: 'Invoke tools',
    permissionProfile: 'read-only',
    signal: new AbortController().signal,
    orchestrationTools: {
      definitions: ORCHESTRATION_TOOLS,
      async call(name) {
        calls.push(name);
        return { ok: true };
      },
    },
    async requestPermission(request) {
      permissions.push(request.toolName);
      return true;
    },
  }))
    events.push(event);
  assert.equal(events.at(-1)?.type, 'result', JSON.stringify(events));
  assert.deepEqual(
    calls,
    ORCHESTRATION_TOOLS.map((tool) => tool.name),
    JSON.stringify(events),
  );
  assert.deepEqual(permissions, ['Read'], JSON.stringify(events));
  assert.equal(adapter.hasActiveResources('session'), false);
  process.stdout.write(
    JSON.stringify({
      nativeSdkMcp: true,
      offlineSubprocess: true,
      tools: calls,
      permissions,
      modelCalls: 0,
    }) + '\n',
  );
} finally {
  await adapter.close();
  await rm(root, { recursive: true, force: true });
}
