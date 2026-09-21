import { createHash } from 'node:crypto';
import { validateBudget } from './accounting.ts';
import { fail } from './errors.ts';
import type { TaskSpec, MessageSpec, ContextPlan, RoutingMode } from './types.ts';

export function object(value: unknown, name = 'params'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('VALIDATION_ERROR', `${name} must be an object`);
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(value).find((k) => !allowed.includes(k));
  if (unknown) fail('VALIDATION_ERROR', `Unknown field: ${unknown}`);
}
export function string(value: unknown, name: string, max = 65536): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail('VALIDATION_ERROR', `${name} must be a nonempty string (max ${max})`);
  return value;
}
export function integer(
  value: unknown,
  name: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    fail('VALIDATION_ERROR', `${name} must be an integer between ${min} and ${max}`);
  return value as number;
}
export function strings(value: unknown, name: string, min = 0, max = 100): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail('VALIDATION_ERROR', `${name} must contain ${min}..${max} strings`);
  return value.map((v: unknown) => string(v, name));
}
export function contextPlan(value: unknown): ContextPlan {
  const p = object(value, 'contextPlan');
  fields(p, [
    'requestedMode',
    'independent',
    'dependencyTaskIds',
    'contextRefs',
    'candidateSessionId',
    'snapshotRef',
    'fallbackModes',
    'maxQueueWaitMs',
  ]);
  const modes = ['continue', 'parallel_tools', 'reuse', 'fork', 'fresh'];
  if (!modes.includes(p.requestedMode as string) || typeof p.independent !== 'boolean')
    fail('VALIDATION_ERROR', 'contextPlan requires an explicit mode and independence');
  const fallbackModes = strings(p.fallbackModes ?? [], 'fallbackModes', 0, 4) as RoutingMode[];
  if (
    fallbackModes.some((mode) => !modes.includes(mode)) ||
    new Set(fallbackModes).size !== fallbackModes.length ||
    fallbackModes.includes(p.requestedMode as RoutingMode)
  )
    fail('VALIDATION_ERROR', 'Invalid fallbackModes');
  if (!Array.isArray(p.contextRefs ?? []) || (p.contextRefs as unknown[] | undefined)?.length! > 20)
    fail('VALIDATION_ERROR', 'contextRefs must contain at most 20 artifact references');
  return {
    requestedMode: p.requestedMode as RoutingMode,
    independent: p.independent,
    dependencyTaskIds: strings(p.dependencyTaskIds ?? [], 'dependencyTaskIds'),
    contextRefs: ((p.contextRefs ?? []) as unknown[]).map((value) => {
      const ref = object(value, 'contextRef');
      fields(ref, ['artifactRef', 'version']);
      if (ref.version !== 1)
        fail('UNSUPPORTED_CAPABILITY', 'Unsupported context reference version');
      return { artifactRef: string(ref.artifactRef, 'artifactRef', 128), version: 1 };
    }),
    ...(p.candidateSessionId !== undefined
      ? { candidateSessionId: string(p.candidateSessionId, 'candidateSessionId', 128) }
      : {}),
    ...(p.snapshotRef !== undefined
      ? { snapshotRef: string(p.snapshotRef, 'snapshotRef', 128) }
      : {}),
    fallbackModes,
    maxQueueWaitMs: integer(p.maxQueueWaitMs ?? 30000, 'maxQueueWaitMs', 0, 300000),
  };
}
export function taskSpec(value: unknown): TaskSpec {
  const s = object(value, 'spec');
  fields(s, [
    'goal',
    'runtime',
    'acceptance',
    'dependencyTaskIds',
    'parentTaskId',
    'writeScope',
    'writePath',
    'contextPlan',
    'budget',
    'contextEstimate',
  ]);
  const runtime = object(s.runtime, 'runtime');
  fields(runtime, ['provider', 'model']);
  const acceptance = object(s.acceptance, 'acceptance');
  let accepted: TaskSpec['acceptance'];
  if (acceptance.mode === 'human') {
    fields(acceptance, ['mode', 'criteria']);
    accepted = { mode: 'human', criteria: strings(acceptance.criteria, 'criteria', 1) };
  } else if (acceptance.mode === 'checks') {
    fields(acceptance, ['mode', 'ruleRefs', 'maxRepairs']);
    if (
      !Array.isArray(acceptance.ruleRefs) ||
      !acceptance.ruleRefs.length ||
      acceptance.ruleRefs.length > 20
    )
      fail('VALIDATION_ERROR', 'ruleRefs must contain 1..20 registered rules');
    accepted = {
      mode: 'checks',
      ruleRefs: acceptance.ruleRefs.map((value) => {
        const ref = object(value, 'ruleRef');
        fields(ref, ['id', 'version']);
        return {
          id: string(ref.id, 'rule.id', 128),
          version: string(ref.version, 'rule.version', 128),
        };
      }),
      ...(acceptance.maxRepairs !== undefined
        ? { maxRepairs: integer(acceptance.maxRepairs, 'maxRepairs', 0, 20) }
        : {}),
    };
  } else fail('UNSUPPORTED_CAPABILITY', 'Unknown acceptance mode');
  const plan = s.contextPlan === undefined ? undefined : contextPlan(s.contextPlan);
  const dependencies =
    s.dependencyTaskIds === undefined
      ? undefined
      : strings(s.dependencyTaskIds, 'dependencyTaskIds');
  if (dependencies && new Set(dependencies).size !== dependencies.length)
    fail('VALIDATION_ERROR', 'Dependencies must be unique');
  return {
    goal: string(s.goal, 'goal'),
    runtime: {
      provider: string(runtime.provider, 'provider', 128),
      model: string(runtime.model, 'model', 256),
    },
    acceptance: accepted,
    ...(dependencies || plan?.dependencyTaskIds.length
      ? {
          dependencyTaskIds: [
            ...new Set([...(dependencies ?? []), ...(plan?.dependencyTaskIds ?? [])]),
          ],
        }
      : {}),
    ...(s.parentTaskId !== undefined
      ? { parentTaskId: string(s.parentTaskId, 'parentTaskId', 128) }
      : {}),
    ...(s.writeScope !== undefined ? { writeScope: string(s.writeScope, 'writeScope', 128) } : {}),
    ...(s.writePath !== undefined
      ? (() => {
          if (s.writeScope === undefined) fail('VALIDATION_ERROR', 'writePath requires writeScope');
          return { writePath: string(s.writePath, 'writePath', 4096) };
        })()
      : {}),
    ...(plan ? { contextPlan: plan } : {}),
    ...(s.budget !== undefined ? { budget: validateBudget(s.budget) } : {}),
    ...(s.contextEstimate !== undefined
      ? {
          contextEstimate: (() => {
            const estimate = object(s.contextEstimate, 'contextEstimate');
            fields(estimate, ['inputTokens', 'outputReserveTokens', 'toolReserveTokens']);
            return {
              inputTokens: integer(estimate.inputTokens, 'inputTokens', 0),
              outputReserveTokens: integer(estimate.outputReserveTokens, 'outputReserveTokens', 0),
              toolReserveTokens: integer(estimate.toolReserveTokens, 'toolReserveTokens', 0),
            };
          })(),
        }
      : {}),
  };
}
export function messageSpec(value: unknown): MessageSpec {
  const s = object(value, 'spec');
  fields(s, [
    'taskId',
    'toSessionId',
    'expectedGeneration',
    'kind',
    'summary',
    'artifactRefs',
    'ttlMs',
    'replyToMessageId',
  ]);
  if (!['assignment', 'finding', 'result', 'question', 'control'].includes(s.kind as string))
    fail('VALIDATION_ERROR', 'Unknown message kind');
  if (s.kind === 'control')
    fail('UNSUPPORTED_CAPABILITY', 'Use sessions.control for authorized control, not a message');
  return {
    taskId: string(s.taskId, 'taskId', 128),
    toSessionId: string(s.toSessionId, 'toSessionId', 128),
    expectedGeneration: integer(s.expectedGeneration, 'expectedGeneration', 1),
    kind: s.kind as MessageSpec['kind'],
    summary: string(s.summary, 'summary'),
    artifactRefs: s.artifactRefs === undefined ? [] : strings(s.artifactRefs, 'artifactRefs'),
    ...(s.ttlMs !== undefined ? { ttlMs: integer(s.ttlMs, 'ttlMs', 1, 604800000) } : {}),
    ...(s.replyToMessageId !== undefined
      ? { replyToMessageId: string(s.replyToMessageId, 'replyToMessageId', 128) }
      : {}),
  };
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
