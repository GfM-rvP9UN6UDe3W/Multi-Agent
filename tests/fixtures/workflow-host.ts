// SPEC-0014 cross-language fixture: a stdio host whose fake runtime can request a handoff.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine, createFakeAdapter } from './engine.ts';
import { startStdioHost } from '../../packages/cli/src/host.ts';
import type { RuntimeInput, RuntimeTools } from '../../packages/engine/src/types.ts';

const [workspace, stateDir] = process.argv.slice(2);
mkdirSync(join(workspace, 'agents', 'alice'), { recursive: true });
const fake = createFakeAdapter();
const engine = await createEngine({
  workspace,
  stateDir,
  tools: { enabled: true, handoffs: true },
  writeScopes: { agents: ['agents'] },
  providers: { 'fake-write': { permissionProfile: 'workspace-write' } },
  adapters: [
    {
      ...fake,
      async *execute(input: RuntimeInput) {
        // A goal of "handoff to <session id>" asks the host to hand work to that session.
        const target = /^handoff to (\S+)/.exec(input.prompt)?.[1];
        if (target)
          await (
            input as RuntimeInput & { orchestrationTools: RuntimeTools }
          ).orchestrationTools.call('work_delegate', {
            goal: 'please review',
            contextPlan: { requestedMode: 'reuse', independent: true, candidateSessionId: target },
            idempotencyKey: 'handoff',
          });
        yield* fake.execute(input);
      },
    },
    createFakeAdapter({ provider: 'fake-write' }),
  ],
});
await startStdioHost(engine).closed;
