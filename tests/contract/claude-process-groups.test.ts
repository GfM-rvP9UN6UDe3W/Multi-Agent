import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createClaudeAdapter,
  processGroupsStopped,
  type ClaudeQueryRequest,
} from '../../packages/adapter-claude/src/index.ts';
import type {
  ExecutionEvidence,
  RuntimeEvent,
  RuntimeStopContext,
} from '../../packages/engine/src/types.ts';

// SPEC-0023 P: the stop observer learns which processes a dispatch started, and can check that
// none of them, nor their descendants, is left.

const posix = process.platform !== 'win32';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() >= end) throw new Error('Fixture condition timed out');
    await delay(10);
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const processGroupOf = (pid: number) =>
  Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());

// A Claude stand-in that starts a grandchild. A stubborn one and its grandchild ignore SIGTERM.
const CLAUDE = String.raw`
const { spawn } = require('node:child_process');
const stubborn = process.argv[1] === 'stubborn';
if (stubborn) process.on('SIGTERM', () => {});
const grandchild = spawn(process.execPath, ['-e', (stubborn ? 'process.on("SIGTERM", () => {}); ' : '') + 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.stdout.write(JSON.stringify({ grandchild: grandchild.pid }) + '\n');
process.stdin.resume();
if (!stubborn) process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1000);
`;

function groupClaude(t: any, { stubborn = false, cleanupTimeoutMs = 2000 } = {}) {
  const state: {
    child?: ChildProcessWithoutNullStreams;
    grandchild?: number;
    context?: RuntimeStopContext;
  } = {};
  t.after(() => {
    for (const pid of [state.child?.pid, state.grandchild])
      if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
  });
  const adapter = createClaudeAdapter({
    extendOptions: () => ({}),
    cleanupTimeoutMs,
    observeExecutionStop: (context) => {
      state.context = context;
      return processGroupsStopped(context);
    },
    query: (request: ClaudeQueryRequest) => {
      const child = request.options.spawnClaudeCodeProcess({
        command: process.execPath,
        args: ['-e', CLAUDE, stubborn ? 'stubborn' : 'plain'],
        cwd: request.options.cwd,
        env: {},
        signal: new AbortController().signal,
      });
      state.child = child;
      const grandchild = new Promise<number>((resolve) => {
        let buffer = '';
        child.stdout.on('data', (chunk) => {
          buffer += chunk;
          if (buffer.includes('\n')) resolve(JSON.parse(buffer.split('\n')[0]!).grandchild);
        });
      });
      return {
        close() {
          if (!stubborn) child.stdin.end();
        },
        async *[Symbol.asyncIterator]() {
          state.grandchild = await grandchild;
          yield { type: 'system', subtype: 'init', session_id: 'native' };
          yield { type: 'result', subtype: 'success', session_id: 'native', result: 'done' };
        },
      };
    },
  });
  return { adapter, state };
}

async function run(adapter: ReturnType<typeof createClaudeAdapter>, workspace: string) {
  const evidence: ExecutionEvidence[] = [];
  const events: RuntimeEvent[] = [];
  for await (const event of adapter.execute({
    taskId: 'group-task',
    sessionId: 'group-session',
    dispatchId: 'group-dispatch',
    providerSessionId: null,
    model: 'fixture',
    workspace,
    stateDir: '/tmp/unused',
    prompt: 'offline fixture',
    permissionProfile: 'read-only',
    signal: new AbortController().signal,
    reportExecutionEvidence: (item) => evidence.push(item),
  }))
    events.push(event);
  return { events, evidence };
}

test(
  '0023-P01 0023-P02 the stop context lists the Claude process, which leads a group that its descendants share',
  { skip: !posix },
  async (t) => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-groups-')));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const { adapter, state } = groupClaude(t);
    await run(adapter, workspace);
    const pid = state.child!.pid!;
    assert.deepEqual(state.context?.processes, [{ pid, processGroupId: pid }]);
    assert.equal(processGroupOf(state.grandchild!), pid);
    await adapter.close().catch(() => {});
  },
);

test(
  '0023-P03 processGroupsStopped is true only when no member of the listed groups is left',
  { skip: !posix },
  async (t) => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-groups-')));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const { adapter, state } = groupClaude(t);
    await run(adapter, workspace);
    await until(() => !alive(state.child!.pid!));
    // The Claude process exited, but its grandchild still runs in its group.
    assert.equal(processGroupsStopped(state.context!), false);
    process.kill(state.grandchild!, 'SIGKILL');
    await until(() => !alive(state.grandchild!));
    assert.equal(processGroupsStopped(state.context!), true);
    assert.equal(processGroupsStopped({}), false);
    assert.equal(processGroupsStopped({ processes: [] }), false);
    await adapter.close().catch(() => {});
  },
);

test('0023-P03 only "no such process group" counts as stopped', () => {
  const context = { processes: [{ pid: 4242, processGroupId: 4242 }] };
  const failing = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  assert.equal(processGroupsStopped(context, failing('ESRCH')), true);
  assert.equal(processGroupsStopped(context, failing('EPERM')), false);
  assert.equal(processGroupsStopped(context, failing('EINVAL')), false);
  assert.equal(
    processGroupsStopped(context, () => true),
    false,
  );
});

test(
  '0023-P04 a forced cleanup ends the whole group, with SIGKILL when SIGTERM is ignored',
  { skip: !posix },
  async (t) => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-groups-')));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const { adapter, state } = groupClaude(t, { stubborn: true, cleanupTimeoutMs: 300 });
    await run(adapter, workspace);
    await until(() => !alive(state.child!.pid!) && !alive(state.grandchild!), 3000);
    await adapter.close();
  },
);

test('0023-P05 orchvia host shuts down in order on SIGHUP', { skip: !posix }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-sighup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'work'));
  await mkdir(join(root, 'state'), { mode: 0o700 });
  const config = join(root, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      workspace: join(root, 'work'),
      stateDir: join(root, 'state'),
      providers: { fake: { model: 'fake-model' } },
      storage: { emergencyBytes: 4096 },
    }),
  );
  const cli = fileURLToPath(new URL('../../packages/cli/src/main.ts', import.meta.url));
  const host = spawn(
    process.execPath,
    [cli, 'host', '--config', config, '--socket', join(root, 'host.sock')],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  t.after(() => {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
  });
  let stderr = '';
  host.stderr.on('data', (chunk) => (stderr += chunk));
  await until(() => stderr.includes('listening on'), 10_000);
  const exited = once(host, 'exit');
  host.kill('SIGHUP');
  const [code, signal] = await exited;
  assert.deepEqual({ code, signal }, { code: 0, signal: null }, stderr);
});
