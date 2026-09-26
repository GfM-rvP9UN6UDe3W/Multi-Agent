/**
 * SPEC-0031 C01 and C02: the real Claude Code binary against a loopback-only scripted gateway; no
 * credentials, no paid models. The gateway answers each kind of call with its own token counts, so
 * that the usage records show which calls the engine recorded.
 *
 * Usage: node scripts/native-usage-smoke.mjs EVIDENCE.json
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createOrchestrator } from '../packages/sdk-typescript/src/index.ts';
import { createClaudeAdapter } from '../packages/adapter-claude/src/index.ts';

const [outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error('Usage: node scripts/native-usage-smoke.mjs EVIDENCE.json');
const MODEL = 'claude-sonnet-4-6';
const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-native-usage-')));
const workspace = join(root, 'workspace'),
  stateDir = join(root, 'state'),
  home = join(root, 'home');
for (const directory of [workspace, stateDir, home]) await mkdir(directory, { mode: 0o700 });
await writeFile(join(workspace, 'notes.txt'), 'notes');
// This standalone process owns its environment. Do not inherit credentials or provider homes.
process.env = {
  PATH: process.env.PATH,
  HOME: home,
  TMPDIR: tmpdir(),
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  ANTHROPIC_AUTH_TOKEN: 'synthetic-offline-key',
};

// A main-loop call that reads a file with an almost full context makes Claude Code compact before
// its next call (C02). Each kind of call has its own counts.
const usageOf = {
  read: {
    input_tokens: 190000,
    output_tokens: 20,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  answer: {
    input_tokens: 1000,
    output_tokens: 30,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 12,
  },
  compact: {
    input_tokens: 7000,
    output_tokens: 700,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 300,
  },
};
const split = {
  read: [0, 0],
  answer: [9, 3],
  compact: [300, 0],
};
const calls = [];
let autoReadDone = false;
const send = (response, type, data) =>
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
const server = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) throw new Error('Request too large');
    }
    if (request.url.includes('count_tokens')) {
      response.setHeader('content-type', 'application/json');
      return response.end('{"input_tokens":100}');
    }
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages'))
      return response.writeHead(404).end();
    if (calls.length >= 40) throw new Error('Bounded gateway request count exhausted');
    const body = JSON.parse(raw);
    const history = JSON.stringify(body.messages ?? []);
    const kind = history.includes('create a detailed summary')
      ? 'compact'
      : history.includes('ORCH_AUTO_COMPACT') && !autoReadDone
        ? 'read'
        : 'answer';
    if (kind === 'read') autoReadDone = true;
    calls.push({ kind, model: body.model });
    const usage = {
      ...usageOf[kind],
      cache_creation: {
        ephemeral_5m_input_tokens: split[kind][0],
        ephemeral_1h_input_tokens: split[kind][1],
      },
    };
    const text = kind === 'compact' ? '<summary>Scripted summary.</summary>' : 'ORCH_OK';
    const block =
      kind === 'read'
        ? {
            type: 'tool_use',
            id: 'toolu_auto_read',
            name: 'Read',
            input: { file_path: join(workspace, 'notes.txt') },
          }
        : { type: 'text', text };
    const message = {
      id: `msg_${calls.length}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [block],
      stop_reason: kind === 'read' ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage,
    };
    if (!body.stream) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify(message));
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    send(response, 'message_start', { message: { ...message, content: [], stop_reason: null } });
    send(response, 'content_block_start', {
      index: 0,
      content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} },
    });
    send(response, 'content_block_delta', {
      index: 0,
      delta:
        block.type === 'text'
          ? { type: 'text_delta', text }
          : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
    });
    send(response, 'content_block_stop', { index: 0 });
    send(response, 'message_delta', {
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    });
    send(response, 'message_stop', {});
    response.end();
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;

const require = createRequire(import.meta.url);
const sdk = await import('@anthropic-ai/claude-agent-sdk');
const evidence = {
  sdk: JSON.parse(
    await readFile(
      join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'),
      'utf8',
    ),
  ).version,
  node: process.version,
  startedAt: new Date().toISOString(),
  responseSource: 'scripted-loopback-gateway',
  credentials: 'synthetic',
  results: [],
  cases: [],
};
const adapter = createClaudeAdapter({
  query(request) {
    const native = sdk.query(request);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const message of native) {
          if (message.type === 'result')
            evidence.results.push({ usage: message.usage, modelUsage: message.modelUsage });
          yield message;
        }
      },
      close: () => native.close(),
      interrupt: () => native.interrupt(),
    };
  },
});
const orch = await createOrchestrator({
  workspace,
  stateDir,
  adapters: [adapter],
  providers: { claude: { models: [MODEL] } },
  storage: { emergencyBytes: 4096, minFreeBytes: 0 },
  timeouts: { acceptanceMs: 30000, turnMs: 60000 },
  limits: { maxActiveSessions: 1 },
});
const until = async (taskId, status) => {
  const deadline = performance.now() + 65000;
  for (;;) {
    const task = await orch.tasks.get(taskId);
    if (task.status === status) return task;
    if (['failed', 'blocked', 'cancelled'].includes(task.status))
      throw new Error(JSON.stringify(task));
    if (performance.now() >= deadline) throw new Error(`Task deadline: ${task.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const records = async (taskId) =>
  (await orch.usage.get(taskId)).records.map((record) => ({
    kind: record.id.includes(':outside:') ? 'outside' : 'main',
    input: record.inputTokens,
    output: record.outputTokens,
    cacheRead: record.cachedInputTokens,
    cacheWrite: record.cacheWriteInputTokens,
    model: record.model,
  }));
const create = (goal) =>
  orch.tasks.create({
    goal,
    runtime: { provider: 'claude', model: MODEL },
    acceptance: { mode: 'human', criteria: ['Scripted response'] },
  });
let exitCode = 0;
try {
  // C02: Claude Code compacts in the middle of a dispatch.
  const auto = await create('ORCH_AUTO_COMPACT: read notes.txt, then answer ORCH_OK');
  await until(auto.id, 'waiting_approval');
  const compactions = calls.filter((call) => call.kind === 'compact').length;
  assert.ok(compactions >= 1, `Claude Code did not compact: ${JSON.stringify(calls)}`);
  const autoRecords = await records(auto.id);
  evidence.autoCompact = { calls: [...calls], records: autoRecords };
  assert.deepEqual(autoRecords, [
    { kind: 'main', input: 191000, output: 50, cacheRead: 5, cacheWrite: 12, model: MODEL },
    {
      kind: 'outside',
      input: 7000 * compactions,
      output: 700 * compactions,
      cacheRead: 0,
      cacheWrite: 300 * compactions,
      model: MODEL,
    },
  ]);
  evidence.cases.push('auto-compaction-in-a-dispatch-recorded-under-the-dispatch-model');

  // C01: the engine's own compaction.
  const delivered = await orch.tasks.get(auto.id);
  const approval = await orch.approvals.get(delivered.approvalId);
  await orch.approvals.decide(delivered.approvalId, {
    choice: 'approve',
    expectedRevision: approval.revision,
  });
  await until(auto.id, 'completed');
  const session = await orch.sessions.get(delivered.sessionId);
  const before = calls.length;
  const compact = await orch.sessions.compact({
    sessionId: session.id,
    expectedGeneration: session.generation,
    expectedRevision: session.revision,
    expectedState: session.status,
    expectedDispatchId: session.activeDispatchId,
  });
  const compacted = await compact.wait({ timeoutMs: 65000 });
  assert.equal(compacted.status, 'completed', JSON.stringify(compacted));
  const compactionTask = (await orch.tasks.list({ sessionId: session.id })).tasks.find(
    (task) => task.kind === 'compaction',
  );
  assert.ok(compactionTask, 'the compaction has a task');
  const manualCalls = calls.slice(before).filter((call) => call.kind === 'compact').length;
  const manualRecords = await records(compactionTask.id);
  evidence.manualCompact = { calls: calls.slice(before), records: manualRecords };
  assert.deepEqual(manualRecords, [
    { kind: 'main', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: MODEL },
    {
      kind: 'outside',
      input: 7000 * manualCalls,
      output: 700 * manualCalls,
      cacheRead: 0,
      cacheWrite: 300 * manualCalls,
      model: MODEL,
    },
  ]);
  evidence.cases.push('manual-compaction-recorded-under-the-session-model');
  evidence.status = 'passed';
} catch (error) {
  exitCode = 1;
  evidence.status = 'failed';
  evidence.error = String(error?.stack ?? error);
  console.error(error);
} finally {
  await orch.close({ mode: 'interrupt', timeoutMs: 5000 }).catch(() => {});
  await adapter.close().catch(() => {});
  server.close();
  evidence.finishedAt = new Date().toISOString();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.exit(exitCode);
