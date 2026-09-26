// SPEC-0030 cross-language fixture: a stdio host whose fake runtime reports the usage its goal
// asks for. `split=a/b` splits the cache writes by duration; `whole=n` does not.
import { createEngine, createFakeAdapter } from './engine.ts';
import { startStdioHost } from '../../packages/cli/src/host.ts';
import type { RuntimeInput } from '../../packages/engine/src/types.ts';

const [workspace, stateDir] = process.argv.slice(2);
const fake = createFakeAdapter();
const engine = await createEngine({
  workspace,
  stateDir,
  adapters: [
    {
      ...fake,
      async *execute(input: RuntimeInput) {
        for await (const event of fake.execute(input)) {
          yield event;
          if (event.type !== 'accepted') continue;
          const split = /split=(\d+)\/(\d+)/.exec(input.prompt);
          const whole = Number(/whole=(\d+)/.exec(input.prompt)?.[1] ?? 0);
          yield {
            type: 'usage' as const,
            usageId: 'u1',
            usage: {
              inputTokens: 7,
              cachedInputTokens: 1,
              cacheWriteInputTokens: split ? Number(split[1]) + Number(split[2]) : whole,
              ...(split
                ? {
                    cacheWrite5mInputTokens: Number(split[1]),
                    cacheWrite1hInputTokens: Number(split[2]),
                  }
                : {}),
              outputTokens: 3,
              raw: { cache_creation: { ephemeral_5m_input_tokens: 'kept as reported' } },
            },
          };
        }
      },
    },
  ],
});
await startStdioHost(engine).closed;
