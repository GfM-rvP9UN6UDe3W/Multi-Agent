// SPEC-0018 cross-language fixture: a stdio host with read-only and writable fake providers.
// Pass `cross-root` as the third argument to configure allowCrossRootReuse.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from './engine.ts';
import { startStdioHost } from '../../packages/cli/src/host.ts';

const [workspace, stateDir, mode] = process.argv.slice(2);
mkdirSync(join(workspace, 'app'), { recursive: true });
const engine = await createEngine({
  workspace,
  stateDir,
  adapters: [
    createFakeAdapter({ provider: 'fake-read' }),
    createFakeAdapter({ provider: 'fake-write' }),
  ],
  providers: {
    'fake-read': { models: ['r-small', 'r-default', 'r-large'], permissionProfile: 'read-only' },
    'fake-write': {
      models: ['w-small', 'w-default', 'w-large'],
      permissionProfile: 'workspace-write',
    },
  },
  limits: { maxActiveSessions: 8 },
  writeScopes: { app: ['app'] },
  ...(mode === 'cross-root' ? { allowCrossRootReuse: true } : {}),
});
await startStdioHost(engine).closed;
