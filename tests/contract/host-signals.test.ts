import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

// SPEC-0023 S: from the moment a socket host accepts connections, SIGTERM, SIGINT and SIGHUP shut it
// down in order. Test-only preloads stall the host inside the two windows where a signal once
// ended it by the signal's default action.

const posix = process.platform !== 'win32';
const cli = fileURLToPath(new URL('../../packages/cli/src/main.ts', import.meta.url));
// Watchdogs only: they report a host that hangs, and do not require a host to be fast.
const OUTPUT_WATCHDOG_MS = 10_000;
const EXIT_WATCHDOG_MS = 30_000;

async function hostFiles(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orchvia-host-signals-')));
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
  return { config, socketPath: join(root, 'host.sock') };
}

function startHost(t: TestContext, config: string, socketPath: string, preload?: string) {
  const proc = spawn(
    process.execPath,
    [
      ...(preload ? ['--import', new URL(`../fixtures/${preload}`, import.meta.url).href] : []),
      cli,
      'host',
      '--config',
      config,
      '--socket',
      socketPath,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
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

for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const)
  test(
    `0023-S01 0023-S02 a host that stalls after its ready line shuts down in order on ${signal}`,
    { skip: !posix },
    async (t) => {
      const { config, socketPath } = await hostFiles(t);
      const host = startHost(t, config, socketPath, 'stall-after-ready.ts');
      await host.waitFor('orchvia listening on');
      host.proc.kill(signal);
      assert.deepEqual(await host.exit(), { code: 0, signal: null }, host.stderr());
      assert.equal(existsSync(socketPath), false, 'the host removed its socket');
    },
  );

test(
  '0023-S03 a stop signal while the socket host starts shuts it down in order, without a ready line',
  { skip: !posix },
  async (t) => {
    const { config, socketPath } = await hostFiles(t);
    const host = startHost(t, config, socketPath, 'stall-before-ready.ts');
    await host.waitFor('fixture: socket accepts connections');
    host.proc.kill('SIGTERM');
    assert.deepEqual(await host.exit(), { code: 0, signal: null }, host.stderr());
    assert.doesNotMatch(host.stderr(), /orchvia listening on/);
    assert.equal(existsSync(socketPath), false, 'the host removed its socket');
    // The state lock and the socket path are free for the next host.
    const next = startHost(t, config, socketPath);
    await next.waitFor('orchvia listening on');
    next.proc.kill('SIGTERM');
    assert.deepEqual(await next.exit(), { code: 0, signal: null }, next.stderr());
  },
);
