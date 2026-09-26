import { Store } from './store.ts';
import {
  moneyUnits,
  moneyString,
  priceUsage,
  validateBudget,
  validatePricing,
} from './accounting.ts';
import { fail } from './errors.ts';
import type {
  CostRecord,
  CostSummary,
  EngineConfig,
  TaskSnapshot,
  Pricing,
  UsageRecord,
  Json,
} from './types.ts';
type Cost = CostRecord;
interface Reservation {
  id: string;
  taskId: string;
  rootTaskId: string;
  currency: string;
  initialUnits: string;
  remainingUnits: string;
  status: 'held' | 'settled';
}
export class CostLedger {
  private store: Store;
  private config: EngineConfig;
  readonly pricing: Pricing[];
  constructor(store: Store, config: EngineConfig) {
    this.store = store;
    this.config = config;
    this.pricing = (config.pricing ?? []).map(validatePricing);
    if (new Set(this.pricing.map((p) => `${p.provider}:${p.model}`)).size !== this.pricing.length)
      fail('VALIDATION_ERROR', 'Duplicate provider/model pricing');
    if (config.budget) validateBudget(config.budget);
    for (const limit of Object.values(config.contextLimits ?? {}))
      if (
        !Number.isSafeInteger(limit.windowTokens) ||
        limit.windowTokens < 1 ||
        !Number.isSafeInteger(limit.safetyTokens) ||
        limit.safetyTokens < 0 ||
        limit.safetyTokens >= limit.windowTokens
      )
        fail('VALIDATION_ERROR', 'Invalid context capacity reserve');
  }
  private root(task: TaskSnapshot): TaskSnapshot {
    return this.store.require('tasks', task.rootTaskId ?? task.id);
  }
  private costs(): Cost[] {
    return this.store.all<Cost>('costs');
  }
  private occupied(currency: string, rootTaskId?: string): bigint {
    let total = 0n;
    for (const row of this.costs())
      if (
        row.currency === currency &&
        row.amountUnits !== null &&
        (!rootTaskId || row.rootTaskId === rootTaskId)
      )
        total += BigInt(row.amountUnits);
    for (const row of this.store.all<Reservation>('budget_reservations'))
      if (
        row.currency === currency &&
        row.status === 'held' &&
        (!rootTaskId || row.rootTaskId === rootTaskId)
      )
        total += BigInt(row.remainingUnits);
    return total;
  }
  policy(task: TaskSnapshot): {
    reason: string | null;
    pricing?: Pricing;
    reserve?: string;
    currency?: string;
  } {
    const pricing = this.pricing.find(
      (p) => p.provider === task.spec.runtime.provider && p.model === task.spec.runtime.model,
    );
    const context =
      this.config.contextLimits?.[`${task.spec.runtime.provider}/${task.spec.runtime.model}`];
    if (context) {
      const estimate = task.spec.contextEstimate;
      if (!estimate) return { reason: 'CONTEXT_ESTIMATE_REQUIRED' };
      if (
        estimate.inputTokens +
          estimate.outputReserveTokens +
          estimate.toolReserveTokens +
          context.safetyTokens >
        context.windowTokens
      )
        return { reason: 'CONTEXT_CAPACITY' };
    }
    const root = this.root(task),
      budget = root.spec.budget,
      host = this.config.budget;
    const effective = task.spec.budget ?? budget ?? host;
    if (!effective) return { reason: null, pricing };
    if (
      !pricing ||
      pricing.currency !== effective.currency ||
      (host && host.currency !== effective.currency) ||
      (budget && budget.currency !== effective.currency)
    )
      return { reason: 'BUDGET_PRICE_UNKNOWN' };
    const reserve = moneyUnits(effective.reservePerDispatch);
    if (host && this.occupied(host.currency) + reserve > moneyUnits(host.maxCost))
      return { reason: 'HOST_BUDGET_EXHAUSTED' };
    if (budget && this.occupied(budget.currency, root.id) + reserve > moneyUnits(budget.maxCost))
      return { reason: 'TASK_BUDGET_EXHAUSTED' };
    if (task.id !== root.id && task.spec.budget) {
      let direct = 0n;
      for (const row of this.costs())
        if (row.costOwnerTaskId === task.id && row.amountUnits !== null)
          direct += BigInt(row.amountUnits);
      for (const row of this.store.all<Reservation>('budget_reservations'))
        if (row.taskId === task.id && row.status === 'held') direct += BigInt(row.remainingUnits);
      if (direct + reserve > moneyUnits(task.spec.budget.maxCost))
        return { reason: 'TASK_BUDGET_EXHAUSTED' };
    }
    return { reason: null, pricing, reserve: reserve.toString(), currency: effective.currency };
  }
  reserve(
    task: TaskSnapshot,
    dispatchId: string,
  ): { costOwnerTaskId: string; rootTaskId: string; pricing?: Pricing } {
    const policy = this.policy(task);
    if (policy.reason) fail(policy.reason, 'Cost/context admission changed before dispatch');
    const rootTaskId = task.rootTaskId ?? task.id;
    if (policy.reserve)
      this.store.put('budget_reservations', dispatchId, {
        id: dispatchId,
        taskId: task.id,
        rootTaskId,
        currency: policy.currency!,
        initialUnits: policy.reserve,
        remainingUnits: policy.reserve,
        status: 'held',
      } satisfies Reservation);
    return {
      costOwnerTaskId: task.id,
      rootTaskId,
      ...(policy.pricing ? { pricing: policy.pricing } : {}),
    };
  }
  record(usage: UsageRecord, dispatch: Record<string, unknown>, createdAt: string): void {
    const dispatchPricing = dispatch.pricing as Pricing | undefined;
    // SPEC-0031 B03: a record of another model takes that model's registered price, in the
    // dispatch's currency; without one its cost is unknown.
    const pricing =
      !dispatchPricing || usage.model === undefined || usage.model === dispatchPricing.model
        ? dispatchPricing
        : this.pricing.find(
            (p) =>
              p.provider === usage.provider &&
              p.model === usage.model &&
              p.currency === dispatchPricing.currency,
          );
    const priced = pricing
      ? priceUsage(usage, pricing)
      : {
          amount: null,
          amountUnits: null,
          currency: null,
          pricingVersion: null,
          completeness: 'unknown',
          reason: 'pricing_not_registered',
        };
    const cost: Cost = {
      id: usage.id,
      usageRecordId: usage.id,
      dispatchId: usage.dispatchId,
      costOwnerTaskId: String(dispatch.costOwnerTaskId ?? usage.taskId),
      rootTaskId: String(dispatch.rootTaskId ?? usage.taskId),
      category: 'task',
      createdAt,
      ...(priced as unknown as Record<string, Json>),
      currency: priced.currency,
      amount: priced.amount,
      amountUnits: priced.amountUnits,
    };
    this.store.put('costs', cost.id, cost);
    this.settle(usage.dispatchId);
  }
  settle(dispatchId: string): void {
    const reserve = this.store.get<Reservation>('budget_reservations', dispatchId);
    if (!reserve) return;
    const dispatch = this.store.require<Record<string, unknown>>('dispatches', dispatchId);
    const records = this.costs().filter((cost) => cost.dispatchId === dispatchId);
    const spent = records.reduce((n, row) => n + BigInt(row.amountUnits ?? '0'), 0n);
    const terminal = dispatch.terminalEvidence as { usageComplete?: boolean } | undefined;
    const complete =
      terminal?.usageComplete === true &&
      records.length > 0 &&
      records.every((r) => r.amountUnits !== null);
    const unsent = !!dispatch.preSubmissionEvidenceRef && dispatch.runtimeAccepted !== true;
    reserve.status = complete || unsent ? 'settled' : 'held';
    reserve.remainingUnits =
      reserve.status === 'settled'
        ? '0'
        : (BigInt(reserve.initialUnits) > spent
            ? BigInt(reserve.initialUnits) - spent
            : 0n
          ).toString();
    this.store.put('budget_reservations', dispatchId, reserve);
  }
  summary(taskId: string | undefined, scope: 'direct' | 'tree' | 'host_overhead'): CostSummary {
    return costSummary(this.store, taskId, scope);
  }
}
/** The result of `costs.get`, for the engine and a read-only view (SPEC-0027 R03). */
export function costSummary(
  store: Store,
  taskId: string | undefined,
  scope: 'direct' | 'tree' | 'host_overhead',
): CostSummary {
  if (taskId) store.require('tasks', taskId);
  const descendants = new Set<string>(taskId ? [taskId] : []);
  if (taskId && scope === 'tree') {
    const tasks = store.all<TaskSnapshot>('tasks');
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks)
        if (
          task.spec.parentTaskId &&
          descendants.has(task.spec.parentTaskId) &&
          !descendants.has(task.id)
        ) {
          descendants.add(task.id);
          changed = true;
        }
    }
  }
  const rows = store
    .all<Cost>('costs')
    .filter((row) =>
      scope === 'host_overhead'
        ? row.category === 'host_overhead'
        : row.category === 'task' && (!taskId || descendants.has(row.costOwnerTaskId!)),
    );
  const totals: Record<string, bigint> = {};
  for (const row of rows)
    if (row.amountUnits !== null && row.currency)
      totals[row.currency] = (totals[row.currency] ?? 0n) + BigInt(row.amountUnits);
  const reservations = store
    .all<Reservation>('budget_reservations')
    .filter(
      (row) =>
        scope !== 'host_overhead' &&
        (!taskId || descendants.has(row.taskId)) &&
        row.status === 'held',
    );
  return {
    scope,
    totals: Object.fromEntries(
      Object.entries(totals).map(([currency, n]) => [currency, moneyString(n)]),
    ),
    unknownRecords: rows.filter((row) => row.amountUnits === null).length,
    records: rows.slice(0, 500),
    recordsTruncated: rows.length > 500,
    recordCount: rows.length,
    reservations: reservations
      .slice(0, 100)
      .map((row) => ({ ...row, remaining: moneyString(BigInt(row.remainingUnits)) })),
    reservationsTruncated: reservations.length > 100,
    basis: 'registered-price estimate; not a provider bill',
    settlementIncomplete: reservations.length > 0,
  };
}
