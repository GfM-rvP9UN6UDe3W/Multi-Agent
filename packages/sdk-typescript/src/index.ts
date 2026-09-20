import { randomUUID } from 'node:crypto';
import { createEngine } from '../../engine/src/index.ts';
import type {
  ApprovalRequest,
  CloseOptions,
  Engine,
  EngineConfig,
  EventEnvelope,
  EventPage,
  ExecutionConflict,
  MessageSnapshot,
  MessageSpec,
  OperationSnapshot,
  ReconcileEvidence,
  RuntimeCapabilities,
  SchedulerSnapshot,
  SessionControlTarget,
  SessionSnapshot,
  TaskSnapshot,
  TaskSpec,
  UsageRecord,
} from '../../engine/src/types.ts';
import { OrchestratorError, UnixRpcClient, type Caller, type RequestOptions } from './transport.ts';
export { OrchestratorError } from './transport.ts';
export type { RequestOptions } from './transport.ts';
export type * from '../../engine/src/types.ts';

export interface MutationOptions extends RequestOptions {
  idempotencyKey?: string;
}
export interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface EventOptions extends RequestOptions {
  afterCursor?: string;
  storeId?: string;
  taskId?: string;
  limit?: number;
}
export interface InitializeResult {
  protocolVersion: string;
  engineVersion: string;
  schemaVersion: number;
  instanceId: string;
  storeId: string;
  capabilities: Record<string, unknown>;
}
export interface UsageResult {
  records: UsageRecord[];
  completeness: 'unknown' | 'reported';
}
const taskTerminal = new Set(['completed', 'failed', 'cancelled']);
const operationTerminal = new Set(['completed', 'noop', 'rejected', 'failed', 'outcome_unknown']);

function key(options: MutationOptions = {}) {
  return options.idempotencyKey ?? randomUUID();
}
function aborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new OrchestratorError('ABORTED', 'Local wait aborted; remote work was not cancelled');
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    function cancel() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(new OrchestratorError('ABORTED', 'Local wait aborted; remote work was not cancelled'));
    }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
function boundedRead<T>(
  read: (options: RequestOptions) => Promise<T>,
  remaining: number,
  signal?: AbortSignal,
): Promise<T> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    };
    const stop = (error: OrchestratorError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      controller.abort();
    };
    const cancel = () =>
      stop(new OrchestratorError('ABORTED', 'Local wait aborted; remote work was not cancelled'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (Number.isFinite(remaining))
      timer = setTimeout(
        () =>
          stop(new OrchestratorError('TIMEOUT', 'Wait timed out; remote work was not cancelled')),
        Math.max(0, remaining),
      );
    read({
      signal: controller.signal,
      ...(Number.isFinite(remaining) ? { timeoutMs: Math.max(1, Math.ceil(remaining)) } : {}),
    }).then(
      (value) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(value);
        }
      },
      (error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      },
    );
  });
}
async function waitFor<T extends { status: string }>(
  read: (options: RequestOptions) => Promise<T>,
  terminal: Set<string>,
  options: WaitOptions,
): Promise<T> {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
  )
    throw new OrchestratorError('INVALID_PARAMS', 'timeoutMs must be a finite non-negative number');
  const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
  while (true) {
    aborted(options.signal);
    const snapshot = await boundedRead(read, deadline - Date.now(), options.signal);
    aborted(options.signal);
    if (terminal.has(snapshot.status)) return snapshot;
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new OrchestratorError('TIMEOUT', 'Wait timed out; remote work was not cancelled');
    await sleep(Math.min(50, remaining), options.signal);
  }
}

export class TaskHandle {
  readonly id: string;
  readonly initial: TaskSnapshot;
  private client: Orchestrator;
  constructor(client: Orchestrator, snapshot: TaskSnapshot) {
    this.client = client;
    this.id = snapshot.id;
    this.initial = snapshot;
  }
  get(options?: RequestOptions) {
    return this.client.tasks.get(this.id, options);
  }
  wait(options: WaitOptions = {}) {
    return waitFor((request) => this.get(request), taskTerminal, options);
  }
  cancel(options: MutationOptions = {}) {
    return this.client.tasks.cancel(this.id, options);
  }
  resume(options: MutationOptions = {}) {
    return this.client.tasks.resume(this.id, options);
  }
}
export class OperationHandle {
  readonly id: string;
  readonly initial: OperationSnapshot;
  private client: Orchestrator;
  constructor(client: Orchestrator, snapshot: OperationSnapshot) {
    this.client = client;
    this.id = snapshot.id;
    this.initial = snapshot;
  }
  get(options?: RequestOptions) {
    return this.client.ops.get(this.id, options);
  }
  wait(options: WaitOptions = {}) {
    return waitFor((request) => this.get(request), operationTerminal, options);
  }
}

export class Orchestrator {
  readonly info: InitializeResult;
  private caller: Caller;
  private owner: boolean;
  private closed = false;
  private closeResult?: { status: 'closed'; operationId: string };
  constructor(caller: Caller, info: InitializeResult, owner: boolean) {
    this.caller = caller;
    this.info = info;
    this.owner = owner;
  }
  private call<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {},
  ) {
    if (this.closed)
      return Promise.reject<T>(new OrchestratorError('CLIENT_CLOSED', 'Client is closed'));
    return this.caller.call<T>(method, params, options);
  }
  private async mutation<T>(
    method: string,
    scope: string,
    params: Record<string, unknown>,
    options?: MutationOptions,
  ): Promise<T> {
    const idempotencyKey = key(options);
    try {
      return await this.call<T>(method, { ...params, idempotencyKey }, options);
    } catch (error) {
      const original = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
      const data =
        original.data && typeof original.data === 'object'
          ? (original.data as Record<string, unknown>)
          : original.details && typeof original.details === 'object'
            ? (original.details as Record<string, unknown>)
            : {};
      // Each failed request gets its own error: transport disconnect may reject many calls together.
      const failure = new OrchestratorError(
        typeof original.code === 'string' ? original.code : 'REQUEST_FAILED',
        typeof original.message === 'string' ? original.message : String(error),
        { ...data, method, scope, idempotencyKey },
      );
      failure.cause = error;
      throw failure;
    }
  }
  private async operation(
    method: string,
    scope: string,
    params: Record<string, unknown>,
    options?: MutationOptions,
  ) {
    return new OperationHandle(
      this,
      await this.mutation<OperationSnapshot>(method, scope, params, options),
    );
  }
  private requireExecutionIsolation() {
    const capability = this.info.capabilities.executionIsolation;
    if (
      !capability ||
      typeof capability !== 'object' ||
      !('version' in capability) ||
      capability.version !== 1 ||
      !('resourceRelease' in capability) ||
      capability.resourceRelease !== true ||
      !('schedulerStatus' in capability) ||
      capability.schedulerStatus !== true ||
      !('ownerConflictResolution' in capability) ||
      capability.ownerConflictResolution !== true ||
      !('budgetVersion' in capability) ||
      capability.budgetVersion !== 2
    ) {
      throw new OrchestratorError(
        'UNSUPPORTED_CAPABILITY',
        'Host does not advertise execution isolation v1 with budget policy v2',
      );
    }
  }
  readonly scheduler = {
    get: async (options?: RequestOptions) => {
      this.requireExecutionIsolation();
      return this.call<SchedulerSnapshot>('scheduler.get', {}, options);
    },
    getConflict: async (query: { conflictId: string }, options?: RequestOptions) => {
      this.requireExecutionIsolation();
      return this.call<ExecutionConflict>('scheduler.getConflict', query, options);
    },
    resolveConflict: async (
      request: { conflictId: string; expectedRevision: number; evidence: ReconcileEvidence },
      options?: MutationOptions,
    ) => {
      this.requireExecutionIsolation();
      return this.operation('scheduler.resolveConflict', request.conflictId, request, options);
    },
  };
  readonly tasks = {
    create: async (spec: TaskSpec, options?: MutationOptions) =>
      new TaskHandle(
        this,
        await this.mutation<TaskSnapshot>('tasks.create', 'local', { spec }, options),
      ),
    get: (taskId: string, options?: RequestOptions) =>
      this.call<TaskSnapshot>('tasks.get', { taskId }, options),
    resume: (taskId: string, options?: MutationOptions) =>
      this.operation('tasks.resume', taskId, { taskId }, options),
    cancel: (taskId: string, options?: MutationOptions) =>
      this.operation('tasks.cancel', taskId, { taskId }, options),
  };
  readonly sessions = {
    get: (sessionId: string, options?: RequestOptions) =>
      this.call<SessionSnapshot>('sessions.get', { sessionId }, options),
    control: (
      target: SessionControlTarget,
      command: { action: string; mode?: 'drain' | 'interrupt' },
      options?: MutationOptions,
    ) => this.operation('sessions.control', target.sessionId, { target, command }, options),
    reconcile: async (
      target: SessionControlTarget,
      evidence: ReconcileEvidence,
      options?: MutationOptions,
    ) => {
      const capability = this.info.capabilities.lifecycle;
      if (
        !capability ||
        typeof capability !== 'object' ||
        !('version' in capability) ||
        capability.version !== 1 ||
        !('reconcile' in capability) ||
        capability.reconcile !== 'owner-attestation' ||
        !('durableDeadlines' in capability) ||
        capability.durableDeadlines !== true
      ) {
        throw new OrchestratorError(
          'UNSUPPORTED_CAPABILITY',
          'Host does not advertise lifecycle v1 owner-attestation reconciliation',
        );
      }
      return this.operation('sessions.reconcile', target.sessionId, { target, evidence }, options);
    },
    open: (..._args: unknown[]) =>
      Promise.reject(
        new OrchestratorError(
          'UNSUPPORTED_CAPABILITY',
          'sessions.open is not implemented in foundation 1.0',
        ),
      ),
    fork: (..._args: unknown[]) =>
      Promise.reject(
        new OrchestratorError(
          'UNSUPPORTED_CAPABILITY',
          'sessions.fork is not implemented in foundation 1.0',
        ),
      ),
    compact: (..._args: unknown[]) =>
      Promise.reject(
        new OrchestratorError(
          'UNSUPPORTED_CAPABILITY',
          'sessions.compact is not implemented in foundation 1.0',
        ),
      ),
    rotate: (..._args: unknown[]) =>
      Promise.reject(
        new OrchestratorError(
          'UNSUPPORTED_CAPABILITY',
          'sessions.rotate is not implemented in foundation 1.0',
        ),
      ),
  };
  readonly messages = {
    send: (spec: MessageSpec, options?: MutationOptions) =>
      this.mutation<MessageSnapshot>('messages.send', spec.toSessionId, { spec }, options),
    get: (messageId: string, options?: RequestOptions) =>
      this.call<MessageSnapshot>('messages.get', { messageId }, options),
  };
  readonly ops = {
    get: (operationId: string, options?: RequestOptions) =>
      this.call<OperationSnapshot>('operations.get', { operationId }, options),
    lookup: (
      query: { method: string; scope: string; idempotencyKey: string },
      options?: RequestOptions,
    ) => this.call<OperationSnapshot>('operations.lookup', query, options),
  };
  readonly operations = this.ops;
  readonly approvals = {
    get: (approvalId: string, options?: RequestOptions) =>
      this.call<ApprovalRequest>('approvals.get', { approvalId }, options),
    decide: (
      approvalId: string,
      decision: { choice: 'approve' | 'deny'; expectedRevision: number },
      options?: MutationOptions,
    ) => this.operation('approvals.decide', approvalId, { approvalId, decision }, options),
  };
  readonly usage = {
    getRecord: (usageRecordId: string, options?: RequestOptions) =>
      this.call<UsageRecord>('usage.getRecord', { usageRecordId }, options),
    get: (query: { taskId: string } | string, options?: RequestOptions) =>
      this.call<UsageResult>(
        'usage.get',
        typeof query === 'string' ? { taskId: query } : query,
        options,
      ),
  };
  readonly capabilities = Object.assign(
    (query: { provider?: string } = {}, options?: RequestOptions) =>
      this.call<RuntimeCapabilities | Record<string, unknown>>('capabilities.get', query, options),
    {
      get: (query: { provider?: string } = {}, options?: RequestOptions) =>
        this.call<RuntimeCapabilities | Record<string, unknown>>(
          'capabilities.get',
          query,
          options,
        ),
    },
  );
  readonly events = Object.assign((options: EventOptions = {}) => this.iterateEvents(options), {
    read: (options: Omit<EventOptions, 'signal' | 'timeoutMs'> = {}, request?: RequestOptions) =>
      this.call<EventPage>('events.read', options, request),
  });
  private async *iterateEvents(options: EventOptions): AsyncGenerator<EventEnvelope> {
    let cursor = options.afterCursor ?? '0';
    let storeId = options.storeId;
    while (!this.closed) {
      aborted(options.signal);
      const params: Record<string, unknown> = { afterCursor: cursor };
      if (storeId !== undefined) params.storeId = storeId;
      if (options.taskId !== undefined) params.taskId = options.taskId;
      if (options.limit !== undefined) params.limit = options.limit;
      const page = await this.call<EventPage>('events.read', params, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      storeId = page.storeId;
      for (const event of page.events) {
        aborted(options.signal);
        yield event;
      }
      cursor = page.cursor;
      if (!page.events.length) await sleep(50, options.signal);
    }
  }
  async close(
    options: CloseOptions = {},
  ): Promise<{ status: 'closed'; operationId: string } | void> {
    if (this.closed) return this.closeResult;
    if (!this.owner) {
      this.closed = true;
      this.caller.disconnect();
      return;
    }
    try {
      const params = {
        mode: options.mode ?? 'drain',
        timeoutMs: options.timeoutMs ?? 30_000,
        ...(options.operationId ? { operationId: options.operationId } : {}),
      };
      const result = await this.call<{ status: 'closed'; operationId: string }>(
        options.operationId ? 'host.shutdown.continue' : 'host.shutdown',
        params,
        // Allow the host its full cleanup budget plus time to return its final receipt.
        { timeoutMs: params.timeoutMs + 1000 },
      );
      this.closeResult = result;
      this.closed = true;
      this.caller.disconnect();
      return result;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'SHUTDOWN_INCOMPLETE'
      ) {
        const failure = error as {
          client?: unknown;
          operationId?: string;
          data?: Record<string, unknown>;
        };
        failure.client = this;
        if (!failure.operationId && typeof failure.data?.operationId === 'string')
          failure.operationId = failure.data.operationId;
      }
      throw error;
    }
  }
}

async function initialize(caller: Caller, owner: boolean) {
  try {
    const info = await caller.call<InitializeResult>(
      'initialize',
      { protocolVersion: '1.0', sdkVersion: '0.1.0' },
      { timeoutMs: 5000 },
    );
    if (info.protocolVersion !== '1.0')
      throw new OrchestratorError('PROTOCOL_MISMATCH', 'Host did not negotiate protocol 1.0');
    return new Orchestrator(caller, info, owner);
  } catch (error) {
    caller.disconnect();
    throw error;
  }
}
export async function createOrchestrator(config: EngineConfig): Promise<Orchestrator> {
  const engine = await createEngine(config);
  const caller: Caller = {
    call: async <T>(
      method: string,
      params: Record<string, unknown> = {},
      options: RequestOptions = {},
    ) => {
      aborted(options.signal);
      return (await engine.call(method, params, { owner: true, signal: options.signal })) as T;
    },
    disconnect() {},
  };
  try {
    return await initialize(caller, true);
  } catch (error) {
    await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
    throw error;
  }
}
export async function connectOrchestrator(options: {
  socketPath: string;
  timeoutMs?: number;
  requestTimeoutMs?: number;
}): Promise<Orchestrator> {
  const caller = await UnixRpcClient.connect(
    options.socketPath,
    options.timeoutMs,
    options.requestTimeoutMs,
  );
  return initialize(caller, false);
}
