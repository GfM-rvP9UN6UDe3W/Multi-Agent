import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { OrchestrationError, fail } from './errors.ts';
import { object, fields, string, integer, taskSpec, messageSpec, digest } from './validation.ts';
import type {
  Engine,
  EngineConfig,
  CallContext,
  CloseOptions,
  TaskSnapshot,
  SessionSnapshot,
  OperationSnapshot,
  ApprovalRequest,
  MessageSnapshot,
  RuntimeAdapter,
  RuntimeEvent,
  UsageRecord,
  Json,
  SessionControlTarget,
  EngineClock,
  LifecycleTimeouts,
  OperationLifecycle,
  ExecutionLease,
  ExecutionBudget,
  ExecutionBudgetSummary,
  ExecutionEvidence,
  ExecutionConflict,
  SchedulerSnapshot,
} from './types.ts';
export * from './types.ts';
export { OrchestrationError } from './errors.ts';
export { createFakeAdapter } from './fake.ts';

const terminalTasks = new Set(['completed', 'failed', 'cancelled']);
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultTimeouts: Required<LifecycleTimeouts> = {
  acceptanceMs: 30_000,
  turnMs: 1_800_000,
  drainMs: 300_000,
  interruptMs: 30_000,
  reconcileMs: 60_000,
};
const realClock: EngineClock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

function resultText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 524288)
    fail(
      'VALIDATION_ERROR',
      'result must be a string (max 524288); empty output is preserved for human review',
    );
  return value;
}
function resultPreview(text: string, artifactRef: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= 64 * 1024) return text;
  let end = 64 * 1024;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8') + `\n[预览已截断；完整结果见产物 ${artifactRef}]`;
}
interface Dispatch extends Record<string, unknown> {
  id: string;
  taskId: string;
  sessionId: string;
  generation: number;
  status: string;
  executionLease: ExecutionLease;
  quarantined: boolean;
  quarantinedAt?: string;
  budget?: ExecutionBudgetSummary;
  lastEvidence: string;
  provider?: string;
  providerSessionId?: string | null;
  providerTurnId?: string | null;
  executionEvidence?: ExecutionEvidence;
  executionEvidenceRef?: string;
  evidenceSequence?: number;
  terminalCertificate?: ExecutionEvidence;
  terminalCertificateRef?: string;
  preSubmissionEvidenceRef?: string;
  executionState?: {
    localResources: 'stopped' | 'unknown' | 'active';
    remoteExecution: 'stopped' | 'unknown' | 'active';
    localEvidenceRef?: string;
    remoteEvidenceRef?: string;
  };
  terminalCoversExecution?: boolean;
}
interface Flight {
  taskId: string;
  sessionId: string;
  dispatchId: string;
  generation: number;
  messageIds: string[];
  controller: AbortController;
  promise: Promise<void>;
  intent: 'cancel' | 'pause' | 'shutdown' | null;
  controlIds: string[];
  expired: boolean;
  cancelTimers: (() => void)[];
  deadlineChecks: (() => void)[];
  cancelAcceptance?: () => void;
  budget: ExecutionBudget;
}

class LocalEngine implements Engine {
  readonly instanceId = randomUUID();
  readonly storeId: string;
  private store: Store;
  private config: EngineConfig;
  private adapters: Map<string, RuntimeAdapter>;
  private flights = new Map<string, Flight>();
  private closing = false;
  private closed = false;
  private scheduled = false;
  private shutdownId: string | undefined;
  private closeAdaptersPromise: Promise<void> | undefined;
  private pendingResourceCleanups = new Map<
    string,
    { commit: () => void; applied: boolean; settling?: boolean }
  >();
  private clock: EngineClock;
  private timeouts: Required<LifecycleTimeouts>;

  constructor(config: EngineConfig) {
    string(config.workspace, 'workspace');
    string(config.stateDir, 'stateDir');
    if (!Array.isArray(config.adapters) || !config.adapters.length)
      fail('VALIDATION_ERROR', 'At least one explicit adapter is required');
    this.adapters = new Map();
    for (const adapter of config.adapters) {
      string(adapter.provider, 'provider', 128);
      if (this.adapters.has(adapter.provider)) fail('VALIDATION_ERROR', 'Duplicate provider');
      this.adapters.set(adapter.provider, adapter);
    }
    integer(config.limits?.maxActiveSessions ?? 2, 'maxActiveSessions', 1, 2);
    integer(
      config.limits?.maxQuarantinedDispatches ?? 32,
      'maxQuarantinedDispatches',
      config.limits?.maxActiveSessions ?? 2,
      1024,
    );
    integer(config.limits?.maxTurnsPerTask ?? 20, 'maxTurnsPerTask', 1, 1000);
    integer(config.approvalTtlMs ?? 86400000, 'approvalTtlMs', 1, 604800000);
    const timeouts = object(config.timeouts ?? {}, 'timeouts');
    fields(timeouts, Object.keys(defaultTimeouts));
    this.timeouts = { ...defaultTimeouts };
    for (const key of Object.keys(defaultTimeouts) as (keyof LifecycleTimeouts)[])
      this.timeouts[key] = integer(
        timeouts[key] ?? defaultTimeouts[key],
        `timeouts.${key}`,
        1,
        86400000,
      );
    this.clock = config.clock ?? realClock;
    for (const [provider, options] of Object.entries(config.providers ?? {})) {
      const adapter = this.adapters.get(provider);
      if (!adapter) fail('VALIDATION_ERROR', `No adapter for ${provider}`);
      if (options.model !== undefined) string(options.model, 'model', 256);
      const profile = options.permissionProfile ?? 'read-only';
      if (!adapter.capabilities().permissionProfiles.includes(profile))
        fail('UNSUPPORTED_CAPABILITY', `Provider ${provider} cannot enforce ${profile}`);
    }
    this.config = config;
    this.store = new Store(config.workspace, config.stateDir);
    this.storeId = this.store.storeId;
    try {
      this.recover();
    } catch (error) {
      this.store.close();
      throw error;
    }
  }

  private ensureOpen(): void {
    if (this.closed) fail('CLIENT_CLOSED', 'Engine is closed');
  }
  private time(): string {
    return new Date(this.clock.wallNow()).toISOString();
  }
  private deadline(session: SessionSnapshot, kind: OperationLifecycle['kind']): OperationLifecycle {
    const duration = kind === 'shutdown' ? 30000 : this.timeouts[`${kind}Ms`];
    return {
      enteredAt: this.time(),
      deadlineAt: new Date(this.clock.wallNow() + duration).toISOString(),
      policyVersion: 1,
      kind,
      expectedGeneration: session.generation,
      expectedDispatchId: session.activeDispatchId,
      mayHaveBeenSent: kind === 'interrupt' && session.activeDispatchId !== null,
      lastEvidence: session.providerSessionId ? 'runtime_accepted' : 'dispatch_persisted',
    };
  }
  private arm(flight: Flight, duration: number, reason: string, operationId?: string): () => void {
    const end = this.clock.monotonicNow() + duration;
    let stopped = false;
    let cancel: () => void = () => {};
    const check = () => {
      if (stopped || this.closed || !this.live(flight)) return;
      if (operationId && this.store.operation(operationId).status !== 'persisted') return;
      const remaining = end - this.clock.monotonicNow();
      if (remaining > 0) return;
      try {
        this.expire(flight, reason);
      } catch (error) {
        this.closing = true;
        process.emitWarning(`Deadline persistence failed; scheduler stopped: ${String(error)}`);
      }
    };
    const tick = () => {
      check();
      const remaining = end - this.clock.monotonicNow();
      if (!stopped && !this.closed && remaining > 0) cancel = this.clock.setTimer(tick, remaining);
    };
    cancel = this.clock.setTimer(tick, duration);
    const stop = () => {
      stopped = true;
      cancel();
    };
    flight.cancelTimers.push(stop);
    flight.deadlineChecks.push(check);
    return stop;
  }
  private expire(flight: Flight, reason: string): void {
    if (!this.live(flight) || flight.expired) return;
    this.store.transaction(() => {
      const session = this.session(flight.sessionId),
        task = this.task(flight.taskId);
      this.saveSession(session, 'outcome_unknown');
      this.saveTask(task, 'blocked', `outcome_unknown: ${reason}`);
      const dispatch = this.store.require<Record<string, unknown>>('dispatches', flight.dispatchId);
      this.store.put('dispatches', flight.dispatchId, {
        ...dispatch,
        status: 'outcome_unknown',
        quarantined: true,
        quarantinedAt: dispatch.quarantinedAt ?? this.time(),
        expiredAt: this.time(),
        timeoutReason: reason,
      });
      this.messagesStatus(flight, 'outcome_unknown');
      for (const id of flight.controlIds) {
        const op = this.store.operation(id);
        if (op.status !== 'persisted') continue;
        op.status = 'outcome_unknown';
        op.error = { code: 'OUTCOME_UNKNOWN', message: reason };
        if (op.lifecycle) op.lifecycle.expiredAt = this.time();
        this.store.saveOperation(op);
        this.store.event(
          'operation.updated',
          { status: op.status, reason },
          { operationId: id, taskId: task.id, sessionId: session.id },
        );
      }
      this.store.event(
        'dispatch.deadline_exceeded',
        { dispatchId: flight.dispatchId, reason },
        { taskId: task.id, sessionId: session.id },
      );
      this.taskEvent(task);
      this.admissionEvent();
    });
    flight.expired = true;
    for (const cancel of flight.cancelTimers) cancel();
  }
  private ensureMutable(): void {
    this.ensureOpen();
    if (this.closing) fail('HOST_STOPPING', 'Engine is stopping');
  }
  private task(id: string): TaskSnapshot {
    return this.store.require('tasks', id);
  }
  private session(id: string): SessionSnapshot {
    return this.store.require('sessions', id);
  }
  private sessionSnapshot(id: string): SessionSnapshot {
    const session = this.session(id);
    if (session.activeDispatchId) {
      const d = this.store.require<Dispatch>('dispatches', session.activeDispatchId);
      session.execution = {
        dispatchId: d.id,
        lease: d.executionLease,
        quarantined: d.quarantined,
        lastEvidence: d.lastEvidence,
        ...(d.budget ? { budget: d.budget } : {}),
      };
    }
    return session;
  }
  private scheduler(): SchedulerSnapshot {
    const records = this.store.all<Dispatch>('dispatches');
    const held = records.filter((d) => d.executionLease?.status === 'held');
    const quarantined = records.filter((d) => d.quarantined);
    const reserved = held.filter((d) => !d.quarantined);
    const conflicts = this.store
      .all<ExecutionConflict>('execution_conflicts')
      .filter((c) => c.status === 'open');
    const maxActiveSessions = this.config.limits?.maxActiveSessions ?? 2;
    const maxQuarantinedDispatches = this.config.limits?.maxQuarantinedDispatches ?? 32;
    const reasons: string[] = [];
    if (held.length >= maxActiveSessions) reasons.push('EXECUTION_CAPACITY_EXHAUSTED');
    if (quarantined.length + reserved.length >= maxQuarantinedDispatches)
      reasons.push('QUARANTINE_CAPACITY_EXCEEDED');
    if (this.closing) reasons.push('HOST_STOPPING');
    if (this.pendingResourceCleanups.size) reasons.push('RESOURCE_CLEANUP_PENDING');
    if (conflicts.length) reasons.push('EXECUTION_EVIDENCE_CONFLICT');
    const occupants = records.filter((d) => d.executionLease?.status === 'held' || d.quarantined);
    return {
      maxActiveSessions,
      maxQuarantinedDispatches,
      executionOccupied: held.length,
      quarantined: quarantined.length,
      quarantineReserved: reserved.length,
      canDispatch: reasons.length === 0,
      reasons,
      occupants: occupants.slice(0, 16).map((d) => ({
        taskId: d.taskId,
        sessionId: d.sessionId,
        dispatchId: d.id,
        leaseStatus: d.executionLease.status,
        quarantined: d.quarantined,
        lastEvidence: d.lastEvidence,
        enteredAt: d.quarantinedAt ?? d.executionLease.acquiredAt,
      })),
      truncated: occupants.length > 16,
      openConflicts: conflicts.length,
      conflicts: conflicts
        .slice(0, 16)
        .map((c) => ({ conflictId: c.id, revision: c.revision, dispatchId: c.dispatchId })),
      conflictsTruncated: conflicts.length > 16,
    };
  }
  private admissionEvent(): void {
    const snapshot = this.scheduler();
    const value = JSON.stringify(snapshot.reasons);
    const prior = this.store.db
      .prepare('SELECT value FROM metadata WHERE key=?')
      .get('admissionReasons') as { value: string } | undefined;
    if (prior?.value === value || (!prior && !snapshot.reasons.length)) return;
    this.store.db
      .prepare(
        'INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run('admissionReasons', value);
    this.store.event('scheduler.admission_changed', {
      reasons: snapshot.reasons,
      executionOccupied: snapshot.executionOccupied,
      quarantined: snapshot.quarantined,
      quarantineReserved: snapshot.quarantineReserved,
    });
  }
  private admitWork(): void {
    if (this.scheduler().reasons.includes('QUARANTINE_CAPACITY_EXCEEDED'))
      fail(
        'QUARANTINE_CAPACITY_EXCEEDED',
        'Quarantine capacity is reserved or occupied; reconcile existing results before adding work',
      );
  }
  private stopProof(d: Dispatch): boolean {
    const e = d.executionEvidence;
    const state = d.executionState ?? e;
    if (!state || state.localResources !== 'stopped' || state.remoteExecution !== 'stopped')
      return false;
    if (d.preSubmissionEvidenceRef || e?.source === 'pre_submission')
      return !d.runtimeAccepted && !d.terminalCertificate;
    const t = d.terminalCertificate?.terminal;
    return (
      d.terminalCoversExecution === true &&
      !!t &&
      (t.type === 'result' ||
        t.type === 'interrupted' ||
        (t.type === 'error' && t.outcome === 'failed'))
    );
  }
  private release(d: Dispatch, evidenceRef: string, reason: string): void {
    if (d.executionLease.status === 'released') return;
    if (reason === 'runtime_stop_and_cleanup')
      evidenceRef = this.store.artifact(
        JSON.stringify({
          instanceId: this.instanceId,
          dispatchId: d.id,
          taskId: d.taskId,
          sessionId: d.sessionId,
          generation: d.generation,
          provider: d.provider,
          providerSessionId: d.providerSessionId,
          providerTurnId: d.providerTurnId,
          terminalEvidenceRef: d.terminalCertificateRef ?? null,
          preSubmissionEvidenceRef: d.preSubmissionEvidenceRef ?? null,
          state: d.executionState ?? null,
          latestObservationRef: evidenceRef,
          occurredAt: this.time(),
        }),
      );
    d.executionLease = {
      ...d.executionLease,
      status: 'released',
      releasedAt: this.time(),
      releaseReason: reason,
      releaseEvidenceRef: evidenceRef,
    };
    this.store.put('dispatches', d.id, d);
    this.store.event(
      'execution.released',
      {
        dispatchId: d.id,
        generation: d.generation,
        evidenceRef,
        reason,
        quarantined: d.quarantined,
      },
      { taskId: d.taskId, sessionId: d.sessionId },
    );
  }
  private reevaluateRelease(dispatchId: string): void {
    if (this.closed) return;
    this.store.transaction(() => {
      const d = this.store.require<Dispatch>('dispatches', dispatchId);
      if (
        this.flights.has(d.sessionId) ||
        this.adapters
          .get(d.provider ?? this.session(d.sessionId).provider)
          ?.hasActiveResources?.(d.sessionId)
      )
        return;
      if (this.stopProof(d)) this.release(d, d.executionEvidenceRef!, 'runtime_stop_and_cleanup');
      this.admissionEvent();
    });
    this.kick();
  }
  private reportEvidence(flight: Flight, provider: string, evidence: ExecutionEvidence): void {
    if (this.closed) return;
    try {
      this.store.transaction(() => {
        const d = this.store.require<Dispatch>('dispatches', flight.dispatchId);
        const session = this.session(flight.sessionId);
        if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
          this.store.event(
            'execution.evidence_rejected',
            { dispatchId: d.id, reason: 'malformed_evidence' },
            { taskId: d.taskId, sessionId: d.sessionId },
          );
          return;
        }
        const terminal = evidence.terminal;
        const validTerminal =
          terminal === undefined
            ? evidence.source !== 'runtime_terminal'
            : !terminal || typeof terminal !== 'object' || Array.isArray(terminal)
              ? false
              : terminal.type === 'result'
                ? typeof terminal.text === 'string' &&
                  terminal.text.length <= 524288 &&
                  (!terminal.providerSessionId ||
                    terminal.providerSessionId === evidence.providerSessionId)
                : terminal.type === 'interrupted' ||
                  (terminal.type === 'error' &&
                    typeof terminal.message === 'string' &&
                    ['failed', 'unknown'].includes(terminal.outcome));
        const valid =
          validTerminal &&
          typeof evidence.detail === 'string' &&
          evidence.detail.length > 0 &&
          evidence.detail.length <= 65536 &&
          (evidence.providerSessionId === null ||
            (typeof evidence.providerSessionId === 'string' &&
              evidence.providerSessionId.length > 0 &&
              evidence.providerSessionId.length <= 256)) &&
          (evidence.providerTurnId === undefined ||
            evidence.providerTurnId === null ||
            (typeof evidence.providerTurnId === 'string' &&
              evidence.providerTurnId.length > 0 &&
              evidence.providerTurnId.length <= 256)) &&
          evidence.version === 1 &&
          Number.isSafeInteger(evidence.sequence) &&
          evidence.sequence > 0 &&
          evidence.dispatchId === d.id &&
          evidence.sessionId === d.sessionId &&
          evidence.generation === d.generation &&
          session.generation === d.generation &&
          evidence.provider === provider &&
          (!d.providerSessionId || evidence.providerSessionId === d.providerSessionId) &&
          (!d.providerTurnId || evidence.providerTurnId === d.providerTurnId) &&
          ['pre_submission', 'runtime_terminal', 'resource_observation'].includes(
            evidence.source,
          ) &&
          Number.isFinite(Date.parse(evidence.observedAt)) &&
          ['stopped', 'unknown', 'active'].includes(evidence.localResources) &&
          ['stopped', 'unknown', 'active'].includes(evidence.remoteExecution);
        if (!valid) {
          this.store.event(
            'execution.evidence_rejected',
            { dispatchId: d.id, reason: 'identity_or_contract_mismatch' },
            { taskId: d.taskId, sessionId: d.sessionId },
          );
          return;
        }
        if (evidence.sequence <= (d.evidenceSequence ?? 0)) return;
        const ref = this.store.artifact(
          JSON.stringify({ instanceId: this.instanceId, taskId: d.taskId, evidence }),
        );
        d.evidenceSequence = evidence.sequence;
        d.executionEvidence = evidence;
        d.executionEvidenceRef = ref;
        d.lastEvidence = evidence.source;
        d.providerSessionId ??= evidence.providerSessionId;
        d.providerTurnId ??= evidence.providerTurnId;
        const previousState = d.executionState ?? {
          localResources: 'unknown',
          remoteExecution: 'unknown',
        };
        d.executionState = {
          ...previousState,
          ...(evidence.localResources !== 'unknown'
            ? { localResources: evidence.localResources, localEvidenceRef: ref }
            : {}),
          ...(evidence.remoteExecution !== 'unknown'
            ? { remoteExecution: evidence.remoteExecution, remoteEvidenceRef: ref }
            : {}),
        };
        if (evidence.source === 'pre_submission') d.preSubmissionEvidenceRef = ref;
        if (evidence.source === 'runtime_terminal' && evidence.terminal) {
          d.terminalCertificate = evidence;
          d.terminalCertificateRef = ref;
        }
        if (
          d.executionLease.status === 'released' &&
          (evidence.localResources === 'active' || evidence.remoteExecution === 'active')
        ) {
          const conflict: ExecutionConflict = {
            id: randomUUID(),
            revision: 1,
            dispatchId: d.id,
            sessionId: d.sessionId,
            taskId: d.taskId,
            generation: d.generation,
            status: 'open',
            releaseEvidenceRef: d.executionLease.releaseEvidenceRef ?? null,
            conflictingEvidenceRef: ref,
            createdAt: this.time(),
          };
          this.store.put('execution_conflicts', conflict.id, conflict);
          this.store.event(
            'execution.evidence_conflict',
            {
              conflictId: conflict.id,
              dispatchId: d.id,
              generation: d.generation,
              evidenceRef: ref,
              reason: 'EXECUTION_EVIDENCE_CONFLICT',
            },
            { taskId: d.taskId, sessionId: d.sessionId },
          );
        }
        this.store.put('dispatches', d.id, d);
        this.admissionEvent();
      });
      if (!this.flights.has(flight.sessionId)) this.reevaluateRelease(flight.dispatchId);
    } catch (error) {
      this.closing = true;
      process.emitWarning(
        `Execution evidence persistence failed; scheduler stopped: ${String(error)}`,
      );
    }
  }

  private saveTask(
    task: TaskSnapshot,
    status?: TaskSnapshot['status'],
    reason?: string | null,
  ): void {
    if (status) task.status = status;
    if (reason !== undefined) task.reason = reason;
    task.revision++;
    task.updatedAt = now();
    this.store.put('tasks', task.id, task);
  }
  private saveSession(session: SessionSnapshot, status?: SessionSnapshot['status']): void {
    if (status) session.status = status;
    session.revision++;
    this.store.put('sessions', session.id, session);
  }
  private taskEvent(task: TaskSnapshot, operationId?: string): void {
    this.store.event(
      `task.${task.status}`,
      { status: task.status, reason: task.reason, revision: task.revision },
      { taskId: task.id, sessionId: task.sessionId, operationId },
    );
  }
  private operation(
    method: string,
    scope: string,
    key: string,
    payload: unknown,
    mutate: (op: OperationSnapshot) => void,
  ): OperationSnapshot {
    string(key, 'idempotencyKey', 256);
    const hash = digest(payload);
    const existing = this.store.findOperation(method, scope, key);
    if (existing) {
      if (existing.digest !== hash)
        fail('IDEMPOTENCY_CONFLICT', 'Key was already used with different payload');
      return existing.operation;
    }
    // An owner must be able to attest unknown resources that prevented its shutdown.
    // Keep normal writes and storage-degraded instances outside this exception.
    if (method === 'sessions.reconcile' && this.shutdownId) this.ensureOpen();
    else this.ensureMutable();
    return this.store.transaction(() => {
      const op: OperationSnapshot = {
        id: randomUUID(),
        method,
        scope,
        idempotencyKey: key,
        status: 'completed',
        targetId: '',
        result: null,
        error: null,
      };
      mutate(op);
      this.store.saveOperation(op, hash);
      this.store.event(
        'operation.created',
        { status: op.status, targetId: op.targetId },
        { operationId: op.id },
      );
      return op;
    });
  }
  private recover(): void {
    this.store.transaction(() => {
      for (const task of this.store.all<TaskSnapshot>('tasks')) {
        const session = this.session(task.sessionId);
        if (task.status === 'running' || session.activeDispatchId) {
          const dispatchId = session.activeDispatchId;
          this.saveTask(
            task,
            'blocked',
            'outcome_unknown: previous owner exited during a dispatch',
          );
          this.saveSession(session, 'outcome_unknown'); // Keep dispatch ID for inspection, never replay it.
          if (dispatchId)
            this.store.put('dispatches', dispatchId, {
              ...this.store.get<Record<string, unknown>>('dispatches', dispatchId),
              status: 'outcome_unknown',
              quarantined: true,
              quarantinedAt:
                this.store.get<Dispatch>('dispatches', dispatchId)?.quarantinedAt ?? this.time(),
              executionLease: this.store.get<Dispatch>('dispatches', dispatchId)
                ?.executionLease ?? { version: 1, status: 'held', acquiredAt: this.time() },
            });
          for (const message of this.store.all<MessageSnapshot>('messages'))
            if (
              message.taskId === task.id &&
              ['dispatching', 'runtime_accepted'].includes(message.status)
            ) {
              message.status = 'outcome_unknown';
              this.store.put('messages', message.id, message);
              const outbox = this.store.get<Record<string, unknown>>('outbox', message.id);
              if (outbox)
                this.store.put('outbox', message.id, { ...outbox, status: 'outcome_unknown' });
            }
          this.taskEvent(task);
        } else if (task.status === 'queued') {
          this.saveTask(task, 'paused', 'owner_restart');
          this.saveSession(session, 'paused');
          this.taskEvent(task);
        }
      }
      for (const op of this.store.operations())
        if (op.status === 'persisted') {
          op.status = 'outcome_unknown';
          op.error = {
            code: 'OUTCOME_UNKNOWN',
            message: 'Previous owner exited before operation completion',
          };
          if (op.lifecycle && Date.parse(op.lifecycle.deadlineAt) <= this.clock.wallNow())
            op.lifecycle.expiredAt ??= this.time();
          this.store.saveOperation(op);
          this.store.event(
            'operation.updated',
            { status: op.status, reason: 'owner_restart' },
            { operationId: op.id },
          );
        }
      this.admissionEvent();
    });
  }
  private expireApprovals(): void {
    const expired = this.store
      .all<ApprovalRequest>('approvals')
      .filter((a) => a.status === 'pending' && Date.parse(a.expiresAt) <= Date.now());
    if (!expired.length) return;
    this.store.transaction(() => {
      for (const approval of expired) {
        approval.status = 'expired';
        approval.revision++;
        this.store.put('approvals', approval.approvalId, approval);
        const task = this.task(approval.taskId);
        if (task.approvalId === approval.approvalId && task.status === 'waiting_approval') {
          this.saveTask(task, 'paused', 'approval_expired');
          this.saveSession(this.session(task.sessionId), 'paused');
          this.taskEvent(task);
        }
        this.store.event(
          'approval.expired',
          { approvalId: approval.approvalId, revision: approval.revision },
          { taskId: task.id, sessionId: task.sessionId },
        );
      }
    });
  }
  private invalidateApproval(task: TaskSnapshot): void {
    if (!task.approvalId) return;
    const approval = this.store.get<ApprovalRequest>('approvals', task.approvalId);
    if (approval?.status === 'pending') {
      approval.status = 'invalidated';
      approval.revision++;
      this.store.put('approvals', approval.approvalId, approval);
    }
    task.approvalId = null;
  }
  private requestApproval(task: TaskSnapshot): void {
    this.invalidateApproval(task);
    const id = randomUUID();
    task.approvalId = id;
    this.saveTask(task, 'waiting_approval', null);
    const approval: ApprovalRequest = {
      approvalId: id,
      taskId: task.id,
      purpose: 'task_acceptance',
      revision: 1,
      status: 'pending',
      target: {
        taskId: task.id,
        taskRevision: task.revision,
        artifactRefs: [...task.artifactRefs],
      },
      summary: task.result ?? '',
      evidenceRefs: [...task.artifactRefs],
      expiresAt: new Date(Date.now() + (this.config.approvalTtlMs ?? 86400000)).toISOString(),
    };
    this.store.put('approvals', id, approval);
    this.taskEvent(task);
    this.store.event(
      'approval.requested',
      {
        approvalId: id,
        purpose: approval.purpose,
        revision: 1,
        target: approval.target,
        summary: approval.summary,
        evidenceRefs: approval.evidenceRefs,
        expiresAt: approval.expiresAt,
      },
      { taskId: task.id, sessionId: task.sessionId },
    );
  }

  private resumePausedTask(
    task: TaskSnapshot,
    session: SessionSnapshot,
    operationId: string,
  ): void {
    if (
      task.status === 'paused' &&
      !(
        ['approval_expired', 'reconciled_result'].includes(task.reason ?? '') &&
        task.result !== null
      )
    ) {
      this.admitWork();
      const adapter = this.adapters.get(session.provider);
      if (!adapter)
        fail('UNSUPPORTED_CAPABILITY', 'The original runtime provider is not configured');
      this.adapterBudget(adapter);
    }
    this.saveSession(session, 'idle');
    if (task.status !== 'paused') return;
    if (
      ['approval_expired', 'reconciled_result'].includes(task.reason ?? '') &&
      task.result !== null
    ) {
      this.requestApproval(task);
    } else {
      this.saveTask(task, 'queued', null);
      this.taskEvent(task, operationId);
    }
  }

  async call(
    method: string,
    raw: Record<string, unknown> = {},
    context: CallContext = {},
  ): Promise<unknown> {
    this.ensureOpen();
    const p = object(raw);
    if (!['scheduler.get', 'scheduler.getConflict'].includes(method)) this.expireApprovals();
    switch (method) {
      case 'initialize': {
        fields(p, ['protocolVersion', 'sdkVersion']);
        if (p.protocolVersion !== '1.0') fail('PROTOCOL_MISMATCH', 'Expected protocolVersion 1.0');
        string(p.sdkVersion, 'sdkVersion', 128);
        return {
          protocolVersion: '1.0',
          engineVersion: '0.1.0',
          schemaVersion: 2,
          instanceId: this.instanceId,
          storeId: this.storeId,
          capabilities: {
            events: 'cursor-pull',
            acceptance: ['human'],
            providers: [...this.adapters.keys()],
            lifecycle: { version: 1, reconcile: 'owner-attestation', durableDeadlines: true },
            executionIsolation: {
              version: 1,
              resourceRelease: true,
              schedulerStatus: true,
              ownerConflictResolution: true,
              budgetVersion: 2,
            },
          },
        };
      }
      case 'tasks.create': {
        fields(p, ['spec', 'idempotencyKey']);
        const spec = taskSpec(p.spec);
        const adapter = this.adapters.get(spec.runtime.provider);
        if (!adapter) fail('VALIDATION_ERROR', 'Provider is not configured');
        const configured = this.config.providers?.[spec.runtime.provider];
        if (configured?.model && configured.model !== spec.runtime.model)
          fail('VALIDATION_ERROR', 'Model does not match configured provider');
        if (
          !adapter
            .capabilities()
            .permissionProfiles.includes(configured?.permissionProfile ?? 'read-only')
        )
          fail('UNSUPPORTED_CAPABILITY', 'Permission profile is unsupported');
        const op = this.operation(
          method,
          'local',
          string(p.idempotencyKey, 'idempotencyKey'),
          spec,
          (op) => {
            this.admitWork();
            this.adapterBudget(adapter);
            const id = randomUUID(),
              sessionId = randomUUID(),
              time = now();
            const task: TaskSnapshot = {
              id,
              sessionId,
              spec,
              status: 'queued',
              revision: 1,
              artifactRefs: [],
              result: null,
              reason: null,
              approvalId: null,
              createdAt: time,
              updatedAt: time,
            };
            const session: SessionSnapshot = {
              id: sessionId,
              taskId: id,
              provider: spec.runtime.provider,
              model: spec.runtime.model,
              providerSessionId: null,
              generation: 1,
              revision: 1,
              status: 'idle',
              activeDispatchId: null,
            };
            this.store.put('tasks', id, task);
            this.store.put('sessions', sessionId, session);
            op.targetId = id;
            op.result = { taskId: id };
            this.store.event(
              'task.created',
              { status: task.status },
              { taskId: id, sessionId, operationId: op.id },
            );
          },
        );
        this.kick();
        return this.task(op.targetId);
      }
      case 'tasks.get':
        fields(p, ['taskId']);
        return this.task(string(p.taskId, 'taskId', 128));
      case 'sessions.get':
        fields(p, ['sessionId']);
        return this.sessionSnapshot(string(p.sessionId, 'sessionId', 128));
      case 'scheduler.get':
        fields(p, []);
        return this.store.transaction(() => this.scheduler());
      case 'scheduler.getConflict':
        fields(p, ['conflictId']);
        return this.store.require<ExecutionConflict>(
          'execution_conflicts',
          string(p.conflictId, 'conflictId', 128),
        );
      case 'scheduler.resolveConflict':
        if (!context.owner)
          fail('UNAUTHORIZED', 'Only the host owner may resolve execution evidence conflicts');
        return this.resolveConflict(p);
      case 'tasks.resume': {
        fields(p, ['taskId', 'idempotencyKey']);
        const id = string(p.taskId, 'taskId', 128);
        const op = this.operation(
          method,
          id,
          string(p.idempotencyKey, 'idempotencyKey'),
          { taskId: id },
          (op) => {
            const task = this.task(id),
              session = this.session(task.sessionId);
            op.targetId = id;
            if (task.status === 'blocked' || session.status === 'outcome_unknown')
              fail('OUTCOME_UNKNOWN', 'Inspect the unresolved dispatch before resuming');
            if (terminalTasks.has(task.status)) fail('STALE_TARGET', 'Task is terminal');
            if (task.status !== 'paused') {
              op.status = 'noop';
              return;
            }
            this.resumePausedTask(task, session, op.id);
            op.result = { taskId: id };
          },
        );
        this.kick();
        return op;
      }
      case 'tasks.cancel': {
        fields(p, ['taskId', 'idempotencyKey']);
        const id = string(p.taskId, 'taskId', 128);
        const op = this.operation(
          method,
          id,
          string(p.idempotencyKey, 'idempotencyKey'),
          { taskId: id },
          (op) => {
            const task = this.task(id);
            op.targetId = id;
            if (terminalTasks.has(task.status)) {
              op.status = 'noop';
              return;
            }
            const session = this.session(task.sessionId),
              flight = this.flights.get(session.id);
            if (session.status === 'outcome_unknown')
              fail('OUTCOME_UNKNOWN', 'Cannot confirm cancellation of an unknown dispatch');
            if (flight) {
              if (!this.adapters.get(session.provider)!.capabilities().interrupt)
                fail('UNSUPPORTED_CAPABILITY', 'Runtime cannot interrupt');
              for (const id of flight.controlIds) {
                const previous = this.store.operation(id);
                if (previous.method === 'sessions.control' && previous.status === 'persisted') {
                  previous.status = 'rejected';
                  previous.error = {
                    code: 'STALE_TARGET',
                    message: 'Pause was superseded by task cancellation',
                  };
                  this.store.saveOperation(previous);
                  this.store.event(
                    'operation.updated',
                    { status: previous.status },
                    { operationId: id, taskId: task.id, sessionId: task.sessionId },
                  );
                }
              }
              op.status = 'persisted';
              op.lifecycle = this.deadline(session, 'interrupt');
            } else {
              this.invalidateApproval(task);
              this.saveTask(task, 'cancelled', 'cancelled_by_client');
              this.saveSession(session, 'idle');
              this.taskEvent(task, op.id);
            }
          },
        );
        if (op.status === 'persisted') {
          const flight = this.flights.get(this.task(id).sessionId);
          if (flight) {
            flight.intent = 'cancel';
            if (!flight.controlIds.includes(op.id)) {
              flight.controlIds.push(op.id);
              this.arm(flight, this.timeouts.interruptMs, 'interrupt deadline exceeded', op.id);
            }
            flight.controller.abort();
          }
        }
        return op;
      }
      case 'sessions.control':
        return this.control(p);
      case 'sessions.reconcile':
        if (!context.owner)
          fail('UNAUTHORIZED', 'Only the host owner may attest reconciliation evidence');
        return this.reconcile(p);
      case 'messages.send': {
        fields(p, ['spec', 'idempotencyKey']);
        const spec = messageSpec(p.spec);
        const key = string(p.idempotencyKey, 'idempotencyKey');
        const op = this.operation(method, spec.toSessionId, key, spec, (op) => {
          this.admitWork();
          const task = this.task(spec.taskId),
            session = this.session(spec.toSessionId);
          if (session.taskId !== task.id || task.sessionId !== session.id)
            fail('UNAUTHORIZED', 'Session is outside the target task');
          if (session.generation !== spec.expectedGeneration)
            fail('STALE_TARGET', 'Session generation changed');
          if (terminalTasks.has(task.status))
            fail('STALE_TARGET', 'Cannot send to a terminal task');
          const id = randomUUID();
          const message: MessageSnapshot = {
            ...spec,
            id,
            fromSessionId: 'client:local',
            idempotencyKey: key,
            status: 'persisted',
          };
          this.store.put('messages', id, message);
          this.store.put('outbox', id, { id, sessionId: session.id, status: 'persisted' });
          op.targetId = id;
          op.result = { messageId: id };
          this.store.event(
            'message.persisted',
            { messageId: id, status: 'persisted' },
            { taskId: task.id, sessionId: session.id, operationId: op.id },
          );
        });
        this.kick();
        return this.store.require<MessageSnapshot>('messages', op.targetId);
      }
      case 'messages.get':
        fields(p, ['messageId']);
        return this.store.require<MessageSnapshot>(
          'messages',
          string(p.messageId, 'messageId', 128),
        );
      case 'operations.get':
        fields(p, ['operationId']);
        return this.store.operation(string(p.operationId, 'operationId', 128));
      case 'operations.lookup': {
        fields(p, ['method', 'scope', 'idempotencyKey']);
        const result = this.store.findOperation(
          string(p.method, 'method', 128),
          string(p.scope, 'scope', 128),
          string(p.idempotencyKey, 'idempotencyKey', 256),
        );
        if (!result) fail('NOT_FOUND', 'Idempotent operation not found');
        return result.operation;
      }
      case 'approvals.get':
        fields(p, ['approvalId']);
        return this.store.require<ApprovalRequest>(
          'approvals',
          string(p.approvalId, 'approvalId', 128),
        );
      case 'approvals.decide': {
        fields(p, ['approvalId', 'decision', 'idempotencyKey']);
        const id = string(p.approvalId, 'approvalId', 128),
          decision = object(p.decision, 'decision');
        fields(decision, ['choice', 'expectedRevision']);
        if (!['approve', 'deny'].includes(decision.choice as string))
          fail('VALIDATION_ERROR', 'choice must be approve or deny');
        integer(decision.expectedRevision, 'expectedRevision', 1);
        const op = this.operation(
          method,
          id,
          string(p.idempotencyKey, 'idempotencyKey'),
          { approvalId: id, decision },
          (op) => {
            const approval = this.store.require<ApprovalRequest>('approvals', id);
            const task = this.task(approval.taskId);
            if (
              approval.status !== 'pending' ||
              approval.revision !== decision.expectedRevision ||
              task.approvalId !== id ||
              task.status !== 'waiting_approval' ||
              approval.target.taskRevision !== task.revision
            )
              fail('STALE_TARGET', 'Approval is no longer current');
            approval.status = decision.choice === 'approve' ? 'approved' : 'denied';
            approval.revision++;
            this.store.put('approvals', id, approval);
            op.targetId = id;
            op.result = { taskId: task.id, choice: decision.choice as string };
            const pending = this.pendingMessages(task.sessionId);
            const session = this.session(task.sessionId);
            const nextStatus =
              decision.choice === 'deny'
                ? 'failed'
                : pending.length
                  ? session.status === 'paused'
                    ? 'paused'
                    : 'queued'
                  : 'completed';
            this.saveTask(
              task,
              nextStatus,
              decision.choice === 'deny'
                ? 'acceptance_denied'
                : nextStatus === 'paused'
                  ? 'paused_by_client'
                  : null,
            );
            if (nextStatus === 'queued') this.saveSession(session, 'idle');
            this.store.event(
              `approval.${approval.status}`,
              { approvalId: id, revision: approval.revision },
              { taskId: task.id, sessionId: task.sessionId, operationId: op.id },
            );
            this.taskEvent(task, op.id);
          },
        );
        this.kick();
        return op;
      }
      case 'events.read': {
        fields(p, ['afterCursor', 'storeId', 'taskId', 'limit']);
        return this.store.events(
          p.afterCursor === undefined ? '0' : string(p.afterCursor, 'afterCursor', 30),
          p.storeId === undefined ? undefined : string(p.storeId, 'storeId', 128),
          p.taskId === undefined ? undefined : string(p.taskId, 'taskId', 128),
          p.limit === undefined ? 100 : integer(p.limit, 'limit', 1, 1000),
        );
      }
      case 'usage.get': {
        fields(p, ['taskId']);
        const id = string(p.taskId, 'taskId', 128);
        this.task(id);
        const records = this.store.all<UsageRecord>('usage').filter((r) => r.taskId === id);
        return {
          records,
          completeness:
            records.length &&
            records.every((r) => r.inputTokens !== null && r.outputTokens !== null)
              ? 'reported'
              : 'unknown',
        };
      }
      case 'capabilities.get': {
        fields(p, ['provider']);
        if (p.provider !== undefined) {
          const adapter = this.adapters.get(string(p.provider, 'provider', 128));
          if (!adapter) fail('NOT_FOUND', 'Provider is not configured');
          return adapter.capabilities();
        }
        return Object.fromEntries(
          [...this.adapters].map(([key, adapter]) => [key, adapter.capabilities()]),
        );
      }
      case 'host.shutdown':
      case 'host.shutdown.continue': {
        if (!context.owner) fail('UNAUTHORIZED', 'Only the host owner can close the engine');
        fields(p, ['mode', 'timeoutMs', 'operationId', 'idempotencyKey']);
        if (method === 'host.shutdown.continue' && !p.operationId)
          fail('VALIDATION_ERROR', 'operationId is required');
        return this.close(p as CloseOptions);
      }
      case 'sessions.open':
      case 'sessions.fork':
        fail(
          'UNSUPPORTED_CAPABILITY',
          'Explicit session opening and forking are not in this increment',
        );
      default:
        fail('METHOD_NOT_FOUND', `Unknown method: ${method}`);
    }
  }

  private control(p: Record<string, unknown>): OperationSnapshot {
    fields(p, ['target', 'command', 'idempotencyKey']);
    const target = object(p.target, 'target');
    fields(target, [
      'sessionId',
      'expectedGeneration',
      'expectedRevision',
      'expectedDispatchId',
      'expectedState',
    ]);
    const sessionId = string(target.sessionId, 'sessionId', 128);
    integer(target.expectedGeneration, 'expectedGeneration', 1);
    integer(target.expectedRevision, 'expectedRevision', 1);
    string(target.expectedState, 'expectedState', 128);
    if (target.expectedDispatchId !== null)
      string(target.expectedDispatchId, 'expectedDispatchId', 128);
    const command = object(p.command, 'command');
    fields(command, ['action', 'mode']);
    if (!['pause', 'resume'].includes(command.action as string))
      fail('UNSUPPORTED_CAPABILITY', 'Only pause/resume are implemented');
    const mode = command.mode ?? 'drain';
    if (!['drain', 'interrupt'].includes(mode as string))
      fail('VALIDATION_ERROR', 'Invalid pause mode');
    const op = this.operation(
      'sessions.control',
      sessionId,
      string(p.idempotencyKey, 'idempotencyKey'),
      { target, command },
      (op) => {
        const session = this.session(sessionId),
          task = this.task(session.taskId);
        op.targetId = sessionId;
        if (
          session.generation !== target.expectedGeneration ||
          session.revision !== target.expectedRevision ||
          session.activeDispatchId !== target.expectedDispatchId ||
          session.status !== target.expectedState
        )
          fail('STALE_TARGET', 'Control target changed');
        if (session.status === 'outcome_unknown' || task.status === 'blocked')
          fail('OUTCOME_UNKNOWN', 'Session requires reconciliation');
        if (terminalTasks.has(task.status)) fail('STALE_TARGET', 'Task is terminal');
        const flight = this.flights.get(sessionId);
        if (flight?.intent === 'cancel')
          fail('STALE_TARGET', 'Task cancellation is already pending');
        if (command.action === 'resume') {
          if (flight) fail('STALE_TARGET', 'Cannot resume an active dispatch');
          if (session.status !== 'paused') {
            op.status = 'noop';
            return;
          }
          this.resumePausedTask(task, session, op.id);
        } else if (flight) {
          if (
            mode === 'interrupt' &&
            !this.adapters.get(session.provider)!.capabilities().interrupt
          )
            fail('UNSUPPORTED_CAPABILITY', 'Runtime cannot interrupt');
          op.status = 'persisted';
          op.lifecycle = this.deadline(session, mode as 'drain' | 'interrupt');
          this.saveSession(session, 'pausing');
        } else {
          if (session.status === 'paused') {
            op.status = 'noop';
            return;
          }
          this.saveSession(session, 'paused');
          if (task.status !== 'waiting_approval') {
            this.saveTask(task, 'paused', 'paused_by_client');
            this.taskEvent(task, op.id);
          }
        }
        this.store.event(
          `session.${session.status}`,
          { status: session.status, revision: session.revision },
          { taskId: task.id, sessionId, operationId: op.id },
        );
      },
    );
    if (op.status === 'persisted') {
      const flight = this.flights.get(sessionId);
      if (flight) {
        flight.intent = 'pause';
        if (!flight.controlIds.includes(op.id)) {
          flight.controlIds.push(op.id);
          this.arm(
            flight,
            mode === 'interrupt' ? this.timeouts.interruptMs : this.timeouts.drainMs,
            `${mode} deadline exceeded`,
            op.id,
          );
        }
        if (mode === 'interrupt') flight.controller.abort();
      }
    }
    this.kick();
    return op;
  }
  private pendingMessages(sessionId: string): MessageSnapshot[] {
    return this.store
      .all<MessageSnapshot>('messages')
      .filter((m) => m.toSessionId === sessionId && m.status === 'persisted');
  }

  private reconcile(p: Record<string, unknown>): OperationSnapshot {
    fields(p, ['target', 'evidence', 'idempotencyKey']);
    const target = object(p.target, 'target');
    fields(target, [
      'sessionId',
      'expectedGeneration',
      'expectedRevision',
      'expectedDispatchId',
      'expectedState',
    ]);
    const sessionId = string(target.sessionId, 'sessionId', 128);
    integer(target.expectedGeneration, 'expectedGeneration', 1);
    integer(target.expectedRevision, 'expectedRevision', 1);
    string(target.expectedDispatchId, 'expectedDispatchId', 128);
    string(target.expectedState, 'expectedState', 128);
    const evidence = object(p.evidence, 'evidence');
    fields(evidence, [
      'source',
      'summary',
      'localResources',
      'remoteExecution',
      'sideEffects',
      'outcome',
      'result',
    ]);
    if (evidence.source !== 'owner_attestation')
      fail('VALIDATION_ERROR', 'An explicit owner attestation is required');
    string(evidence.summary, 'summary', 65536);
    for (const key of ['localResources', 'remoteExecution'])
      if (!['stopped', 'unknown'].includes(evidence[key] as string))
        fail('VALIDATION_ERROR', `Invalid ${key}`);
    if (!['resolved', 'unknown'].includes(evidence.sideEffects as string))
      fail('VALIDATION_ERROR', 'Invalid sideEffects');
    if (
      !['not_executed', 'completed', 'failed', 'interrupted', 'unknown'].includes(
        evidence.outcome as string,
      )
    )
      fail('VALIDATION_ERROR', 'Invalid reconciliation outcome');
    if (evidence.outcome === 'completed') resultText(evidence.result);
    else if (evidence.result !== undefined)
      fail('VALIDATION_ERROR', 'Only a completed attestation may include a result');
    const resolved =
      evidence.localResources === 'stopped' &&
      evidence.remoteExecution === 'stopped' &&
      evidence.sideEffects === 'resolved' &&
      evidence.outcome !== 'unknown';
    const started = this.clock.monotonicNow();
    const resourceDisposition: { commit?: () => void } = {};
    const op = this.operation(
      'sessions.reconcile',
      sessionId,
      string(p.idempotencyKey, 'idempotencyKey'),
      { target, evidence },
      (op) => {
        const session = this.session(sessionId),
          task = this.task(session.taskId);
        if (
          session.generation !== target.expectedGeneration ||
          session.revision !== target.expectedRevision ||
          session.activeDispatchId !== target.expectedDispatchId ||
          session.status !== target.expectedState
        )
          fail('STALE_TARGET', 'Reconciliation target changed');
        if (session.status !== 'outcome_unknown' || task.status !== 'blocked')
          fail('STALE_TARGET', 'Session is not awaiting reconciliation');
        if (evidence.localResources === 'stopped') {
          if (this.flights.has(sessionId))
            fail('RUNTIME_STILL_ACTIVE', 'This owner still holds an active execution observer');
          const adapter = this.adapters.get(session.provider);
          if (adapter?.hasActiveResources?.(sessionId)) {
            let commit: unknown;
            try {
              commit = adapter.prepareUnobservedCleanup?.({
                sessionId,
                dispatchId: session.activeDispatchId!,
                generation: session.generation,
              });
            } catch {
              fail('INVALID_RUNTIME_CONTRACT', 'Runtime cleanup preparation threw before commit');
            }
            if (commit == null)
              fail('RUNTIME_STILL_ACTIVE', 'This owner still holds an active cleanup handle');
            if (typeof commit !== 'function')
              fail(
                'INVALID_RUNTIME_CONTRACT',
                'Runtime cleanup preparation must return a function or null',
              );
            resourceDisposition.commit = commit as () => void;
          }
        }
        const dispatchId = session.activeDispatchId!;
        const dispatch = this.store.require<Record<string, unknown>>('dispatches', dispatchId);
        if (
          this.store
            .all<ExecutionConflict>('execution_conflicts')
            .some((c) => c.dispatchId === dispatchId && c.status === 'open')
        )
          fail(
            'EXECUTION_EVIDENCE_CONFLICT',
            'Resolve the resource evidence conflict before reconciliation',
          );
        const terminalEvidence = [
          dispatch.terminalEvidence as RuntimeEvent | undefined,
          (dispatch as Dispatch).terminalCertificate?.terminal,
        ];
        if (
          evidence.outcome !== 'unknown' &&
          terminalEvidence.some(
            (late) =>
              late &&
              ((late.type === 'result' &&
                (evidence.outcome !== 'completed' || evidence.result !== late.text)) ||
                (late.type === 'interrupted' && evidence.outcome !== 'interrupted') ||
                (late.type === 'error' &&
                  late.outcome === 'failed' &&
                  !['failed', 'not_executed'].includes(evidence.outcome as string))),
          )
        )
          fail(
            'EVIDENCE_CONFLICT',
            'Owner attestation conflicts with recorded runtime terminal evidence',
          );
        op.targetId = sessionId;
        op.lifecycle = this.deadline(session, 'reconcile');
        op.lifecycle.lastEvidence = 'owner_attestation';
        const audit = {
          actor: 'host_owner',
          instanceId: this.instanceId,
          occurredAt: this.time(),
          dispatchId,
          target,
          evidence,
          ...(resourceDisposition.commit
            ? { resourceReconciliation: 'owner_attested_unobserved' }
            : {}),
        };
        const evidenceRef = this.store.artifact(JSON.stringify(audit));
        const executionReleased =
          evidence.localResources === 'stopped' && evidence.remoteExecution === 'stopped';
        if (executionReleased) this.release(dispatch as Dispatch, evidenceRef, 'owner_attestation');
        op.result = {
          sessionId,
          dispatchId,
          resolved,
          executionReleased,
          evidenceRef,
          actor: 'host_owner',
          outcome: evidence.outcome as string,
          unobservedResourcesReconciled: false,
          ...(resourceDisposition.commit
            ? { resourceCleanup: { status: 'pending', ownerInstanceId: this.instanceId } }
            : {}),
        };
        if (resourceDisposition.commit) op.status = 'persisted';
        this.store.put('dispatches', dispatchId, {
          ...dispatch,
          reconciliations: [...((dispatch.reconciliations as string[] | undefined) ?? []), op.id],
          ...(resolved
            ? {
                status: 'reconciled',
                quarantined: false,
                resolution: { outcome: evidence.outcome, operationId: op.id, evidenceRef },
              }
            : {}),
        });
        this.admissionEvent();
        if (resolved) {
          const replaySafe = evidence.outcome === 'not_executed';
          for (const id of (dispatch.messageIds as string[] | undefined) ?? []) {
            const message = this.store.require<MessageSnapshot>('messages', id);
            message.status = replaySafe
              ? 'persisted'
              : evidence.outcome === 'completed'
                ? 'completed'
                : 'failed';
            this.store.put('messages', id, message);
            this.store.put('outbox', id, {
              id,
              sessionId,
              dispatchId: replaySafe ? null : dispatchId,
              status: message.status,
            });
            this.store.event(
              `message.${message.status}`,
              { messageId: id, status: message.status, dispatchId, reconciliationId: op.id },
              { taskId: task.id, sessionId, operationId: op.id },
            );
          }
          session.activeDispatchId = null;
          this.saveSession(session, 'paused');
          if (evidence.outcome === 'completed') {
            const full = evidence.result as string;
            task.artifactRefs = [this.store.artifact(full)];
            task.result = resultPreview(full, task.artifactRefs[0]);
            this.saveTask(task, 'paused', 'reconciled_result');
          } else if (replaySafe) {
            this.saveTask(task, 'paused', 'reconciled_not_executed');
          } else this.saveTask(task, 'failed', `reconciled_${evidence.outcome}`);
          for (const prior of this.store.operations()) {
            if (
              prior.status !== 'outcome_unknown' ||
              prior.lifecycle?.expectedDispatchId !== dispatchId
            )
              continue;
            prior.resolution = {
              operationId: op.id,
              outcome: evidence.outcome as string,
              occurredAt: this.time(),
            };
            this.store.saveOperation(prior);
            this.store.event(
              'operation.resolved',
              { resolution: prior.resolution },
              { operationId: prior.id, taskId: task.id, sessionId },
            );
          }
          this.taskEvent(task, op.id);
        }
        this.store.event(
          'session.reconciled',
          {
            resolved,
            evidenceRef,
            dispatchId,
            actor: 'host_owner',
            outcome: evidence.outcome as string,
          },
          { taskId: task.id, sessionId, operationId: op.id },
        );
        if (resourceDisposition.commit)
          this.store.event(
            'session.resource_cleanup_prepared',
            { dispatchId, generation: session.generation, evidenceRef, actor: 'host_owner' },
            { taskId: task.id, sessionId, operationId: op.id },
          );
        if (this.clock.monotonicNow() - started >= this.timeouts.reconcileMs)
          fail(
            'TIMEOUT',
            'Reconciliation deadline exceeded before commit; no resolution was committed',
          );
      },
    );
    if (resourceDisposition.commit)
      this.pendingResourceCleanups.set(op.id, {
        commit: resourceDisposition.commit,
        applied: false,
      });
    const completed = this.finishResourceCleanup(op);
    this.kick();
    return completed;
  }
  private finishResourceCleanup(op: OperationSnapshot): OperationSnapshot {
    const result = op.result as Record<string, Json> | null;
    const cleanup = result?.resourceCleanup as Record<string, Json> | undefined;
    if (!cleanup || cleanup.status !== 'pending') return op;
    const pending = this.pendingResourceCleanups.get(op.id);
    const incomplete = (message: string): never =>
      fail('RESOURCE_CLEANUP_INCOMPLETE', message, { operationId: op.id, auditCommitted: true });
    if (!pending)
      return incomplete(
        'Owner attestation is committed, but its original in-memory finalizer is unavailable',
      );
    try {
      if (pending.settling) throw new Error('Runtime finalizer is still settling');
      if (!pending.applied) {
        const work: unknown = pending.commit();
        if (
          work !== null &&
          (typeof work === 'object' || typeof work === 'function') &&
          typeof (work as { then?: unknown }).then === 'function'
        ) {
          // A misbehaving async finalizer cannot block the RPC or run twice concurrently.
          // Observe both settlements, but only an explicit owner retry acknowledges completion.
          pending.settling = true;
          void Promise.resolve(work).then(
            () => {
              pending.applied = true;
              pending.settling = false;
            },
            () => {
              pending.settling = false;
            },
          );
          throw new Error('Runtime finalizer must finish synchronously');
        }
        pending.applied = true;
      }
      if (this.adapters.get(this.session(op.scope).provider)?.hasActiveResources?.(op.scope)) {
        pending.applied = false;
        throw new Error('Runtime finalizer retained its resources');
      }
      return this.store.transaction(() => {
        const completed = this.store.operation(op.id);
        completed.status = 'completed';
        completed.error = null;
        completed.result = {
          ...result,
          unobservedResourcesReconciled: true,
          resourceCleanup: { ...cleanup, status: 'completed' },
        };
        this.store.saveOperation(completed);
        this.store.event(
          'session.resources_reconciled',
          {
            dispatchId: result!.dispatchId,
            generation: op.lifecycle!.expectedGeneration,
            evidenceRef: result!.evidenceRef,
            actor: 'host_owner',
          },
          { sessionId: op.scope, taskId: this.session(op.scope).taskId, operationId: op.id },
        );
        this.store.event('operation.updated', { status: 'completed' }, { operationId: op.id });
        this.pendingResourceCleanups.delete(op.id);
        this.admissionEvent();
        return completed;
      });
    } catch {
      // Keep the exact prepared closure; replaying the durable operation must not re-prepare
      // against a now-paused session or a different generation. A completed disposition only
      // retries its durable acknowledgement if that later write failed.
      this.pendingResourceCleanups.set(op.id, pending);
      return incomplete(
        'Owner attestation is committed; retry the same reconciliation key to finish resource cleanup',
      );
    }
  }
  private resolveConflict(p: Record<string, unknown>): OperationSnapshot {
    fields(p, ['conflictId', 'expectedRevision', 'evidence', 'idempotencyKey']);
    const conflictId = string(p.conflictId, 'conflictId', 128);
    const revision = integer(p.expectedRevision, 'expectedRevision', 1);
    const evidence = object(p.evidence, 'evidence');
    fields(evidence, [
      'source',
      'summary',
      'localResources',
      'remoteExecution',
      'sideEffects',
      'outcome',
      'result',
    ]);
    if (
      evidence.source !== 'owner_attestation' ||
      evidence.localResources !== 'stopped' ||
      evidence.remoteExecution !== 'stopped'
    )
      fail(
        'INSUFFICIENT_EVIDENCE',
        'Conflict resolution requires owner-confirmed local and remote stop evidence',
      );
    string(evidence.summary, 'summary', 65536);
    if (
      !['resolved', 'unknown'].includes(evidence.sideEffects as string) ||
      !['not_executed', 'completed', 'failed', 'interrupted', 'unknown'].includes(
        evidence.outcome as string,
      )
    )
      fail('VALIDATION_ERROR', 'Invalid business evidence');
    if (evidence.outcome === 'completed') resultText(evidence.result);
    if (evidence.result !== undefined) {
      if (evidence.outcome !== 'completed')
        fail('VALIDATION_ERROR', 'Only completed evidence may contain a result');
      resultText(evidence.result);
    }
    const op = this.operation(
      'scheduler.resolveConflict',
      conflictId,
      string(p.idempotencyKey, 'idempotencyKey'),
      { conflictId, expectedRevision: revision, evidence },
      (op) => {
        const c = this.store.require<ExecutionConflict>('execution_conflicts', conflictId);
        if (c.revision !== revision || c.status !== 'open')
          fail('STALE_TARGET', 'Execution conflict changed');
        const d = this.store.require<Dispatch>('dispatches', c.dispatchId);
        const provider = d.provider ?? this.session(d.sessionId).provider;
        if (
          this.flights.has(d.sessionId) ||
          this.adapters.get(provider)?.hasActiveResources?.(d.sessionId)
        )
          fail('RUNTIME_STILL_ACTIVE', 'An observation or resource handle is still retained');
        const evidenceRef = this.store.artifact(
          JSON.stringify({
            actor: 'host_owner',
            instanceId: this.instanceId,
            conflictId,
            dispatchId: d.id,
            generation: d.generation,
            evidence,
            occurredAt: this.time(),
          }),
        );
        c.status = 'resolved';
        c.revision++;
        c.resolution = { operationId: op.id, evidenceRef, occurredAt: this.time() };
        this.store.put('execution_conflicts', c.id, c);
        op.targetId = c.id;
        op.result = { conflictId: c.id, resolved: true, evidenceRef, revision: c.revision };
        this.store.event(
          'execution.conflict_resolved',
          {
            conflictId: c.id,
            dispatchId: d.id,
            generation: d.generation,
            evidenceRef,
            revision: c.revision,
          },
          { taskId: d.taskId, sessionId: d.sessionId, operationId: op.id },
        );
        this.admissionEvent();
      },
    );
    this.kick();
    return op;
  }
  private kick(): void {
    if (this.scheduled || this.closing || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.closing || this.closed) return;
      try {
        const queued = this.store.queuedTasks();
        if (!queued.length) return;
        let canDispatch = this.scheduler().canDispatch;
        for (const task of queued) {
          if (!canDispatch) break;
          if (this.flights.has(task.sessionId)) continue;
          const session = this.session(task.sessionId);
          if (session.status !== 'idle') continue;
          if (this.start(task, session)) canDispatch = this.scheduler().canDispatch;
        }
      } catch (error) {
        // A scheduler/storage failure must not become an unhandled promise or silently retry a dispatch.
        this.closing = true;
        process.emitWarning(
          `Orchestrator scheduler stopped: ${error instanceof OrchestrationError ? error.code : 'INTERNAL_ERROR'}`,
        );
      }
    });
  }
  private adapterBudget(adapter: RuntimeAdapter): {
    version: 2;
    acceptanceCapMs: number | null;
    turnCapMs: number | null;
  } {
    const cap = adapter.capabilities().executionBudget;
    if (!cap || typeof cap !== 'object' || Array.isArray(cap) || cap.version !== 2)
      fail(
        'UNSUPPORTED_CAPABILITY',
        `Provider ${adapter.provider} requires executionBudget version 2`,
      );
    for (const k of ['acceptanceCapMs', 'turnCapMs'])
      if (cap[k] !== null) integer(cap[k], k, 1, 86400000);
    return cap as { version: 2; acceptanceCapMs: number | null; turnCapMs: number | null };
  }
  private start(task: TaskSnapshot, session: SessionSnapshot): boolean {
    const adapter = this.adapters.get(session.provider);
    try {
      if (!adapter)
        fail('UNSUPPORTED_CAPABILITY', 'The original runtime provider is not configured');
      this.adapterBudget(adapter);
    } catch (error) {
      if (!(error instanceof OrchestrationError) || error.code !== 'UNSUPPORTED_CAPABILITY')
        throw error;
      this.store.transaction(() => {
        this.saveTask(task, 'paused', `UNSUPPORTED_CAPABILITY: ${error.message}`);
        this.saveSession(session, 'paused');
        this.taskEvent(task);
      });
      return false;
    }
    const turns = this.store.dispatchCount(task.id);
    if (turns >= (this.config.limits?.maxTurnsPerTask ?? 20)) {
      this.store.transaction(() => {
        this.saveTask(task, 'paused', 'max_turns_reached');
        this.saveSession(session, 'paused');
        this.taskEvent(task);
      });
      return false;
    }
    if (session.providerSessionId && !adapter.capabilities().resume) {
      this.store.transaction(() => {
        this.saveTask(task, 'blocked', 'runtime_resume_unsupported');
        this.saveSession(session, 'paused');
        this.taskEvent(task);
      });
      return false;
    }
    const cap = this.adapterBudget(adapter);
    const enteredMono = this.clock.monotonicNow(),
      enteredWall = this.clock.wallNow();
    const effectiveTurnMs = Math.min(this.timeouts.turnMs, cap.turnCapMs ?? Infinity);
    const effectiveAcceptanceMs = Math.min(
      this.timeouts.acceptanceMs,
      cap.acceptanceCapMs ?? Infinity,
      effectiveTurnMs,
    );
    const budget: ExecutionBudget = {
      policyVersion: 2,
      enteredAt: new Date(enteredWall).toISOString(),
      acceptanceDeadlineAt: new Date(enteredWall + effectiveAcceptanceMs).toISOString(),
      deadlineAt: new Date(enteredWall + effectiveTurnMs).toISOString(),
      effectiveAcceptanceMs,
      effectiveTurnMs,
      acceptanceSource:
        effectiveTurnMs < Math.min(this.timeouts.acceptanceMs, cap.acceptanceCapMs ?? Infinity)
          ? 'total_budget'
          : cap.acceptanceCapMs !== null && cap.acceptanceCapMs < this.timeouts.acceptanceMs
            ? 'adapter_explicit'
            : this.config.timeouts?.acceptanceMs === undefined
              ? 'host_default'
              : 'host_explicit',
      turnSource:
        cap.turnCapMs !== null && cap.turnCapMs < this.timeouts.turnMs
          ? 'adapter_explicit'
          : this.config.timeouts?.turnMs === undefined
            ? 'host_default'
            : 'host_explicit',
      remainingAcceptanceMs: () =>
        Math.max(0, effectiveAcceptanceMs - (this.clock.monotonicNow() - enteredMono)),
      remainingTurnMs: () =>
        Math.max(0, effectiveTurnMs - (this.clock.monotonicNow() - enteredMono)),
    };
    const { remainingAcceptanceMs, remainingTurnMs, ...budgetSummary } = budget;
    const messages = this.pendingMessages(session.id);
    const dispatchId = randomUUID();
    const controller = new AbortController();
    const flight: Flight = {
      taskId: task.id,
      sessionId: session.id,
      dispatchId,
      generation: session.generation,
      messageIds: messages.map((m) => m.id),
      controller,
      promise: Promise.resolve(),
      intent: null,
      controlIds: [],
      expired: false,
      cancelTimers: [],
      deadlineChecks: [],
      budget,
    };
    this.store.transaction(() => {
      if (!this.scheduler().canDispatch)
        fail('DISPATCH_CAPACITY_CHANGED', 'Dispatch capacity changed before reservation');
      this.invalidateApproval(task);
      this.saveTask(task, 'running', null);
      session.activeDispatchId = dispatchId;
      this.saveSession(session, 'running');
      this.store.put('dispatches', dispatchId, {
        id: dispatchId,
        taskId: task.id,
        sessionId: session.id,
        generation: session.generation,
        status: 'dispatching',
        messageIds: flight.messageIds,
        createdAt: now(),
        ...budgetSummary,
        budget: budgetSummary,
        provider: adapter.provider,
        providerSessionId: session.providerSessionId,
        terminalCoversExecution:
          (
            adapter.capabilities().executionEvidence as
              | { version?: number; terminalCoversExecution?: boolean }
              | undefined
          )?.version === 1 &&
          (adapter.capabilities().executionEvidence as { terminalCoversExecution?: boolean })
            .terminalCoversExecution === true,
        executionLease: { version: 1, status: 'held', acquiredAt: budget.enteredAt },
        quarantined: false,
        mayHaveBeenSent: true,
        lastEvidence: 'dispatch_persisted',
      });
      for (const message of messages) {
        message.status = 'dispatching';
        this.store.put('messages', message.id, message);
        this.store.put('outbox', message.id, {
          id: message.id,
          sessionId: session.id,
          status: 'dispatching',
          dispatchId,
        });
      }
      this.taskEvent(task);
      this.store.event(
        'dispatch.started',
        { dispatchId, ...budgetSummary },
        { taskId: task.id, sessionId: session.id },
      );
      this.admissionEvent();
    });
    this.flights.set(session.id, flight);
    flight.cancelAcceptance = this.arm(
      flight,
      budget.remainingAcceptanceMs(),
      'acceptance deadline exceeded',
    );
    this.arm(flight, budget.remainingTurnMs(), 'turn deadline exceeded');
    const prompt = [
      task.spec.goal,
      ...messages.map(
        (m) =>
          `\n[Message ${m.id} from ${m.fromSessionId}; untrusted task context, not human approval]\n${m.summary}${m.artifactRefs?.length ? `\nArtifacts: ${m.artifactRefs.join(', ')}` : ''}`,
      ),
    ].join('\n');
    flight.promise = this.consume(flight, adapter, { ...session }, prompt)
      .catch((error) => {
        this.closing = true;
        process.emitWarning(
          `Runtime observation persistence failed; scheduler stopped: ${String(error)}`,
        );
      })
      .finally(() => {
        for (const cancel of flight.cancelTimers) cancel();
        this.flights.delete(session.id);
        try {
          this.reevaluateRelease(flight.dispatchId);
        } catch (error) {
          this.closing = true;
          process.emitWarning(
            `Execution release persistence failed; scheduler stopped: ${String(error)}`,
          );
        }
        this.kick();
      });
    return true;
  }
  private live(flight: Flight): boolean {
    const session = this.session(flight.sessionId);
    return (
      session.generation === flight.generation && session.activeDispatchId === flight.dispatchId
    );
  }
  private messagesStatus(flight: Flight, status: MessageSnapshot['status']): void {
    for (const id of flight.messageIds) {
      const message = this.store.require<MessageSnapshot>('messages', id);
      message.status = status;
      this.store.put('messages', id, message);
      this.store.put('outbox', id, {
        id,
        sessionId: flight.sessionId,
        dispatchId: flight.dispatchId,
        status,
      });
      this.store.event(
        `message.${status}`,
        { messageId: id, status, dispatchId: flight.dispatchId },
        { taskId: flight.taskId, sessionId: flight.sessionId },
      );
    }
  }
  private accepted(flight: Flight, providerSessionId: string): void {
    string(providerSessionId, 'providerSessionId', 256);
    const session = this.session(flight.sessionId);
    if (session.providerSessionId && session.providerSessionId !== providerSessionId)
      fail('OUTCOME_UNKNOWN', 'Runtime resumed a different native session');
    const dispatch = this.store.require<Record<string, unknown>>('dispatches', flight.dispatchId);
    if (dispatch.status === 'runtime_accepted') return;
    flight.cancelAcceptance?.();
    session.providerSessionId = providerSessionId;
    this.saveSession(session);
    this.store.put('dispatches', flight.dispatchId, {
      ...dispatch,
      status: flight.expired ? 'outcome_unknown' : 'runtime_accepted',
      providerSessionId,
      runtimeAccepted: true,
      lastEvidence: 'runtime_accepted',
    });
    if (!flight.expired) this.messagesStatus(flight, 'runtime_accepted');
    this.store.event(
      flight.expired ? 'dispatch.late_accepted' : 'dispatch.runtime_accepted',
      { dispatchId: flight.dispatchId, providerSessionId },
      { taskId: flight.taskId, sessionId: flight.sessionId },
    );
  }
  private async consume(
    flight: Flight,
    adapter: RuntimeAdapter,
    session: SessionSnapshot,
    prompt: string,
  ): Promise<void> {
    let terminal: Extract<RuntimeEvent, { type: 'result' | 'interrupted' | 'error' }> | undefined;
    try {
      const input = {
        taskId: flight.taskId,
        sessionId: flight.sessionId,
        dispatchId: flight.dispatchId,
        providerSessionId: session.providerSessionId,
        model: session.model,
        workspace: this.store.workspace,
        stateDir: this.store.stateDir,
        prompt,
        permissionProfile:
          this.config.providers?.[session.provider]?.permissionProfile ?? ('read-only' as const),
        signal: flight.controller.signal,
        generation: flight.generation,
        executionBudget: flight.budget,
        reportExecutionEvidence: (evidence: ExecutionEvidence) =>
          this.reportEvidence(flight, adapter.provider, evidence),
      };
      for await (const event of adapter.execute(input)) {
        for (const check of flight.deadlineChecks) check();
        if (!this.live(flight)) break;
        if (event.type === 'accepted')
          this.store.transaction(() => this.accepted(flight, event.providerSessionId));
        else if (event.type === 'usage')
          this.store.transaction(() => {
            const id = `${flight.dispatchId}:${string(event.usageId, 'usageId', 256)}`;
            if (this.store.get('usage', id)) return;
            for (const key of [
              'inputTokens',
              'cachedInputTokens',
              'cacheWriteInputTokens',
              'outputTokens',
            ] as const)
              if (event.usage[key] !== null) integer(event.usage[key], key);
            this.store.put('usage', id, {
              ...event.usage,
              id,
              taskId: flight.taskId,
              dispatchId: flight.dispatchId,
              provider: adapter.provider,
            });
          });
        else {
          terminal = event;
          this.store.transaction(() => {
            if (event.type === 'result') {
              resultText(event.text);
              const current = this.session(flight.sessionId);
              if (
                event.providerSessionId &&
                current.providerSessionId &&
                event.providerSessionId !== current.providerSessionId
              )
                fail('OUTCOME_UNKNOWN', 'Terminal evidence belongs to a different native session');
            }
            const dispatch = this.store.require<Record<string, unknown>>(
              'dispatches',
              flight.dispatchId,
            );
            this.store.put('dispatches', flight.dispatchId, {
              ...dispatch,
              terminalEvidence: event,
              lastEvidence: `terminal_${event.type}`,
            });
          });
          break;
        }
      }
      if (!terminal)
        terminal = {
          type: 'error',
          message: 'outcome_unknown: runtime stream ended without a terminal result',
          outcome: 'unknown',
        };
    } catch (error) {
      terminal = {
        type: 'error',
        message: error instanceof Error ? error.message : 'Runtime threw an unknown error',
        outcome: 'unknown',
      };
    }
    try {
      for (const check of flight.deadlineChecks) check();
      if (!this.live(flight)) return;
      this.store.transaction(() => {
        const task = this.task(flight.taskId),
          current = this.session(flight.sessionId);
        const dispatch = this.store.require<Record<string, unknown>>(
          'dispatches',
          flight.dispatchId,
        );
        if (
          !flight.expired &&
          (!this.stopProof(dispatch as Dispatch) || adapter.hasActiveResources?.(flight.sessionId))
        ) {
          terminal = {
            type: 'error',
            outcome: 'unknown',
            message: 'Execution stop or local cleanup is unconfirmed',
          };
        }
        if (flight.expired) {
          if (terminal!.type === 'result' && terminal!.providerSessionId)
            this.accepted(flight, terminal!.providerSessionId);
          const observed = this.store.require<Record<string, unknown>>(
            'dispatches',
            flight.dispatchId,
          );
          this.store.put('dispatches', flight.dispatchId, {
            ...observed,
            status: 'outcome_unknown',
            quarantined: true,
            quarantinedAt: observed.quarantinedAt ?? this.time(),
            terminalEvidence: observed.terminalEvidence ?? terminal,
            observationEndedAt: this.time(),
          });
          this.store.event(
            'dispatch.late_evidence',
            { dispatchId: flight.dispatchId, type: terminal!.type },
            { taskId: task.id, sessionId: current.id },
          );
          return;
        }
        if (terminal!.type === 'result') {
          if (terminal!.providerSessionId) {
            this.accepted(flight, terminal!.providerSessionId);
            current.providerSessionId = terminal!.providerSessionId;
            current.revision = this.session(current.id).revision;
          }
          // A final result is terminal runtime evidence even when the provider has no earlier acceptance event.
          this.messagesStatus(flight, 'completed');
          this.store.put('dispatches', flight.dispatchId, { ...dispatch, status: 'completed' });
          const fullResult = resultText(terminal!.text);
          task.artifactRefs = [this.store.artifact(fullResult)];
          task.result = resultPreview(fullResult, task.artifactRefs[0]);
          current.activeDispatchId = null;
          this.saveSession(current, flight.intent === 'pause' ? 'paused' : 'idle');
          if (flight.intent === 'cancel') {
            this.saveTask(task, 'cancelled', 'cancelled_by_client');
            this.taskEvent(task);
          } else this.requestApproval(task);
        } else if (terminal!.type === 'interrupted') {
          this.messagesStatus(flight, 'failed');
          this.store.put('dispatches', flight.dispatchId, { ...dispatch, status: 'interrupted' });
          current.activeDispatchId = null;
          this.saveSession(current, flight.intent === 'cancel' ? 'idle' : 'paused');
          this.saveTask(
            task,
            flight.intent === 'cancel' ? 'cancelled' : 'paused',
            'runtime_interrupted',
          );
          this.taskEvent(task);
        } else {
          const unknown = terminal!.outcome === 'unknown';
          this.messagesStatus(flight, unknown ? 'outcome_unknown' : 'failed');
          this.store.put('dispatches', flight.dispatchId, {
            ...dispatch,
            status: unknown ? 'outcome_unknown' : 'failed',
            quarantined: unknown,
            ...(unknown ? { quarantinedAt: dispatch.quarantinedAt ?? this.time() } : {}),
          });
          if (!unknown) current.activeDispatchId = null;
          this.saveSession(current, unknown ? 'outcome_unknown' : 'idle');
          this.saveTask(
            task,
            unknown ? 'blocked' : 'failed',
            unknown ? `outcome_unknown: ${terminal!.message}` : terminal!.message,
          );
          this.taskEvent(task);
        }
        const finalDispatch = this.store.require<Dispatch>('dispatches', flight.dispatchId);
        if (this.stopProof(finalDispatch) && !adapter.hasActiveResources?.(flight.sessionId))
          this.release(
            finalDispatch,
            finalDispatch.executionEvidenceRef!,
            'runtime_stop_and_cleanup',
          );
        this.admissionEvent();
        for (const id of flight.controlIds) {
          const op = this.store.operation(id);
          if (op.status !== 'persisted') continue;
          if (terminal!.type === 'error') {
            op.status = terminal!.outcome === 'unknown' ? 'outcome_unknown' : 'failed';
            op.error = {
              code: terminal!.outcome === 'unknown' ? 'OUTCOME_UNKNOWN' : 'RUNTIME_FAILED',
              message: task.reason ?? 'Runtime failed',
            };
          } else if (
            (op.method === 'tasks.cancel' && task.status === 'cancelled') ||
            (op.method === 'sessions.control' && current.status === 'paused')
          )
            op.status = 'completed';
          else {
            op.status = 'rejected';
            op.error = {
              code: 'STALE_TARGET',
              message: 'A later operation superseded this control',
            };
          }
          this.store.saveOperation(op);
          this.store.event(
            'operation.updated',
            { status: op.status },
            { operationId: id, taskId: task.id, sessionId: task.sessionId },
          );
        }
      });
    } catch (error) {
      // Preserve uncertainty if result persistence or native identity checks fail.
      this.store.transaction(() => {
        const task = this.task(flight.taskId);
        this.saveTask(
          task,
          'blocked',
          `outcome_unknown: ${error instanceof Error ? error.message : 'result persistence failed'}`,
        );
        this.saveSession(this.session(flight.sessionId), 'outcome_unknown');
        const dispatch = this.store.require<Record<string, unknown>>(
          'dispatches',
          flight.dispatchId,
        );
        this.store.put('dispatches', flight.dispatchId, {
          ...dispatch,
          status: 'outcome_unknown',
          quarantined: true,
          quarantinedAt: dispatch.quarantinedAt ?? this.time(),
        });
        this.admissionEvent();
        this.messagesStatus(flight, 'outcome_unknown');
        for (const id of flight.controlIds) {
          const operation = this.store.operation(id);
          if (operation.status !== 'persisted') continue;
          operation.status = 'outcome_unknown';
          operation.error = { code: 'OUTCOME_UNKNOWN', message: task.reason! };
          this.store.saveOperation(operation);
          this.store.event(
            'operation.updated',
            { status: operation.status },
            { operationId: id, taskId: task.id, sessionId: task.sessionId },
          );
        }
        this.taskEvent(task);
      });
    }
  }

  async close(options: CloseOptions = {}): Promise<{ status: 'closed'; operationId: string }> {
    const mode = options.mode ?? 'drain';
    if (!['drain', 'interrupt'].includes(mode)) fail('VALIDATION_ERROR', 'Unknown close mode');
    const timeout = integer(options.timeoutMs ?? 30000, 'timeoutMs', 0, 3600000);
    if (options.operationId !== undefined && options.operationId !== this.shutdownId)
      fail('STALE_TARGET', 'Unknown shutdown operation');
    if (this.closed) return { status: 'closed', operationId: this.shutdownId! };
    if (!this.shutdownId) {
      this.shutdownId = randomUUID();
      this.closing = true;
      this.store.transaction(() => {
        const op: OperationSnapshot = {
          id: this.shutdownId!,
          method: 'host.shutdown',
          scope: this.instanceId,
          idempotencyKey: this.shutdownId!,
          status: 'persisted',
          targetId: this.instanceId,
          result: null,
          error: null,
        };
        this.store.saveOperation(op, digest({ instanceId: this.instanceId }));
        for (const task of this.store.all<TaskSnapshot>('tasks'))
          if (task.status === 'queued') {
            this.saveTask(task, 'paused', 'owner_shutdown');
            this.saveSession(this.session(task.sessionId), 'paused');
            this.taskEvent(task);
          }
        this.admissionEvent();
      });
    }
    this.store.transaction(() => {
      const op = this.store.operation(this.shutdownId!);
      op.lifecycle = {
        enteredAt: op.lifecycle?.enteredAt ?? this.time(),
        deadlineAt: new Date(this.clock.wallNow() + timeout).toISOString(),
        policyVersion: 1,
        kind: 'shutdown',
        expectedGeneration: null,
        expectedDispatchId: null,
        mayHaveBeenSent: mode === 'interrupt',
        lastEvidence: `waiting_${mode}`,
      };
      this.store.saveOperation(op);
      this.store.event(
        'shutdown.wait_started',
        { mode, timeoutMs: timeout, deadlineAt: op.lifecycle.deadlineAt },
        { operationId: op.id },
      );
    });
    if (mode === 'interrupt') {
      for (const flight of this.flights.values()) {
        if (!flight.intent) flight.intent = 'shutdown';
        flight.controller.abort();
      }
      // The owner requested resource shutdown. Adapter cleanup may unblock a stalled iterator;
      // it is not evidence that a remote business action was cancelled.
      this.beginAdapterClose();
    }
    const deadline = performance.now() + timeout;
    while (this.flights.size) {
      if (performance.now() >= deadline) throw this.shutdownIncomplete();
      await sleep(Math.min(10, Math.max(1, deadline - performance.now())));
    }
    if (this.closed) return { status: 'closed', operationId: this.shutdownId };
    this.beginAdapterClose();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.closeAdaptersPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(this.shutdownIncomplete()),
            Math.max(0, deadline - performance.now()),
          );
        }),
      ]);
    } catch (cause) {
      const error = this.shutdownIncomplete();
      error.cause = cause;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!this.closed) {
      const op = this.store.operation(this.shutdownId);
      op.status = 'completed';
      op.result = { status: 'closed' };
      this.store.saveOperation(op);
      this.store.close();
      this.closed = true;
    }
    return { status: 'closed', operationId: this.shutdownId };
  }
  private beginAdapterClose(): void {
    if (this.closeAdaptersPromise) return;
    const attempt = Promise.all(
      [...this.adapters.values()].map((a) => Promise.resolve().then(() => a.close?.())),
    ).then(() => {});
    this.closeAdaptersPromise = attempt;
    void attempt.catch(() => {
      if (this.closeAdaptersPromise === attempt) this.closeAdaptersPromise = undefined;
    });
  }
  private shutdownIncomplete(): OrchestrationError {
    if (!this.closed && this.shutdownId) {
      this.store.transaction(() => {
        const op = this.store.operation(this.shutdownId!);
        if (op.lifecycle && !op.lifecycle.expiredAt) {
          op.lifecycle.expiredAt = this.time();
          op.lifecycle.lastEvidence = 'shutdown_incomplete';
          this.store.saveOperation(op);
          this.store.event('shutdown.incomplete', { status: 'stopping' }, { operationId: op.id });
        }
      });
    }
    const error = new OrchestrationError(
      'SHUTDOWN_INCOMPLETE',
      'Owned runtime work or cleanup is still running',
      { operationId: this.shutdownId },
    );
    Object.assign(error, { client: this, operationId: this.shutdownId });
    return error;
  }
}
export async function createEngine(config: EngineConfig): Promise<Engine> {
  return new LocalEngine(config);
}
