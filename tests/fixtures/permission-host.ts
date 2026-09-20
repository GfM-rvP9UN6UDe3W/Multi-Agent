import { createEngine, createFakeAdapter } from './engine.ts';
import { startStdioHost } from '../../packages/cli/src/host.ts';
const [workspace, stateDir] = process.argv.slice(2);
const fake = createFakeAdapter();
const engine = await createEngine({
  workspace,
  stateDir,
  runtimeApprovals: { enabled: true, ttlMs: 5000 },
  adapters: [
    {
      ...fake,
      async *execute(input) {
        yield { type: 'accepted', providerSessionId: 'permission-native' };
        const granted = await input.requestPermission!({
          requestId: 'read-1',
          toolName: 'Read',
          permission: { file: 'fixture.txt' },
          providerSessionId: 'permission-native',
        });
        yield* createFakeAdapter({
          result: granted ? 'permission-approved' : 'permission-denied',
        }).execute({ ...input, providerSessionId: 'permission-native' });
      },
    },
  ],
});
await startStdioHost(engine).closed;
