import { fail } from './errors.ts';
import type { Json, RuntimeUsageEvent, UsageRecord } from './types.ts';

function invalid(): never {
  fail('INVALID_RUNTIME_CONTRACT', 'Usage must contain valid token counts and bounded JSON');
}

/** Snapshot observations before a caller can mutate raw JSON after persistence. */
export function usageRecord(
  event: RuntimeUsageEvent,
  identity: Pick<UsageRecord, 'taskId' | 'dispatchId' | 'provider'>,
): UsageRecord {
  if (
    !event ||
    event.type !== 'usage' ||
    typeof event.usageId !== 'string' ||
    !event.usageId.trim() ||
    event.usageId.length > 256 ||
    !event.usage ||
    typeof event.usage !== 'object' ||
    Array.isArray(event.usage)
  )
    invalid();
  const keys = [
    'inputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    'outputTokens',
  ] as const;
  if (Object.keys(event.usage).some((key) => ![...keys, 'raw'].includes(key))) invalid();
  for (const key of keys) {
    const value = event.usage[key];
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) invalid();
  }
  const ancestors = new Set<object>();
  let count = 0;
  function copy(value: unknown, depth = 0): Json {
    if (++count > 100000 || depth > 32) invalid();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || ancestors.has(value)) invalid();
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const result: Json[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!Object.hasOwn(value, i)) invalid();
          result.push(copy(value[i], depth + 1));
        }
        return result;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) invalid();
      const result: Record<string, Json> = {};
      for (const [key, child] of Object.entries(value)) {
        Object.defineProperty(result, key, { value: copy(child, depth + 1), enumerable: true });
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  }
  let raw: Json;
  try {
    raw = copy(event.usage.raw);
    if (Buffer.byteLength(JSON.stringify(raw)) > 512 * 1024) invalid();
  } catch {
    invalid();
  }
  return {
    ...identity,
    id: `${identity.dispatchId}:${event.usageId}`,
    inputTokens: event.usage.inputTokens,
    cachedInputTokens: event.usage.cachedInputTokens,
    cacheWriteInputTokens: event.usage.cacheWriteInputTokens,
    outputTokens: event.usage.outputTokens,
    raw,
  };
}

/**
 * The fields that records held before SPEC-0028 E01: identity, token counts and raw. A repeated
 * report of an observation is compared on these, so its later time does not make it a conflict.
 */
export function reportedUsage(record: UsageRecord): UsageRecord {
  const {
    sessionId: _session,
    model: _model,
    rootTaskId: _root,
    recordedAt: _at,
    ...reported
  } = record;
  return reported;
}
