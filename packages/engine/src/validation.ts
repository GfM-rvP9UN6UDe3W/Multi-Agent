import { createHash } from 'node:crypto';
import { fail } from './errors.ts';
import type { TaskSpec, MessageSpec } from './types.ts';

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
export function taskSpec(value: unknown): TaskSpec {
  const s = object(value, 'spec');
  fields(s, ['goal', 'runtime', 'acceptance']);
  const runtime = object(s.runtime, 'runtime');
  fields(runtime, ['provider', 'model']);
  const acceptance = object(s.acceptance, 'acceptance');
  if (acceptance.mode !== 'human')
    fail('UNSUPPORTED_CAPABILITY', 'This increment supports human acceptance only');
  fields(acceptance, ['mode', 'criteria']);
  return {
    goal: string(s.goal, 'goal'),
    runtime: {
      provider: string(runtime.provider, 'provider', 128),
      model: string(runtime.model, 'model', 256),
    },
    acceptance: { mode: 'human', criteria: strings(acceptance.criteria, 'criteria', 1) },
  };
}
export function messageSpec(value: unknown): MessageSpec {
  const s = object(value, 'spec');
  fields(s, ['taskId', 'toSessionId', 'expectedGeneration', 'kind', 'summary', 'artifactRefs']);
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
