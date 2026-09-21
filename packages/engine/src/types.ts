import type { RetryIdentity } from './identity.ts';
export type { RetryIdentity } from './identity.ts';
import type { RuntimeTools } from './tools.ts';
export type { RuntimeTools, OrchestrationToolDefinition, OrchestrationToolName } from './tools.ts';
export type TaskStatus =
  | 'queued'
  | 'waiting_dependency'
  | 'running'
  | 'verifying'
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
  acceptance:
    | { mode: 'human'; criteria: string[] }
    | { mode: 'checks'; ruleRefs: RuleReference[]; maxRepairs?: number };
  dependencyTaskIds?: string[];
  parentTaskId?: string;
  writeScope?: string;
  contextPlan?: ContextPlan;
  budget?: MoneyBudget;
  contextEstimate?: { inputTokens: number; outputReserveTokens: number; toolReserveTokens: number };
}
export interface MoneyBudget {
  currency: string;
  maxCost: string;
  reservePerDispatch: string;
}
export interface Pricing {
  provider: string;
  model: string;
  currency: string;
  version: string;
  inputTokenMode: 'total' | 'uncached';
  perMillion: { input: string; cacheRead?: string; cacheWrite?: string; output: string };
}
export type RoutingMode = 'continue' | 'parallel_tools' | 'reuse' | 'fork' | 'fresh';
export interface ContextPlan {
  requestedMode: RoutingMode;
  independent: boolean;
  dependencyTaskIds: string[];
  contextRefs: { artifactRef: string; version: 1 }[];
  candidateSessionId?: string;
  snapshotRef?: string;
  fallbackModes: RoutingMode[];
  maxQueueWaitMs: number;
}
export interface RoutingDecision {
  policyVersion: 1;
  mode: RoutingMode;
  candidateSessionId: string;
  expectedGeneration: number;
  enqueuedAt: string;
  deadlineAt: string;
  maxQueueWaitMs: number;
  fallbackModes: RoutingMode[];
  reasonCode: string;
  submittedAt?: string;
  expiredAt?: string;
}
export interface SessionOpenSpec {
  runtime: RuntimeSpec;
  writeScope?: string;
}
export interface RuleReference {
  id: string;
  version: string;
}
export interface VerificationRule extends RuleReference {
  argv: string[];
  cwdRelative: string;
  timeoutMs: number;
  permissionProfile: 'read-only' | 'workspace-write';
  success: { exitCode: number };
  maxOutputBytes?: number;
  baselinePaths?: string[];
}
export interface FrozenVerificationRule extends VerificationRule {
  digest: string;
}
export interface TaskSnapshot {
  retryIdentity?: RetryIdentity;
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
  rootTaskId?: string;
  writePaths?: string[];
  verificationRules?: FrozenVerificationRule[];
  verificationAttempts?: number;
  routing?: RoutingDecision;
  kind?: 'work' | 'compaction';
  maintenanceOperationId?: string;
}
export interface SessionSnapshot {
  retryIdentity?: RetryIdentity;
  id: string;
  taskId: string | null;
  provider: string;
  model: string;
  providerSessionId: string | null;
  generation: number;
  revision: number;
  status: SessionStatus;
  activeDispatchId: string | null;
  /** Durable control provenance; absent old-store pauses are treated as client-owned. */
  pauseOrigin?: 'client' | 'runtime';
  taskIds?: string[];
  rootTaskId?: string;
  permissionProfile?: 'read-only' | 'workspace-write';
  writePaths?: string[];
  nativeCheckpoint?: string;
  forkSource?: {
    sessionId: string;
    generation: number;
    providerSessionId: string;
    nativeCheckpoint: string;
    snapshotRef: string;
  };
  generations?: {
    generation: number;
    providerSessionId: string | null;
    nativeCheckpoint?: string;
    artifactRef: string;
  }[];
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
  retryIdentity?: RetryIdentity;
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
  purpose: 'task_acceptance' | 'runtime_permission';
  revision: number;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'invalidated';
  target: {
    taskId: string;
    taskRevision: number;
    artifactRefs: string[];
    sessionId?: string;
    generation?: number;
    dispatchId?: string;
    providerSessionId?: string | null;
    providerTurnId?: string;
    requestId?: string;
    toolName?: string;
    permission?: Json;
    requestDigest?: string;
  };
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
  ttlMs?: number;
  replyToMessageId?: string;
}
export interface MessageSnapshot extends MessageSpec {
  retryIdentity?: RetryIdentity;
  id: string;
  fromSessionId: string;
  idempotencyKey: string;
  createdAt?: string;
  expiresAt?: string;
  hopCount?: number;
  status:
    | 'persisted'
    | 'dispatching'
    | 'runtime_accepted'
    | 'completed'
    | 'failed'
    | 'expired'
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
export type RuntimeBudgetCapabilities = {
  version: 2;
  acceptanceCapMs: number | null;
  turnCapMs: number | null;
};
export type RuntimeEvidenceCapabilities = {
  version: 1;
  terminalCoversExecution: boolean;
};
export interface RuntimeCapabilities {
  provider: string;
  resume: boolean;
  interrupt: boolean;
  permissionProfiles: ('read-only' | 'workspace-write')[];
  executionBudget: RuntimeBudgetCapabilities;
  executionEvidence?: RuntimeEvidenceCapabilities;
  [key: string]: Json | undefined;
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
  /** Persists received usage even after the main iterator/deadline; never changes execution state. */
  reportUsage?: (event: RuntimeUsageEvent) => void;
  /** Canonical owner-registered write scope; adapters must narrow their sandbox to it. */
  writePaths?: string[];
  forkSource?: SessionSnapshot['forkSource'];
  nativeAction?: 'compact';
  orchestrationTools?: RuntimeTools;
  requestPermission?: (request: RuntimePermissionRequest) => Promise<boolean>;
}
export interface RuntimePermissionRequest {
  requestId: string;
  toolName: string;
  permission: Json;
  providerSessionId?: string | null;
  providerTurnId?: string;
}
/** Required at the engine-to-host boundary; standalone provider calls retain RuntimeInput. */
export interface EngineRuntimeInput extends RuntimeInput {
  generation: number;
  executionBudget: ExecutionBudget;
  reportExecutionEvidence: (evidence: ExecutionEvidence) => void;
}
export type RuntimeEvent =
  | { type: 'accepted'; providerSessionId: string }
  | {
      type: 'result';
      text: string;
      providerSessionId?: string;
      nativeCheckpoint?: string;
      compacted?: { kind: 'boundary' | 'noop'; evidence: Json };
      /** Adapter asserts the received usage covers this entire dispatch; absent is unknown. */
      usageComplete?: boolean;
    }
  | {
      type: 'usage';
      usage: Omit<UsageRecord, 'id' | 'taskId' | 'dispatchId' | 'provider'>;
      usageId: string;
    }
  | { type: 'interrupted' }
  | { type: 'error'; message: string; outcome: 'failed' | 'unknown' };
export type RuntimeUsageEvent = Extract<RuntimeEvent, { type: 'usage' }>;
export interface RuntimeResourceTarget {
  sessionId: string;
  dispatchId: string;
  generation: number;
}
export interface RuntimeStopContext {
  readonly target: Readonly<
    RuntimeResourceTarget & {
      taskId: string;
      provider: string;
      providerSessionId: string | null;
      providerTurnId?: string;
    }
  >;
  readonly terminal: Readonly<RuntimeTerminalEvent>;
  readonly signal: AbortSignal;
  readonly remainingMs: () => number;
}
/** True is a host observation of full execution stop, never merely receipt of a cancel request. */
export type RuntimeStopObserver = (context: RuntimeStopContext) => boolean | Promise<boolean>;
export interface RuntimeAdapter {
  provider: string;
  capabilities(): RuntimeCapabilities;
  execute(input: RuntimeInput): AsyncIterable<RuntimeEvent>;
  inspect?(input: RuntimeInspectionInput): Promise<RuntimeInspection>;
  close?(): Promise<void>;
  /** Required when execute can finish while local cleanup is still unconfirmed. */
  hasActiveResources?(sessionId: string): boolean;
  /**
   * Optional owner-attestation path for sealed records with no process observation at all.
   * Return null if any retained record is still executing, has an observed process, or belongs
   * to another dispatch/generation. Preparing must not mutate resources or report stop evidence.
   * The host invokes the synchronous, non-throwing, idempotent finalizer only after committing
   * its audit transaction. It retires only these records, without claiming an observed exit.
   * Contract failures leave a durable pending receipt; an explicit same-key owner retry resumes
   * the original finalizer. Abnormal Promise returns are observed without an unbounded wait.
   */
  prepareUnobservedCleanup?(target: RuntimeResourceTarget): (() => void) | null;
}
export interface RuntimeInspectionInput {
  sessionId: string;
  providerSessionId: string;
  generation: number;
  dispatchId: string | null;
  providerTurnId?: string;
  workspace: string;
  stateDir: string;
  limit: number;
  timeoutMs: number;
  signal: AbortSignal;
}
export interface RuntimeInspection {
  status: 'found' | 'not_found' | 'unavailable' | 'mismatch';
  providerSessionId: string;
  records: Json[];
  truncated: boolean;
  execution: 'unknown';
  detail: string;
}
export interface EngineConfig {
  storage?: Partial<import('./storage.ts').StoragePolicy>;
  stores?: import('./control-plane.ts').StoreDirectories;
  storageFault?: (point: string) => void;
  workspace: string;
  stateDir: string;
  adapters: RuntimeAdapter[];
  limits?: {
    maxActiveSessions?: number;
    maxTurnsPerTask?: number;
    maxQuarantinedDispatches?: number;
    maxLogicalSessions?: number;
    maxQueuedTasks?: number;
  };
  providers?: Record<
    string,
    { model?: string; permissionProfile?: 'read-only' | 'workspace-write' }
  >;
  approvalTtlMs?: number;
  runtimeApprovals?: { enabled?: boolean; ttlMs?: number };
  messages?: { ttlMs?: number; maxHops?: number; maxPerMinute?: number };
  pricing?: Pricing[];
  budget?: MoneyBudget;
  contextLimits?: Record<string, { windowTokens: number; safetyTokens: number }>;
  timeouts?: LifecycleTimeouts;
  clock?: EngineClock;
  verificationRules?: VerificationRule[];
  /** Named canonical in-workspace paths; task input can select but never register a scope. */
  writeScopes?: Record<string, string[]>;
  allowCrossRootReuse?: boolean;
  tools?: {
    enabled?: boolean;
    maxDepth?: number;
    maxChildren?: number;
    maxCallsPerDispatch?: number;
    maxRepeatedCalls?: number;
  };
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
  /** Trusted in-process binding. Never accepted from public JSON requests. */
  runtimeActor?: { sessionId: string; taskId: string; dispatchId: string; generation: number };
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
