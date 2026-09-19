export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type SessionStatus =
  | 'idle'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'closed'
  | 'outcome_unknown';
export type OperationStatus =
  | 'persisted'
  | 'completed'
  | 'noop'
  | 'rejected'
  | 'failed'
  | 'outcome_unknown';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface RuntimeSpec {
  provider: string;
  model: string;
}
export interface TaskSpec {
  goal: string;
  runtime: RuntimeSpec;
  acceptance: { mode: 'human'; criteria: string[] };
}
export interface TaskSnapshot {
  id: string;
  status: TaskStatus;
  revision: number;
  sessionId: string;
  spec: TaskSpec;
  artifactRefs: string[];
  result: string | null;
  reason: string | null;
  approvalId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface SessionSnapshot {
  id: string;
  taskId: string;
  provider: string;
  model: string;
  providerSessionId: string | null;
  generation: number;
  revision: number;
  status: SessionStatus;
  activeDispatchId: string | null;
  execution?: {
    dispatchId: string;
    lease: ExecutionLease;
    quarantined: boolean;
    lastEvidence: string;
    budget?: ExecutionBudgetSummary;
  };
}
export interface ExecutionLease {
  version: 1;
  status: 'held' | 'released';
  acquiredAt: string;
  releasedAt?: string;
  releaseReason?: string;
  releaseEvidenceRef?: string;
}
export interface ExecutionBudgetSummary {
  policyVersion: 2;
  enteredAt: string;
  acceptanceDeadlineAt: string;
  deadlineAt: string;
  effectiveAcceptanceMs: number;
  effectiveTurnMs: number;
  acceptanceSource: string;
  turnSource: string;
}
export interface ExecutionBudget extends ExecutionBudgetSummary {
  remainingAcceptanceMs(): number;
  remainingTurnMs(): number;
}
export type RuntimeTerminalEvent = Extract<
  RuntimeEvent,
  { type: 'result' | 'interrupted' | 'error' }
>;
export interface ExecutionEvidence {
  version: 1;
  sequence: number;
  dispatchId: string;
  sessionId: string;
  generation: number;
  provider: string;
  providerSessionId: string | null;
  providerTurnId?: string | null;
  source: 'pre_submission' | 'runtime_terminal' | 'resource_observation';
  observedAt: string;
  localResources: 'stopped' | 'unknown' | 'active';
  remoteExecution: 'stopped' | 'unknown' | 'active';
  detail: string;
  terminal?: RuntimeTerminalEvent;
}
export interface ExecutionConflict {
  id: string;
  revision: number;
  dispatchId: string;
  sessionId: string;
  taskId: string;
  generation: number;
  status: 'open' | 'resolved';
  releaseEvidenceRef: string | null;
  conflictingEvidenceRef: string;
  createdAt: string;
  resolution?: { operationId: string; evidenceRef: string; occurredAt: string };
}
export interface SchedulerSnapshot {
  maxActiveSessions: number;
  maxQuarantinedDispatches: number;
  executionOccupied: number;
  quarantined: number;
  quarantineReserved: number;
  canDispatch: boolean;
  reasons: string[];
  occupants: Array<{
    taskId: string;
    sessionId: string;
    dispatchId: string;
    leaseStatus: 'held' | 'released';
    quarantined: boolean;
    lastEvidence: string;
    enteredAt: string;
  }>;
  truncated: boolean;
  openConflicts: number;
  conflicts: Array<{ conflictId: string; revision: number; dispatchId: string }>;
  conflictsTruncated: boolean;
}
export interface OperationSnapshot {
  id: string;
  method: string;
  scope: string;
  idempotencyKey: string;
  status: OperationStatus;
  targetId: string;
  result: Json;
  error: { code: string; message: string } | null;
  lifecycle?: OperationLifecycle;
  resolution?: { operationId: string; outcome: string; occurredAt: string };
}
export interface LifecycleTimeouts {
  acceptanceMs?: number;
  turnMs?: number;
  drainMs?: number;
  interruptMs?: number;
  reconcileMs?: number;
}
export interface OperationLifecycle {
  enteredAt: string;
  deadlineAt: string;
  policyVersion: 1;
  kind: 'drain' | 'interrupt' | 'reconcile' | 'shutdown';
  expectedGeneration: number | null;
  expectedDispatchId: string | null;
  mayHaveBeenSent: boolean;
  lastEvidence: string;
  expiredAt?: string;
}
export interface ReconcileEvidence {
  source: 'owner_attestation';
  summary: string;
  localResources: 'stopped' | 'unknown';
  remoteExecution: 'stopped' | 'unknown';
  sideEffects: 'resolved' | 'unknown';
  outcome: 'not_executed' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  result?: string;
}
// In-process test seam; not accepted from JSON config or the wire.
export interface EngineClock {
  wallNow(): number;
  monotonicNow(): number;
  setTimer(callback: () => void, delayMs: number): () => void;
}
export interface ApprovalRequest {
  approvalId: string;
  taskId: string;
  purpose: 'task_acceptance';
  revision: number;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'invalidated';
  target: { taskId: string; taskRevision: number; artifactRefs: string[] };
  summary: string;
  evidenceRefs: string[];
  expiresAt: string;
}
export interface MessageSpec {
  taskId: string;
  toSessionId: string;
  expectedGeneration: number;
  kind: 'assignment' | 'finding' | 'result' | 'question' | 'control';
  summary: string;
  artifactRefs?: string[];
}
export interface MessageSnapshot extends MessageSpec {
  id: string;
  fromSessionId: string;
  idempotencyKey: string;
  status:
    | 'persisted'
    | 'dispatching'
    | 'runtime_accepted'
    | 'completed'
    | 'failed'
    | 'outcome_unknown';
}
export interface EventEnvelope {
  eventId: string;
  cursor: string;
  storeId: string;
  schemaVersion: 1;
  type: string;
  taskId: string | null;
  sessionId: string | null;
  operationId: string | null;
  occurredAt: string;
  data: Record<string, Json>;
}
export interface UsageRecord {
  id: string;
  taskId: string;
  dispatchId: string;
  provider: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  raw: Json;
}
export interface RuntimeCapabilities {
  provider: string;
  resume: boolean;
  interrupt: boolean;
  permissionProfiles: ('read-only' | 'workspace-write')[];
  [key: string]: Json;
}
export interface RuntimeInput {
  taskId: string;
  sessionId: string;
  dispatchId: string;
  providerSessionId: string | null;
  model: string;
  workspace: string;
  stateDir: string;
  prompt: string;
  permissionProfile: 'read-only' | 'workspace-write';
  signal: AbortSignal;
  generation?: number;
  executionBudget?: ExecutionBudget;
  reportExecutionEvidence?: (evidence: ExecutionEvidence) => void;
}
export type RuntimeEvent =
  | { type: 'accepted'; providerSessionId: string }
  | { type: 'result'; text: string; providerSessionId?: string }
  | {
      type: 'usage';
      usage: Omit<UsageRecord, 'id' | 'taskId' | 'dispatchId' | 'provider'>;
      usageId: string;
    }
  | { type: 'interrupted' }
  | { type: 'error'; message: string; outcome: 'failed' | 'unknown' };
export interface RuntimeAdapter {
  provider: string;
  capabilities(): RuntimeCapabilities;
  execute(input: RuntimeInput): AsyncIterable<RuntimeEvent>;
  close?(): Promise<void>;
  /** Required when execute can finish while local cleanup is still unconfirmed. */
  hasActiveResources?(sessionId: string): boolean;
}
export interface EngineConfig {
  workspace: string;
  stateDir: string;
  adapters: RuntimeAdapter[];
  limits?: {
    maxActiveSessions?: number;
    maxTurnsPerTask?: number;
    maxQuarantinedDispatches?: number;
  };
  providers?: Record<
    string,
    { model?: string; permissionProfile?: 'read-only' | 'workspace-write' }
  >;
  approvalTtlMs?: number;
  timeouts?: LifecycleTimeouts;
  clock?: EngineClock;
}
export interface SessionControlTarget {
  sessionId: string;
  expectedGeneration: number;
  expectedRevision: number;
  expectedDispatchId: string | null;
  expectedState: SessionStatus;
}
export interface CloseOptions {
  mode?: 'drain' | 'interrupt';
  timeoutMs?: number;
  operationId?: string;
}
export interface CallContext {
  owner?: boolean;
  signal?: AbortSignal;
}
export interface EventPage {
  events: EventEnvelope[];
  cursor: string;
  storeId: string;
}
export interface Engine {
  readonly instanceId: string;
  readonly storeId: string;
  call(method: string, params?: Record<string, unknown>, context?: CallContext): Promise<unknown>;
  close(options?: CloseOptions): Promise<{ status: 'closed'; operationId: string }>;
}
