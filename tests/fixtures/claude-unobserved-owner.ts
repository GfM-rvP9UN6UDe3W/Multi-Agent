import { createClaudeAdapter } from '../../packages/adapter-claude/src/index.ts';
import { startStdioHost } from '../../packages/cli/src/host.ts';
import { createEngine, createFakeAdapter } from '../../packages/engine/src/index.ts';

// Offline SDK seam: deliberately omits spawn observation, without creating any hidden process.
const claude = createClaudeAdapter({
  cleanupTimeoutMs: 10,
  query: () => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      yield { type: 'result', subtype: 'success', session_id: 'native', result: 'done' };
    },
  }),
});
if (process.argv[4] === 'fail-finalizer-once') {
  const prepare = claude.prepareUnobservedCleanup!;
  let attempts = 0;
  claude.prepareUnobservedCleanup = (target) => {
    const commit = prepare(target);
    if (!commit) return null;
    return () => {
      if (++attempts === 1) throw new Error('offline fixture finalizer failure');
      commit();
    };
  };
}
const engine = await createEngine({
  workspace: process.argv[2]!,
  stateDir: process.argv[3]!,
  limits: { maxActiveSessions: 1 },
  adapters: [claude, createFakeAdapter({ result: 'queued work' })],
});
await startStdioHost(engine).closed;
