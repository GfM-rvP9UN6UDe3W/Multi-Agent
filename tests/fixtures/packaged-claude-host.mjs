import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOrchestrator, validateWire } from '@orchvia/sdk';
import { createFakeAdapter } from '@orchvia/engine/fake';
import {
  createClaudeAdapter,
  createClaudeMcpServer,
  inspectClaudeSession,
} from '@orchvia/adapter-claude';
import * as nativeSdk from '@anthropic-ai/claude-agent-sdk';
import * as zod from 'zod';

// Replaced with an owned, compiled protocol fixture by package-bundles-smoke.mjs.
const peerSource = '__OWNED_CLAUDE_PEER__';
async function main() {
  const mode = process.argv[2];
  if (mode !== 'installed-claude-mcp')
    await assert.rejects(access(join(process.cwd(), 'node_modules')));
  const base = await mkdtemp(join(tmpdir(), 'orch-packaged-claude-'));
  await mkdir(join(base, 'work'));
  process.env.CLAUDE_CONFIG_DIR = join(base, 'native-private');
  let mcpCalls = 0,
    queryCalls = 0,
    inspectionCalls = 0;
  const adapter = createClaudeAdapter({
    query: (request) => {
      queryCalls++;
      return nativeSdk.query({
        ...request,
        options: {
          ...request.options,
          pathToClaudeCodeExecutable: process.execPath,
          spawnClaudeCodeProcess: (native) =>
            request.options.spawnClaudeCodeProcess({
              command: process.execPath,
              args: ['--input-type=module', '-e', peerSource, '--', '--engine-tools'],
              cwd: request.options.cwd,
              env: {},
              signal: native.signal,
            }),
        },
      });
    },
    createMcpServer: (tools) => {
      const counted = {
        ...tools,
        async call(name, request) {
          mcpCalls++;
          return tools.call(name, request);
        },
      };
      return createClaudeMcpServer(
        counted,
        mode === 'installed-claude-mcp' ? undefined : { sdk: nativeSdk, zod },
      );
    },
    inspectSession: (input) =>
      inspectClaudeSession(input, {
        async getSessionInfo(id) {
          inspectionCalls++;
          return { sessionId: id };
        },
        async getSessionMessages() {
          return [];
        },
      }),
  });
  // Electron supplies these same APIs; this marker checks that embedded startup has no brand gate.
  Object.defineProperty(process.versions, 'electron', { value: '43.2.0', configurable: true });
  const client = await createOrchestrator({
    workspace: join(base, 'work'),
    stateDir: join(base, 'state'),
    adapters: [adapter, createFakeAdapter()],
    tools: { enabled: true },
    limits: { maxActiveSessions: 1 },
    storage: { emergencyBytes: 4096, minFreeBytes: 0 },
    timeouts: { acceptanceMs: 5000, turnMs: 10000 },
  });
  try {
    for (const provider of ['fake', 'claude']) {
      const task = await client.tasks.create({
        goal: 'offline packaged human acceptance',
        runtime: { provider, model: 'fixture' },
        acceptance: { mode: 'human', criteria: ['known fixture result'] },
      });
      for await (const event of client.events({
        taskId: task.id,
        signal: AbortSignal.timeout(15000),
      })) {
        if (event.type === 'approval.requested') {
          const approval = await client.approvals.get(String(event.data.approvalId));
          await client.approvals.decide(approval.approvalId, {
            choice: 'approve',
            expectedRevision: approval.revision,
          });
          break;
        }
      }
      const done = await task.wait({ timeoutMs: 5000 });
      assert.equal(done.status, 'completed');
      validateWire('TaskSnapshot', done);
      if (provider === 'claude') {
        const result = JSON.parse(done.result);
        const child = await client.tasks.get(result.childId);
        assert.equal(child.spec.parentTaskId, task.id);
        assert.equal(child.status, 'paused');
        assert.equal((await client.messages.get(result.messageId)).fromSessionId, done.sessionId);
        assert.equal((await client.operations.get(result.operationId)).status, 'completed');
        const inspection = await client.sessions.inspect(done.sessionId);
        assert.equal(inspection.status, 'found');
        assert.equal(inspection.execution, 'unknown');
      }
    }
    assert.equal(mcpCalls, 4);
    assert.equal(queryCalls, 1);
    assert.equal(inspectionCalls, 1);
    console.log(
      JSON.stringify({
        mode,
        taskStatuses: ['completed', 'completed'],
        mcpCalls,
        queryCalls,
        inspectionCalls,
        modelCalls: 0,
        electronRuntime: false,
      }),
    );
  } finally {
    await client.close({ mode: 'interrupt', timeoutMs: 3000 });
    await rm(base, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
