import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createClaudeMcpServer,
  type ClaudeMcpDependencies,
} from '../../packages/adapter-claude/src/index.ts';
import { ORCHESTRATION_TOOLS, type RuntimeTools } from '../../packages/engine/src/tools.ts';
import type { Json } from '../../packages/engine/src/types.ts';
import { VERSION } from '../../packages/engine/src/version.ts';
import { connectMcp } from '../fixtures/mcp-transport.ts';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const served = JSON.parse(JSON.stringify(ORCHESTRATION_TOOLS));
const names = ORCHESTRATION_TOOLS.map((definition) => definition.name);

function recording(
  answer: (name: string, request: unknown) => Json = (name, request) => ({
    name,
    request: request as Json,
  }),
) {
  const calls: { name: string; request: unknown }[] = [];
  const tools: RuntimeTools = {
    definitions: ORCHESTRATION_TOOLS,
    async call(name, request) {
      calls.push({ name, request });
      return answer(name, request);
    },
  };
  return { tools, calls };
}
const initialize = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'test', version: '1' },
};
const toolError = (text: string) => ({ isError: true, content: [{ type: 'text', text }] });

test('0026-Z01 tools/list serves the JSON Schemas of the bound tools', async () => {
  const { tools } = recording();
  const all = await connectMcp(await createClaudeMcpServer(tools));
  await all.request('initialize', initialize);
  assert.deepEqual((await all.request('tools/list')).result, { tools: served });
  const one = await connectMcp(
    await createClaudeMcpServer({ ...tools, definitions: [ORCHESTRATION_TOOLS[2]!] }),
  );
  await one.request('initialize', initialize);
  assert.deepEqual((await one.request('tools/list')).result, { tools: [served[2]] });
});

test('0026-Z01 the installed Claude SDK lists and calls the tools through an offline Claude process', async () => {
  // The offline process asserts that tools/list returns exactly ORCHESTRATION_TOOLS.
  const sdk = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  const { stdout } = await run(
    process.execPath,
    [join(root, 'tests/fixtures/claude-native-mcp-smoke.ts'), sdk],
    { timeout: 20_000 },
  );
  assert.deepEqual(JSON.parse(stdout).tools, names);
});

test('0026-Z06 the installed Claude SDK runs the four tools against an actual engine with the adapter-owned server', async () => {
  const sdk = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  const { stdout } = await run(
    process.execPath,
    [join(root, 'tests/fixtures/native-mcp-engine-smoke.ts'), 'claude', sdk],
    { timeout: 20_000 },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.actualEngine, true);
  assert.equal(result.tools, 4);
});

test('0026-Z02 the server needs neither Zod nor the Claude SDK', async () => {
  const { stdout } = await run(
    process.execPath,
    [join(root, 'tests/fixtures/claude-mcp-without-peers.ts')],
    { timeout: 20_000 },
  );
  assert.deepEqual(JSON.parse(stdout), { listed: names, calls: ['work_read'] });
});

test('0026-Z03 tools/call calls the bound tool and answers a failure with a code only', async () => {
  const { tools, calls } = recording((name, request) => {
    const kind = (request as { kind?: string }).kind;
    if (kind === 'coded')
      throw Object.assign(new Error('secret /private/state'), { code: 'NOT_FOUND' });
    if (kind === 'plain') throw new Error('secret /private/state');
    if (kind === 'lowercase') throw Object.assign(new Error('secret'), { code: 'not_found' });
    return { name, request: request as Json };
  });
  const mcp = await connectMcp(await createClaudeMcpServer(tools));
  await mcp.request('initialize', initialize);
  const call = async (params: unknown) => (await mcp.request('tools/call', params)).result;
  for (const name of names) {
    const result = await call({ name, arguments: { request: { id: name } } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.content[0].text), { name, request: { id: name } });
  }
  assert.deepEqual(
    calls.map((call) => call.request),
    names.map((id) => ({ id })),
  );
  const coded = { name: 'work_read', arguments: { request: { kind: 'coded' } } };
  assert.deepEqual(await call(coded), toolError('NOT_FOUND'));
  assert.deepEqual(
    await call({ name: 'work_read', arguments: { request: { kind: 'plain' } } }),
    toolError('TOOL_FAILED'),
  );
  assert.deepEqual(
    await call({ name: 'work_read', arguments: { request: { kind: 'lowercase' } } }),
    toolError('TOOL_FAILED'),
  );
  const made = calls.length;
  assert.deepEqual(
    await call({ name: 'approvals.decide', arguments: { request: {} } }),
    toolError('UNKNOWN_TOOL'),
  );
  for (const args of [
    undefined,
    {},
    { request: 'task' },
    { request: [] },
    { request: null },
    { request: {}, actor: 'owner' },
  ])
    assert.deepEqual(
      await call({ name: 'work_read', ...(args === undefined ? {} : { arguments: args }) }),
      toolError('INVALID_REQUEST'),
      JSON.stringify(args),
    );
  // A tool that exists but is not bound to this server is unknown to it.
  const reader = await connectMcp(
    await createClaudeMcpServer({ ...tools, definitions: [ORCHESTRATION_TOOLS[2]!] }),
  );
  assert.deepEqual(
    (
      await reader.request('tools/call', {
        name: 'work_send',
        arguments: { request: {} },
      })
    ).result,
    toolError('UNKNOWN_TOOL'),
  );
  assert.equal(calls.length, made);
});

test('0026-Z04 initialize keeps a known protocol version, and other methods are answered', async () => {
  const mcp = await connectMcp(await createClaudeMcpServer(recording().tools));
  const answer = async (protocolVersion: string) =>
    (await mcp.request('initialize', { ...initialize, protocolVersion })).result;
  for (const version of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'])
    assert.deepEqual(await answer(version), {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'agent_orch', version: VERSION },
    });
  assert.equal((await answer('2099-01-01')).protocolVersion, '2025-11-25');
  assert.deepEqual((await mcp.request('ping')).result, {});
  assert.equal((await mcp.request('resources/list')).error?.code, -32601);
  const before = mcp.sent.length;
  mcp.notify('notifications/initialized');
  mcp.notify('notifications/cancelled', { requestId: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mcp.sent.length, before);
});

test('0026-Z04 the Codex bridge answers initialize through the same code', async () => {
  const child = spawn(process.execPath, [join(root, 'packages/engine/src/tool-bridge.ts')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const answer = async (protocolVersion: string) => {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion },
      }) + '\n',
    );
    const line = await lines.next();
    assert.equal(line.done, false);
    return JSON.parse(line.value!).result.protocolVersion;
  };
  try {
    assert.equal(await answer('2025-11-25'), '2025-11-25');
    assert.equal(await answer('2025-06-18'), '2025-06-18');
    assert.equal(await answer('2099-01-01'), '2025-11-25');
  } finally {
    child.stdin.end();
    child.kill();
  }
});

test('0026-Z05 close() closes the transport that the server is connected to', async () => {
  const mcp = await connectMcp(await createClaudeMcpServer(recording().tools));
  assert.equal(mcp.closed, false);
  await mcp.close();
  assert.equal(mcp.closed, true);
});

test("0026-Z07 a 0.1.2 host's SDK and Zod are accepted and ignored", async () => {
  const legacy: ClaudeMcpDependencies = { sdk: {}, zod: {} };
  const mcp = await connectMcp(await createClaudeMcpServer(recording().tools, legacy));
  await mcp.request('initialize', initialize);
  assert.deepEqual((await mcp.request('tools/list')).result, { tools: served });
});

test('0026-Z08 no package declares Zod and no source imports it', async () => {
  const packages = await readdir(join(root, 'packages'));
  for (const path of ['package.json', ...packages.map((name) => `packages/${name}/package.json`)]) {
    const manifest = JSON.parse(await readFile(join(root, path), 'utf8'));
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'peerDependenciesMeta',
      'optionalDependencies',
    ])
      assert.equal(manifest[field]?.zod, undefined, `${path} ${field}`);
  }
  const imports = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]zod(?:\/[^'"]*)?['"]/;
  for (const directory of [
    ...packages.map((name) => `packages/${name}/src`),
    'scripts',
    'tests/fixtures',
    'examples',
  ])
    for (const file of await readdir(join(root, directory), { recursive: true }))
      if (/\.(?:ts|mjs|js|cjs)$/.test(file))
        assert.doesNotMatch(
          await readFile(join(root, directory, file), 'utf8'),
          imports,
          `${directory}/${file}`,
        );
});
