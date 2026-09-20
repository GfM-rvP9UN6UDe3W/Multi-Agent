import { createInterface } from 'node:readline';
import { createEngine } from '../../packages/engine/src/index.ts';
import { createOfflineHostFixture } from '../../packages/engine/src/testing-host.ts';
import { startUnixHost } from '../../packages/cli/src/host.ts';
import type { SessionSnapshot, TaskSnapshot } from '../../packages/engine/src/types.ts';

const [mode, workspace, stateDir, socketPath] = process.argv.slice(2);
const fixture = createOfflineHostFixture();
const engine = await createEngine({ workspace, stateDir, adapters: [fixture.adapter] });
if (mode === 'crash') {
  const task = (await engine.call('tasks.create', {
    spec: {
      goal: 'Crash after host submission without a durable host binding',
      runtime: { provider: fixture.adapter.provider, model: 'offline-host-model' },
      acceptance: { mode: 'human', criteria: ['Explicit fixture review'] },
    },
    idempotencyKey: 'crash-fixture',
  })) as TaskSnapshot;
  while (fixture.submissions().length === 0) await new Promise<void>((r) => setImmediate(r));
  const input = fixture.submissions()[0];
  await fixture.act(input.dispatchId, 'accept');
  let session: SessionSnapshot;
  do {
    await new Promise<void>((r) => setImmediate(r));
    session = (await engine.call('sessions.get', { sessionId: task.sessionId })) as SessionSnapshot;
  } while (!session.providerSessionId);
  process.stdout.write(
    JSON.stringify({
      kind: 'dispatch',
      taskId: task.id,
      sessionId: session.id,
      dispatchId: input.dispatchId,
      nativeId: session.providerSessionId,
    }) + '\n',
  );
  // The parent deliberately kills only this owned fixture process, without engine.close().
} else if (mode === 'serve') {
  const host = await startUnixHost(engine, { socketPath });
  const input = createInterface({ input: process.stdin });
  input.on('line', (command) => {
    if (command === 'inspect')
      process.stdout.write(
        JSON.stringify({ kind: 'inspect', submissions: fixture.submissions().length }) + '\n',
      );
    if (command === 'close')
      void host.close({ mode: 'interrupt', timeoutMs: 2000 }).then(() => input.close());
  });
  process.stdout.write(
    JSON.stringify({ kind: 'ready', submissions: fixture.submissions().length }) + '\n',
  );
  await host.closed;
} else {
  await engine.close();
  throw new Error('Unknown host-runtime fixture mode');
}
