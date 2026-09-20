import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createClaudeAdapter,
  type ClaudeQueryFactory,
} from '../../packages/adapter-claude/src/index.ts';
import type { RuntimeEvent } from '../../packages/engine/src/types.ts';
import { interruptChild } from './claude-interrupt-runtime.ts';

// Explicit opt-in transport check. The installed SDK talks only to our offline child.
const modulePath = process.argv[2];
if (!modulePath) throw new Error('Pass the absolute installed native SDK module path');
const sdk = (await import(pathToFileURL(modulePath).href)) as { query: ClaudeQueryFactory };
const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-native-interrupt-')));
const workspace = join(root, 'workspace'),
  stateDir = join(root, 'state'),
  audit = join(root, 'audit');
await mkdir(workspace);
await mkdir(stateDir);
const control = new AbortController();
const events: RuntimeEvent[] = [];
const adapter = createClaudeAdapter({
  requestTimeoutMs: 3000,
  turnTimeoutMs: 5000,
  interruptTimeoutMs: 1000,
  query: (request) =>
    sdk.query({
      ...request,
      options: {
        ...request.options,
        spawnClaudeCodeProcess: (native) =>
          request.options.spawnClaudeCodeProcess({
            command: process.execPath,
            args: [interruptChild, 'startup', request.options.resume ?? '', audit],
            cwd: workspace,
            env: {},
            signal: native.signal,
          }),
      },
    }),
});
try {
  for await (const event of adapter.execute({
    taskId: 'task',
    sessionId: 'session',
    dispatchId: 'dispatch',
    providerSessionId: null,
    model: 'offline',
    workspace,
    stateDir,
    prompt: 'Hold offline',
    permissionProfile: 'read-only',
    signal: control.signal,
  })) {
    events.push(event);
    if (event.type === 'accepted') control.abort();
  }
  assert.equal(events.at(-1)?.type, 'interrupted', JSON.stringify(events));
  const records = (await readFile(audit, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(records.filter((item) => item.kind === 'prompt').length, 1);
  assert.deepEqual(
    records.filter((item) => item.subtype === 'interrupt').map((item) => item.started),
    [true],
  );
  assert.equal(adapter.hasActiveResources('session'), false);
  process.stdout.write(
    JSON.stringify({
      transport: 'installed-native-sdk',
      subprocess: 'offline-fixture',
      interrupted: true,
      prompts: 1,
      interruptRequests: 1,
      modelCalls: 0,
    }) + '\n',
  );
} finally {
  await adapter.close();
  await rm(root, { recursive: true, force: true });
}
