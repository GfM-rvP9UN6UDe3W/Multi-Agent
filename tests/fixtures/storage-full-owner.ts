import { createEngine, createFakeAdapter } from '../../packages/engine/src/index.ts';
import type { RuntimeAdapter, TaskSnapshot } from '../../packages/engine/src/types.ts';
import type { Store } from '../../packages/engine/src/store.ts';
const [workspace, stateDir, stage] = process.argv.slice(2);
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
let invocations = 0,
  store: Store,
  injected = false;
const base = createFakeAdapter({ result: 'x'.repeat(512 * 1024) });
const adapter: RuntimeAdapter = {
  ...base,
  async *execute(input) {
    invocations++;
    await gate;
    yield* base.execute(input);
  },
};
function fill() {
  const pages = (store.db.prepare('PRAGMA page_count').get() as any).page_count;
  store.db.exec(`PRAGMA max_page_count=${pages + 1}`);
  store.db.exec('CREATE TABLE IF NOT EXISTS full_fixture(data TEXT)');
  for (let index = 0; index < 64; index++)
    store.db.prepare('INSERT INTO full_fixture VALUES (?)').run('x'.repeat(1024 * 1024));
  throw new Error('SQLite fixture failed to exhaust its bounded page limit');
}
const engine = await createEngine({
  workspace: workspace!,
  stateDir: stateDir!,
  adapters: [adapter],
  storage: { emergencyBytes: 4096, minFreeBytes: 0 },
  storageFault: (point) => {
    if (stage === 'terminal' && point === 'terminal.before_commit') {
      injected = true;
      fill();
    }
  },
});
store = (engine as any).store;
const created = (await engine.call('tasks.create', {
  expectedStoreId: engine.storeId,
  idempotencyKey: 'K',
  spec: {
    goal: 'owned full fixture',
    runtime: { provider: 'fake', model: 'fake' },
    acceptance: { mode: 'human', criteria: ['review'] },
  },
})) as TaskSnapshot;
await new Promise((resolve) => setImmediate(resolve));
if (stage === 'after_send') {
  try {
    fill();
  } catch (error: any) {
    if (error.errcode !== 13) throw error;
    injected = true;
  }
}
release();
const deadline = performance.now() + 5000;
while ((engine as any).flights.size && performance.now() < deadline)
  await new Promise((resolve) => setTimeout(resolve, 5));
let code = '';
try {
  await engine.call('tasks.create', {
    expectedStoreId: engine.storeId,
    idempotencyKey: 'later',
    spec: {
      goal: 'must not run',
      runtime: { provider: 'fake', model: 'fake' },
      acceptance: { mode: 'human', criteria: ['review'] },
    },
  });
} catch (error: any) {
  code = error.code;
}
const status = ((await engine.call('tasks.get', { taskId: created.id })) as TaskSnapshot).status;
if (process.argv[5] === '--stdio') {
  const { startStdioHost } = await import('../../packages/cli/src/host.ts');
  await startStdioHost(engine).closed;
} else {
  let closeCode = '';
  try {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 });
  } catch (error: any) {
    closeCode = error.code;
  }
  console.log(
    JSON.stringify({
      injected,
      invocations,
      degraded: store.degraded,
      code,
      taskId: created.id,
      storeId: engine.storeId,
      status,
      closeCode,
      closed: store.isClosed,
    }),
  );
  // Public shutdown closes local resources without inventing a durable receipt.
  if ((engine as any).flights.size) throw new Error('Fixture resources did not end');
  store.close();
}
