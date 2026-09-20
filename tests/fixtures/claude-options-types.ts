import {
  createClaudeAdapter,
  type ClaudeHostOptions,
  type ClaudeOwnedOption,
} from '../../packages/adapter-claude/src/index.ts';

// Native-shaped fixture: callers use their installed SDK's Options in the same pattern.
interface NativeOptions {
  model?: string;
  cwd?: string;
  canUseTool?: (
    tool: string,
    input: Record<string, unknown>,
    context: { signal: AbortSignal },
  ) => Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> }>;
  hooks?: {
    PreToolUse?: {
      hooks: ((
        input: { tool_name: string },
        id: string | undefined,
        context: { signal: AbortSignal },
      ) => Promise<{ continue: boolean }>)[];
    }[];
  };
  mcpServers?: Record<string, { type: 'sdk'; name: string; instance: object }>;
  systemPrompt?: string;
  env?: Record<string, string | undefined>;
}
type HostNative = Omit<NativeOptions, ClaudeOwnedOption>;
const options: ClaudeHostOptions<HostNative> = {
  canUseTool: async (_tool, input, context) => {
    context.signal.throwIfAborted();
    return { behavior: 'allow', updatedInput: input };
  },
  hooks: {
    PreToolUse: [{ hooks: [async (input) => ({ continue: input.tool_name !== 'denied' })] }],
  },
  mcpServers: { fixture: { type: 'sdk', name: 'fixture', instance: {} } },
};
createClaudeAdapter<HostNative>({
  options,
  extendOptions: async (context) => ({
    systemPrompt: context.input.dispatchId,
    env: { FIXTURE: 'yes' },
  }),
  query: (request) => {
    const native: NativeOptions = request.options;
    void native;
    return (async function* () {})();
  },
});
const forbidden: ClaudeHostOptions<HostNative> = {
  // @ts-expect-error cwd is owned by the adapter even with native types.
  cwd: '/wrong',
};
const partialMessages: ClaudeHostOptions<HostNative> = {
  // @ts-expect-error Turn-activity observation is owned by the adapter.
  includePartialMessages: false,
};
void partialMessages;
createClaudeAdapter<HostNative>({
  // @ts-expect-error The extension cannot change native session identity.
  extendOptions: () => ({ resume: 'wrong' }),
});
void forbidden;
