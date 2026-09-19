import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { connectOrchestrator } from '../../packages/sdk-typescript/src/index.ts';

const cli = fileURLToPath(new URL('../../packages/cli/src/main.ts', import.meta.url));
async function command(args: string[]) {
  const proc = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '';
  proc.stdout.on('data', (b) => {
    stdout += b;
  });
  proc.stderr.on('data', (b) => {
    stderr += b;
  });
  const [code] = await once(proc, 'exit');
  return { code, stdout, stderr };
}
async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-cli-test-')));
  await mkdir(join(root, 'workspace'));
  await mkdir(join(root, 'state'));
  const config = {
    workspace: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    providers: { fake: { model: 'fake-model', result: 'Protocol fixture result' } },
  };
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, config, configPath };
}
async function stop(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exit = once(proc, 'exit');
  proc.kill('SIGTERM');
  const timer = setTimeout(() => proc.kill('SIGKILL'), 2000);
  await exit;
  clearTimeout(timer);
}

test(
  'AC12 real CLI socket + TS SDK create/events/approve/terminal; closing client preserves host',
  { timeout: 15000 },
  async (t) => {
    const { root, config, configPath } = await fixture(t);
    const offline = await command(['doctor', '--config', configPath]);
    assert.equal(offline.code, 0, offline.stderr);
    assert.equal(JSON.parse(offline.stdout).runtimeAcceptance, 'not_run');
    assert.deepEqual(await readdir(config.stateDir), []);
    const socketPath = join(root, 'host.sock');
    const proc = spawn(process.execPath, [
      cli,
      'host',
      '--config',
      configPath,
      '--socket',
      socketPath,
    ]);
    t.after(() => stop(proc));
    let stdout = '',
      stderr = '';
    proc.stdout.on('data', (b) => {
      stdout += b;
    });
    const ready = new Promise<void>((resolve, reject) => {
      proc.stderr.on('data', (b) => {
        stderr += b;
        if (stderr.includes('listening on')) resolve();
      });
      proc.once('exit', (code) => reject(new Error(`Host exited ${code}: ${stderr}`)));
    });
    await ready;
    const taskPath = join(root, 'task.json');
    await writeFile(
      taskPath,
      JSON.stringify({
        goal: 'Read-only contract',
        runtime: { provider: 'fake', model: 'fake-model' },
        acceptance: { mode: 'human', criteria: ['review'] },
      }),
    );
    const submit = await command([
      'submit',
      '--socket',
      socketPath,
      '--task',
      taskPath,
      '--idempotency-key',
      'cli-task',
    ]);
    assert.equal(submit.code, 0, submit.stderr);
    const task = JSON.parse(submit.stdout);
    const client = await connectOrchestrator({ socketPath });
    t.after(() => client.close());
    for await (const event of client.events({
      taskId: task.id,
      signal: AbortSignal.timeout(3000),
    })) {
      if (event.type !== 'approval.requested') continue;
      const approval = await client.approvals.get(String(event.data.approvalId));
      const approve = await command([
        'approve',
        '--socket',
        socketPath,
        '--approval',
        approval.approvalId,
        '--revision',
        String(approval.revision),
        '--decision',
        'approve',
        '--idempotency-key',
        'cli-approve',
      ]);
      assert.equal(approve.code, 0, approve.stderr);
      assert.equal(JSON.parse(approve.stdout).status, 'completed');
      break;
    }
    const status = await command(['status', '--socket', socketPath, '--task', task.id]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).status, 'completed');
    await client.close();
    const online = await command(['doctor', '--socket', socketPath]);
    assert.equal(online.code, 0, online.stderr);
    assert.equal(JSON.parse(online.stdout).protocolVersion, '1.0');
    assert.equal(stdout, '', 'Socket host must keep stdout clean');
  },
);

test('CLI rejects unsupported commands, implicit fake, arbitrary adapter module and unknown flags', async (t) => {
  const { config, configPath } = await fixture(t);
  const unknown = await command(['attach']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /UNSUPPORTED_COMMAND/);
  assert.equal(unknown.stdout, '');
  for (const providers of [
    {},
    { fake: { model: 'fake-model', adapter: 'https://untrusted.invalid/code.js' } },
    { codex: { model: 'test', executable: '/ignored/path' } },
    { claude: { model: 'test', auth: { mode: 'env' } } },
    { codex: { model: 'test', unknownOption: true } },
  ]) {
    await writeFile(configPath, JSON.stringify({ ...config, providers }));
    const result = await command(['doctor', '--config', configPath]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /INVALID_CONFIG/);
  }
  const flags = await command([
    'host',
    '--config',
    configPath,
    '--stdio',
    '--socket',
    '/tmp/unused.sock',
  ]);
  assert.equal(flags.code, 1);
  assert.match(flags.stderr, /mutually exclusive/);
});

test('doctor rejects limits and deadlines that the engine cannot accept', async (t) => {
  const { config, configPath } = await fixture(t);
  for (const invalid of [
    { limits: { maxActiveSessions: 3 } },
    { limits: { maxTurnsPerTask: 1001 } },
    { approvalTtlMs: 0.5 },
    { approvalTtlMs: 604800001 },
    { shutdown: { timeoutMs: 0.5 } },
    { shutdown: { timeoutMs: 3600001 } },
  ]) {
    await writeFile(configPath, JSON.stringify({ ...config, ...invalid }));
    const result = await command(['doctor', '--config', configPath]);
    assert.equal(result.code, 1, JSON.stringify(invalid));
    assert.match(result.stderr, /INVALID_CONFIG/);
  }
});
