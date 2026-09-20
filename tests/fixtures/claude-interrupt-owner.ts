import { createInterface } from 'node:readline';
import { createEngine } from '../../packages/engine/src/index.ts';
import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import { startUnixHost } from '../../packages/cli/src/host.ts';
import { offlineInterruptQuery } from './claude-interrupt-runtime.ts';

const [workspace, stateDir, socketPath, audit, mode = 'startup'] = process.argv.slice(2);
const engine = await createEngine({
  workspace,
  stateDir,
  timeouts: { interruptMs: mode === 'late' ? 35 : 1000 },
  adapters: [
    createClaudeAdapter({ query: offlineInterruptQuery(mode, audit), interruptTimeoutMs: 1000 }),
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
