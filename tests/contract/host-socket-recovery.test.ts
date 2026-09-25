import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectOrchestrator } from '../../packages/sdk-typescript/src/index.ts';

// SPEC-0025 S: a socket host that ended without closing leaves its socket file. The next host
// removes a socket that nobody listens on, and refuses anything else at its path.

const posix = process.platform !== 'win32';
const cli = fileURLToPath(new URL('../../packages/cli/src/main.ts', import.meta.url));
// Watchdogs only: they report a host that hangs, and do not require a host to be fast.
const OUTPUT_WATCHDOG_MS = 10_000;
const EXIT_WATCHDOG_MS = 30_000;

async function hostFiles(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-socket-recovery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'work'));
  await mkdir(join(root, 'state'), { mode: 0o700 });
  await mkdir(join(root, 'run'), { mode: 0o700 });
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
  return { config, socketPath: join(root, 'run', 'host.sock') };
}

function startHost(t: TestContext, config: string, socketPath: string) {
  const proc = spawn(process.execPath, [cli, 'host', '--config', config, '--socket', socketPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exited = once(proc, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await exited;
  });
  let stderr = '';
  proc.stderr.on('data', (chunk) => (stderr += chunk));
  return {
    proc,
    stderr: () => stderr,
    async waitFor(text: string) {
      const deadline = performance.now() + OUTPUT_WATCHDOG_MS;
      while (!stderr.includes(text)) {
        if (proc.exitCode !== null || proc.signalCode !== null)
          throw new Error(`The host exited before it wrote "${text}": ${stderr}`);
        if (performance.now() >= deadline)
          throw new Error(`The host did not write "${text}": ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async exit() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const [code, signal] = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`The host did not exit: ${stderr}`)),
              EXIT_WATCHDOG_MS,
            );
          }),
        ]);
        return { code, signal };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

test(
  '0025-S01 a socket left by a killed host is removed by the next host, which serves clients',
  { skip: !posix },
  async (t) => {
    const { config, socketPath } = await hostFiles(t);
    const killed = startHost(t, config, socketPath);
    await killed.waitFor('orchvia listening on');
    killed.proc.kill('SIGKILL');
    assert.deepEqual(await killed.exit(), { code: null, signal: 'SIGKILL' });
    assert.ok(existsSync(socketPath), 'the killed host left its socket');

    const next = startHost(t, config, socketPath);
    await next.waitFor('orchvia listening on');
    const client = await connectOrchestrator({ socketPath });
    try {
      assert.equal((await client.scheduler.get()).canDispatch, true);
    } finally {
      await client.close();
    }
    next.proc.kill('SIGTERM');
    assert.deepEqual(await next.exit(), { code: 0, signal: null }, next.stderr());
  },
);

test(
  '0025-S02 a host refuses a socket path on which another process listens, and removes nothing',
  { skip: !posix },
  async (t) => {
    const { config, socketPath } = await hostFiles(t);
    const other = createServer((socket) => {
      // The host's probe closes its connection at once; that is not this test's failure.
      socket.on('error', () => {});
      socket.end('other\n');
    });
    await new Promise<void>((resolve) => other.listen(socketPath, resolve));
    t.after(() => new Promise<void>((resolve) => other.close(() => resolve())));
    const host = startHost(t, config, socketPath);
    assert.deepEqual(await host.exit(), { code: 1, signal: null }, host.stderr());
    assert.match(host.stderr(), /SOCKET_IN_USE/);
    assert.match(host.stderr(), /accepts connections/);
    // The other process still owns its socket.
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(socketPath);
      let text = '';
      socket.on('data', (chunk) => (text += chunk));
      socket.on('end', () => resolve(text));
      socket.on('error', reject);
    });
    assert.equal(reply, 'other\n');
  },
);

test(
  '0025-S02 a host refuses a path that is not a socket, and removes nothing',
  { skip: !posix },
  async (t) => {
    const { config, socketPath } = await hostFiles(t);
    writeFileSync(socketPath, 'not a socket\n');
    const host = startHost(t, config, socketPath);
    assert.deepEqual(await host.exit(), { code: 1, signal: null }, host.stderr());
    assert.match(host.stderr(), /SOCKET_IN_USE/);
    assert.match(host.stderr(), /not a socket/);
    assert.equal(readFileSync(socketPath, 'utf8'), 'not a socket\n');
  },
);
