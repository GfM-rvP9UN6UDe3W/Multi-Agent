import type { Json } from './types.ts';

export const TOOL_NAMES = ['work_delegate', 'work_send', 'work_read', 'work_control'] as const;
export type OrchestrationToolName = (typeof TOOL_NAMES)[number];
export interface OrchestrationToolDefinition {
  name: OrchestrationToolName;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Json>;
    required: string[];
    additionalProperties: false;
  };
}
const descriptions: Record<OrchestrationToolName, string> = {
  work_delegate:
    'Continue in this session, or delegate explicitly independent work with a declared contextPlan. Child permissions and acceptance are inherited. Return a durable receipt; never poll with model calls.',
  work_send:
    'Send bounded untrusted context to an authorized task/session generation. Use a unique idempotencyKey for each new message and preserve it for retries.',
  work_read:
    'Read one authorized task, session, message, operation, artifact, or usage snapshot. Reading does not run a model. Repeated unchanged reads are limited.',
  work_control:
    'Pause, resume, compact, rotate or stop an authorized session at the exact observed target generation/revision/dispatch/state. Cannot grant human or runtime approvals.',
};
export const ORCHESTRATION_TOOLS: readonly OrchestrationToolDefinition[] = Object.freeze(
  TOOL_NAMES.map((name) =>
    Object.freeze({
      name,
      description: descriptions[name],
      inputSchema: {
        type: 'object' as const,
        properties: {
          request: {
            type: 'object',
            description:
              name === 'work_read'
                ? 'Required kind (task/session/message/operation/artifact/usage) and id.'
                : name === 'work_delegate'
                  ? 'Required goal and idempotencyKey. Optional contextPlan (requestedMode, independent, candidateSessionId, snapshotRef, dependencyTaskIds, contextRefs, fallbackModes, maxQueueWaitMs), dependencyTaskIds and narrower writeScope.'
                  : name === 'work_send'
                    ? 'Required taskId, toSessionId, expectedGeneration, kind, summary, idempotencyKey. Optional artifactRefs, ttlMs and replyToMessageId.'
                    : 'Required target, command and idempotencyKey. target has sessionId, expectedGeneration, expectedRevision, expectedDispatchId and expectedState. command has action and optional mode.',
          },
        },
        required: ['request'],
        additionalProperties: false as const,
      },
    }),
  ),
);
export interface RuntimeTools {
  readonly definitions: readonly OrchestrationToolDefinition[];
  call(name: string, request: unknown): Promise<Json>;
}
