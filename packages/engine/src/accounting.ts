import { fail } from './errors.ts';
import { fields, integer, object, string } from './validation.ts';
import type { Json, Pricing, MoneyBudget, UsageRecord } from './types.ts';
const SCALE = 18;
export function moneyUnits(value: string, scale = SCALE): bigint {
  if (typeof value !== 'string' || value.length > 64 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value))
    fail('VALIDATION_ERROR', 'Money must be a nonnegative decimal string');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scale)
    fail('VALIDATION_ERROR', `Money supports at most ${scale} decimal places`);
  return BigInt(whole + fraction.padEnd(scale, '0'));
}
export function moneyString(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const text = (units < 0n ? -units : units).toString().padStart(SCALE + 1, '0');
  const fraction = text.slice(-SCALE).replace(/0+$/, '');
  return sign + text.slice(0, -SCALE) + (fraction ? '.' + fraction : '');
}
export function validateBudget(value: unknown): MoneyBudget {
  const budget = object(value, 'budget');
  fields(budget, ['currency', 'maxCost', 'reservePerDispatch']);
  const currency = string(budget.currency, 'budget.currency', 3);
  if (!/^[A-Z]{3}$/.test(currency))
    fail('VALIDATION_ERROR', 'currency must be an ISO currency code');
  const maxCost = string(budget.maxCost, 'budget.maxCost', 64),
    reservePerDispatch = string(budget.reservePerDispatch, 'budget.reservePerDispatch', 64);
  if (moneyUnits(maxCost) < moneyUnits(reservePerDispatch) || moneyUnits(reservePerDispatch) <= 0n)
    fail('VALIDATION_ERROR', 'Budget reserve must be positive and at most maxCost');
  return { currency, maxCost, reservePerDispatch };
}
export function validatePricing(value: unknown): Pricing {
  const p = object(value, 'pricing');
  fields(p, ['provider', 'model', 'currency', 'version', 'inputTokenMode', 'perMillion']);
  const currency = string(p.currency, 'pricing.currency', 3);
  if (!/^[A-Z]{3}$/.test(currency) || !['total', 'uncached'].includes(String(p.inputTokenMode)))
    fail('VALIDATION_ERROR', 'Invalid currency or token accounting mode');
  const rates = object(p.perMillion, 'perMillion');
  fields(rates, ['input', 'cacheRead', 'cacheWrite', 'output']);
  for (const key of ['input', 'output'])
    if (rates[key] === undefined) fail('VALIDATION_ERROR', `Missing ${key} price`);
  for (const value of Object.values(rates)) moneyUnits(string(value, 'price', 64), 12);
  return {
    provider: string(p.provider, 'provider', 128),
    model: string(p.model, 'model', 256),
    currency,
    version: string(p.version, 'pricing.version', 128),
    inputTokenMode: p.inputTokenMode as Pricing['inputTokenMode'],
    perMillion: { ...rates } as Pricing['perMillion'],
  };
}
export type TokenUsage = Pick<
  UsageRecord,
  'inputTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens' | 'outputTokens'
>;
export interface PricedUsage {
  currency: string;
  pricingVersion: string;
  amount: string | null;
  amountUnits: string | null;
  tokens: {
    ordinary: number | null;
    cached: number | null;
    cacheWrite: number | null;
    output: number | null;
  };
  completeness: 'estimated' | 'unknown';
  reason?: string;
}
/** Prices are per million; multiply integer token counts by 10^-18 currency units. */
export function priceUsage(usage: TokenUsage, rawPricing: Pricing): PricedUsage {
  const pricing = validatePricing(rawPricing);
  for (const key of [
    'inputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    'outputTokens',
  ] as const)
    if (usage[key] !== null) integer(usage[key], 'token count', 0);
  const cached = usage.cachedInputTokens,
    cacheWrite = usage.cacheWriteInputTokens;
  let ordinary = usage.inputTokens;
  if (pricing.inputTokenMode === 'total')
    ordinary =
      ordinary === null ||
      cached === null ||
      (pricing.perMillion.cacheWrite !== undefined && cacheWrite === null)
        ? null
        : ordinary - cached - (pricing.perMillion.cacheWrite !== undefined ? cacheWrite! : 0);
  const tokens = { ordinary, cached, cacheWrite, output: usage.outputTokens };
  const base = { currency: pricing.currency, pricingVersion: pricing.version, tokens };
  if (Object.values(tokens).some((value) => value !== null && value < 0))
    return {
      ...base,
      amount: null,
      amountUnits: null,
      completeness: 'unknown',
      reason: 'overlapping_or_inconsistent_usage',
    };
  const buckets: [number | null, string | undefined][] = [
    [ordinary, pricing.perMillion.input],
    [cached, pricing.perMillion.cacheRead],
    [
      pricing.perMillion.cacheWrite === undefined && pricing.inputTokenMode === 'total'
        ? 0
        : cacheWrite,
      pricing.perMillion.cacheWrite,
    ],
    [usage.outputTokens, pricing.perMillion.output],
  ];
  let amount = 0n;
  for (const [tokens, rate] of buckets) {
    if (tokens === 0) continue;
    if (tokens === null || rate === undefined)
      return {
        ...base,
        amount: null,
        amountUnits: null,
        completeness: 'unknown',
        reason: 'missing_usage_or_price',
      };
    amount += BigInt(tokens) * moneyUnits(rate, 12);
  }
  return {
    ...base,
    amount: moneyString(amount),
    amountUnits: amount.toString(),
    completeness: 'estimated',
  };
}

export function estimateStrategies(input: {
  pricing: Pricing;
  keep: TokenUsage[];
  compact: TokenUsage[];
  compaction: TokenUsage;
  intervalsKnown: boolean;
  recoveryCost?: string;
  qualityVerified?: boolean;
  measuredBenefit?: boolean;
}): {
  keep: { amount: string | null; requests: number };
  compact: { amount: string | null; requests: number };
  automaticSelection: false;
  reason: string;
} {
  const sum = (items: TokenUsage[], overhead = '0') => {
    let units = moneyUnits(overhead);
    for (const usage of items) {
      const priced = priceUsage(usage, input.pricing);
      if (priced.amountUnits === null) return { amount: null, requests: items.length };
      units += BigInt(priced.amountUnits);
    }
    return { amount: moneyString(units), requests: items.length };
  };
  if (input.keep.length > 1000 || input.compact.length > 1000)
    fail('VALIDATION_ERROR', 'At most 1000 predicted requests per strategy');
  return {
    keep: sum(input.keep),
    compact: sum([input.compaction, ...input.compact], input.recoveryCost),
    automaticSelection: false,
    reason: !input.intervalsKnown
      ? 'unknown_future_intervals'
      : !input.qualityVerified
        ? 'quality_unverified'
        : !input.measuredBenefit
          ? 'benefit_unverified'
          : 'explicit_owner_selection_required',
  };
}

/** Produce separate sustained-hit, TTL-rebuild and partial-prefix paths with explicit growth. */
export function estimateContext(input: {
  pricing: Pricing;
  keepHistoryTokens: number;
  compactHistoryTokens: number;
  requests: number | null;
  growthTokens: number;
  outputTokens: number;
  retainedPrefixTokens: number;
  compaction: TokenUsage;
  intervalsMs: (number | null)[];
  ttlMs: number;
}): Json {
  if (input.requests === null)
    return { status: 'unknown', reason: 'unknown_future_request_count', automaticSelection: false };
  for (const key of [
    'keepHistoryTokens',
    'compactHistoryTokens',
    'growthTokens',
    'outputTokens',
    'retainedPrefixTokens',
    'ttlMs',
  ] as const)
    integer(input[key], key, 0);
  integer(input.requests, 'requests', 1, 1000);
  if (!Array.isArray(input.intervalsMs) || input.intervalsMs.length !== input.requests)
    fail('VALIDATION_ERROR', 'One observed/predicted interval is required per request');
  for (const value of input.intervalsMs) if (value !== null) integer(value, 'intervalMs', 0);
  const scenarios: Record<string, Json> = {};
  const ranges: Record<string, bigint[]> = { keep: [], compact: [] };
  for (const scenario of ['sustained_hit', 'ttl_rebuild', 'partial_prefix']) {
    const sequence = (history: number, compact: boolean): TokenUsage[] =>
      Array.from({ length: input.requests! }, (_, i) => {
        const total = history + i * input.growthTokens;
        const expired =
          scenario === 'ttl_rebuild' &&
          (input.intervalsMs[i] === null || input.intervalsMs[i]! > input.ttlMs);
        const cached = expired
          ? 0
          : scenario === 'partial_prefix' || (compact && i === 0)
            ? Math.min(input.retainedPrefixTokens, total)
            : total;
        const write = expired && input.pricing.perMillion.cacheWrite !== undefined ? total : 0;
        return {
          inputTokens: input.pricing.inputTokenMode === 'total' ? total : total - cached - write,
          cachedInputTokens: cached,
          cacheWriteInputTokens: write,
          outputTokens: input.outputTokens,
        };
      });
    const keep = sequence(input.keepHistoryTokens, false),
      compact = sequence(input.compactHistoryTokens, true);
    const comparison = estimateStrategies({
      pricing: input.pricing,
      keep,
      compact,
      compaction: input.compaction,
      intervalsKnown: input.intervalsMs.every((x) => x !== null),
    });
    for (const key of ['keep', 'compact'] as const)
      if (comparison[key].amount !== null) ranges[key].push(moneyUnits(comparison[key].amount));
    scenarios[scenario] = {
      ...comparison,
      keepRequests: keep as unknown as Json,
      compactRequests: compact as unknown as Json,
    };
  }
  return {
    scenarios,
    range: Object.fromEntries(
      Object.entries(ranges).map(([key, values]) => [
        key,
        values.length !== 3
          ? null
          : {
              min: moneyString(values.reduce((a, b) => (a < b ? a : b))),
              max: moneyString(values.reduce((a, b) => (a > b ? a : b))),
              currency: input.pricing.currency,
            },
      ]),
    ),
    assumptions: input as unknown as Json,
    automaticSelection: false,
    cacheHitsGuaranteed: false,
  };
}
