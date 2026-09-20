import type { Json, RuntimeInspection, RuntimeInspectionInput } from '../../engine/src/types.ts';
export type ClaudeInspectionDependencies = Pick<
  typeof import('@anthropic-ai/claude-agent-sdk'),
  'getSessionInfo' | 'getSessionMessages'
>;
export async function inspectClaudeSession(
  input: RuntimeInspectionInput,
  dependencies?: ClaudeInspectionDependencies,
): Promise<RuntimeInspection> {
  const base = {
    providerSessionId: input.providerSessionId,
    execution: 'unknown' as const,
    records: [] as Json[],
    truncated: false,
  };
  let sdk = dependencies;
  if (!sdk) {
    try {
      sdk = await import('@anthropic-ai/claude-agent-sdk');
    } catch {
      return {
        ...base,
        status: 'unavailable',
        detail:
          'Claude inspection requires @anthropic-ai/claude-agent-sdk or an explicit host reader',
      };
    }
  }
  const info = await sdk.getSessionInfo(input.providerSessionId, { dir: input.workspace });
  if (input.signal.aborted)
    return { ...base, status: 'unavailable', detail: 'Inspection deadline ended' };
  if (!info)
    return {
      ...base,
      status: 'not_found',
      detail: 'No retained native session metadata; this is not proof of non-execution',
    };
  if (info.sessionId !== input.providerSessionId)
    return {
      ...base,
      status: 'mismatch',
      detail: 'Native identity does not match original binding',
    };
  const messages = await sdk.getSessionMessages(input.providerSessionId, {
    dir: input.workspace,
    limit: input.limit + 1,
    includeSystemMessages: true,
  });
  const records: Json[] = [];
  let bytes = 0;
  for (const message of messages.slice(0, input.limit)) {
    bytes += Buffer.byteLength(JSON.stringify(message));
    if (bytes > 65536) break;
    records.push(message as unknown as Json);
  }
  return {
    ...base,
    status: 'found',
    records,
    truncated: records.length < messages.length,
    detail:
      'Read-only retained native history; resource and external side-effect reconciliation remain separate',
  };
}
