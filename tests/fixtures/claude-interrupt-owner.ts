import { createInterface } from 'node:readline';
import { createEngine } from './engine.ts';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import { startUnixHost } from '../../packages/cli/src/host.ts';
import { offlineInterruptQuery } from './claude-interrupt-runtime.ts';

const [workspace, stateDir, socketPath, audit, mode = 'startup'] = process.argv.slice(2);
const engine = await createEngine({
  workspace,
  stateDir,
  // Functional cross-process scenarios allow startup, native stop and durable settlement.
  // The late-terminal scenario independently retains its deliberately short deadline.
  timeouts: { interruptMs: mode === 'late' ? 35 : 3000 },
  adapters: [
    createClaudeAdapter({
      query: offlineInterruptQuery(mode, audit),
      interruptTimeoutMs: mode === 'late' ? 1000 : 3000,
    }),
  ],
});
const host = await startUnixHost(engine, { socketPath });
process.stdout.write(JSON.stringify({ ready: true }) + '\n');
const reader = createInterface({ input: process.stdin });
reader.on('line', (line) => {
  if (line === 'close')
    void host.close({ mode: 'drain', timeoutMs: 1000 }).then(() => reader.close());
});
await host.closed;
