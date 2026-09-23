import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// SPEC-0011 R10: the test commands load the reserve guard, so a test engine must use a 4 KiB
// emergency reserve instead of the 256 MiB production default.
const guard = fileURLToPath(new URL('../fixtures/reserve-guard.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../../packages/cli/src/main.ts', import.meta.url));

/**
 * Starts a Node process that loads only the guard, as a test file does, and has it start a stdio
 * CLI host whose input ends at once. The host is guarded only if the guard passes itself on through
 * NODE_OPTIONS.
 */
async function hostUnderGuard(t: TestContext, storage?: { emergencyBytes: number }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-reserve-guard-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'workspace'));
  await mkdir(join(root, 'state'));
  const config = join(root, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      workspace: join(root, 'workspace'),
      stateDir: join(root, 'state'),
      providers: { fake: { model: 'fake-model' } },
      ...(storage ? { storage } : {}),
    }),
  );
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const host = [cli, 'host', '--config', config, '--stdio'];
  const testFile = spawnSync(
    process.execPath,
    [
      '--import',
      guard,
      '--input-type=module',
      '-e',
      `import { spawnSync } from 'node:child_process';
const host = spawnSync(process.execPath, ${JSON.stringify(host)}, { input: '', encoding: 'utf8' });
process.stdout.write(JSON.stringify({ status: host.status, stderr: host.stderr }));`,
    ],
    { encoding: 'utf8', env, timeout: 60_000 },
  );
  assert.equal(testFile.status, 0, testFile.stderr);
  const reserve = await stat(join(root, 'state', 'emergency.reserve')).catch(() => undefined);
  const result = JSON.parse(testFile.stdout) as { status: number | null; stderr: string };
  return { ...result, reserveBytes: reserve?.size };
}

test('0011-R10 a CLI host started by a test cannot write the 256 MiB default reserve', async (t) => {
  const host = await hostUnderGuard(t);
  assert.equal(host.status, 1, host.stderr);
  assert.match(host.stderr, /TEST_RESERVE_GUARD/);
  assert.match(host.stderr, /emergencyBytes/);
  assert.equal(host.reserveBytes, 0, 'The guard stops the reserve before its first write');
});

test('0011-R10 a 4 KiB test reserve passes the guard', async (t) => {
  const host = await hostUnderGuard(t, { emergencyBytes: 4096 });
  assert.equal(host.status, 0, host.stderr);
  assert.equal(host.reserveBytes, 4096);
});
