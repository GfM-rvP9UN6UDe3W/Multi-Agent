import type { RuntimeTools } from '../../engine/src/tools.ts';

export interface ClaudeMcpDependencies {
  sdk: Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'tool' | 'createSdkMcpServer'>;
  zod: Pick<typeof import('zod'), 'string' | 'unknown' | 'record'>;
}

/** Pass the host's pinned SDK and Zod together when embedding in a bundle. */
export async function createClaudeMcpServer(
  tools: RuntimeTools,
  dependencies?: ClaudeMcpDependencies,
): Promise<unknown> {
  let loaded = dependencies;
  if (!loaded) {
    try {
      const [sdk, zod] = await Promise.all([
        import('@anthropic-ai/claude-agent-sdk'),
        import('zod'),
      ]);
      loaded = { sdk, zod };
    } catch (cause) {
      throw Object.assign(
        new Error(
          'Claude MCP requires @anthropic-ai/claude-agent-sdk and zod 4.4.3, or explicit host SDK/Zod bindings',
          { cause },
        ),
        { code: 'CLAUDE_DEPENDENCY_UNAVAILABLE' },
      );
    }
  }
  const { sdk, zod: z } = loaded;
  return sdk.createSdkMcpServer({
    name: 'agent_orch',
    version: '0.1.0',
    tools: tools.definitions.map((definition) =>
      sdk.tool(
        definition.name,
        definition.description,
        { request: z.record(z.string(), z.unknown()) },
        async ({ request }) => {
          try {
            return {
              content: [
                { type: 'text', text: JSON.stringify(await tools.call(definition.name, request)) },
              ],
            };
          } catch (error) {
            const code =
              error &&
              typeof error === 'object' &&
              'code' in error &&
              typeof error.code === 'string' &&
              /^[A-Z_]{1,64}$/.test(error.code)
                ? error.code
                : 'TOOL_FAILED';
            return { isError: true, content: [{ type: 'text', text: code }] };
          }
        },
      ),
    ),
  });
}
