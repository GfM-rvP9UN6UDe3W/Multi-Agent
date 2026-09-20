/** The same four real engine operations, transported by either native MCP protocol peer. */
export async function exerciseTools(
  call: (name: string, request: Record<string, unknown>) => Promise<any>,
) {
  const child = await call('work_delegate', {
    goal: 'paused delegated fixture',
    contextPlan: { requestedMode: 'fresh', independent: true },
    idempotencyKey: 'child',
  });
  const message = await call('work_send', {
    taskId: child.id,
    toSessionId: child.sessionId,
    expectedGeneration: 1,
    kind: 'finding',
    summary: 'actual engine message',
    idempotencyKey: 'message',
  });
  const session = await call('work_read', { kind: 'session', id: child.sessionId });
  const operation = await call('work_control', {
    target: {
      sessionId: session.id,
      expectedGeneration: session.generation,
      expectedRevision: session.revision,
      expectedDispatchId: session.activeDispatchId,
      expectedState: session.status,
    },
    command: { action: 'pause', mode: 'drain' },
    idempotencyKey: 'pause',
  });
  return { childId: child.id, messageId: message.id, operationId: operation.id };
}
