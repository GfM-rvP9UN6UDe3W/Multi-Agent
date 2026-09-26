import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createEngine, createFakeAdapter } from '../fixtures/engine.ts';
import type { EngineConfig } from '../../packages/engine/src/types.ts';

// SPEC-0028 W: the emergency reserve is written without blocking the event loop, and is complete
// and durable when createEngine resolves.

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orch-reserve-')));
  await mkdir(join(root, 'workspace'));
  const stateDir = join(root, 'state');
  const config: EngineConfig = {
    workspace: join(root, 'workspace'),
    stateDir,
    adapters: [createFakeAdapter()],
    storage: { emergencyBytes: 4096, minFreeBytes: 0 },
  };
  return {
    config,
    stateDir,
    reserve: join(stateDir, 'emergency.reserve'),
    partial: join(stateDir, 'emergency.reserve.partial'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('0028-W01 the event loop runs while createEngine writes the reserve', async () => {
  const f = await setup();
  try {
    let ran = false;
    let completeWhenRan: boolean | undefined;
    setImmediate(() => {
      ran = true;
      completeWhenRan = existsSync(f.reserve);
    });
    const engine = await createEngine(f.config);
    try {
      assert.equal(ran, true, 'a callback scheduled before createEngine ran before it resolved');
      assert.equal(completeWhenRan, false, 'the reserve was not complete when the callback ran');
    } finally {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    }
  } finally {
    await f.cleanup();
  }
});

/** Records the reserve's file operations through fs.promises while `run` runs. */
async function traced(stateDir: string, run: () => Promise<void>): Promise<string[]> {
  const trace: string[] = [];
  const promises = fs.promises as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const { open, rename } = promises;
  promises.open = async (...args: unknown[]) => {
    const handle = (await open(...args)) as Record<string, (...rest: unknown[]) => unknown>;
    const path = String(args[0]);
    const name = path === stateDir ? 'stateDir' : basename(path);
    if (name === 'stateDir' || name.startsWith('emergency.reserve'))
      for (const method of ['write', 'datasync', 'sync', 'close']) {
        const original = handle[method]!;
        handle[method] = (...rest: unknown[]) => {
          trace.push(`${name}:${method}`);
          return original.apply(handle, rest);
        };
      }
    return handle;
  };
  promises.rename = async (...args: unknown[]) => {
    trace.push(`rename:${basename(String(args[0]))}>${basename(String(args[1]))}`);
    return rename(...args);
  };
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    promises.open = open;
    promises.rename = rename;
    syncBuiltinESMExports();
  }
  return trace;
}

test('0028-W02 when createEngine resolves, the reserve is complete and synced with its directory', async () => {
  const f = await setup();
  try {
    let engine: Awaited<ReturnType<typeof createEngine>> | undefined;
    const trace = await traced(f.stateDir, async () => {
      engine = await createEngine(f.config);
      assert.equal(statSync(f.reserve).size, 4096, 'the reserve has its full size');
      assert.equal(existsSync(f.partial), false, 'no partial file is left');
    });
    await engine!.close({ mode: 'interrupt', timeoutMs: 1000 });
    const at = (step: string) => {
      const index = trace.indexOf(step);
      assert.ok(index >= 0, `${step} in ${JSON.stringify(trace)}`);
      return index;
    };
    assert.ok(at('emergency.reserve.partial:write') < at('emergency.reserve.partial:datasync'));
    assert.ok(
      at('emergency.reserve.partial:datasync') <
        at('rename:emergency.reserve.partial>emergency.reserve'),
    );
    assert.ok(at('rename:emergency.reserve.partial>emergency.reserve') < at('stateDir:sync'));
  } finally {
    await f.cleanup();
  }
});

test('0028-W02 a partial reserve left by an earlier start is replaced by a complete one', async () => {
  const f = await setup();
  try {
    await mkdir(f.stateDir, { mode: 0o700 });
    await writeFile(f.partial, 'x'.repeat(100), { mode: 0o600 });
    const engine = await createEngine(f.config);
    try {
      assert.equal(existsSync(f.partial), false);
      assert.equal(statSync(f.reserve).size, 4096);
    } finally {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    }
  } finally {
    await f.cleanup();
  }
});

test('0028-W02 storage.configure writes a missing reserve before it returns', async () => {
  const f = await setup();
  try {
    const engine = await createEngine({
      ...f.config,
      storage: { emergencyBytes: 0, minFreeBytes: 0 },
    });
    try {
      assert.equal(existsSync(f.reserve), false);
      await engine.call(
        'storage.configure',
        { policy: { emergencyBytes: 4096 }, idempotencyKey: 'reserve' },
        { owner: true },
      );
      assert.equal(statSync(f.reserve).size, 4096);
      assert.equal(existsSync(f.partial), false);
    } finally {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
    }
  } finally {
    await f.cleanup();
  }
});

test(
  '0028-W02 while a reserve is written, admission refuses, and a close waits for the write',
  { timeout: 10_000 },
  async () => {
    const f = await setup();
    const promises = fs.promises as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const { open } = promises;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let syncing!: () => void;
    const started = new Promise<void>((resolve) => (syncing = resolve));
    // The reserve's datasync waits until the test releases it.
    promises.open = async (...args: unknown[]) => {
      const handle = (await open(...args)) as Record<string, (...rest: unknown[]) => unknown>;
      if (basename(String(args[0])) === 'emergency.reserve.partial') {
        const datasync = handle.datasync!;
        handle.datasync = async () => {
          syncing();
          await held;
          return datasync.call(handle);
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      const engine = await createEngine({
        ...f.config,
        storage: { emergencyBytes: 0, minFreeBytes: 0 },
      });
      const configure = engine.call(
        'storage.configure',
        { policy: { emergencyBytes: 4096 }, idempotencyKey: 'reserve' },
        { owner: true },
      );
      await started;
      await assert.rejects(
        engine.call('tasks.create', {
          spec: {
            goal: 'Not before the reserve is complete',
            runtime: { provider: 'fake', model: 'fixture' },
            acceptance: { mode: 'human', criteria: ['Review'] },
          },
          idempotencyKey: 'early',
        }),
        { code: 'STORAGE_BACKPRESSURE' },
      );
      let closed = false;
      const closing = engine.close({ mode: 'drain', timeoutMs: 5000 }).then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(closed, false, 'the close waits for the reserve');
      release();
      await Promise.all([configure, closing]);
      assert.equal(statSync(f.reserve).size, 4096);
      assert.equal(existsSync(f.partial), false);
    } finally {
      release();
      promises.open = open;
      syncBuiltinESMExports();
      await f.cleanup();
    }
  },
);
