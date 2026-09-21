"""Generated from schemas/protocol.schema.json; SHA-256 fa633a2fb40ab9f12e09770f8977383f1d4e6a78ce9e09c92dcccd6165dbd38d. Do not edit.
Wire dictionaries use camelCase. Use the SDK dataclasses for snake_case requests.
"""
from __future__ import annotations
from typing import Any, Literal, NotRequired, TypedDict, TypeAlias, Union

class RuntimeSpec(TypedDict):
    provider: str
    model: str

class TaskSpecAcceptanceChoice1(TypedDict):
    mode: Literal["human"]
    criteria: list[str]

class TaskSpecAcceptanceChoice2RuleRefsItem(TypedDict):
    id: str
    version: str

class TaskSpecAcceptanceChoice2(TypedDict):
    mode: Literal["checks"]
    ruleRefs: list[TaskSpecAcceptanceChoice2RuleRefsItem]
    maxRepairs: NotRequired[int]

class TaskSpec(TypedDict):
    goal: str
    runtime: RuntimeSpec
    acceptance: Union["TaskSpecAcceptanceChoice1", "TaskSpecAcceptanceChoice2"]
    dependencyTaskIds: NotRequired[list[str]]
    parentTaskId: NotRequired[str]
    writeScope: NotRequired[str]
    contextPlan: NotRequired[ContextPlan]
    budget: NotRequired[MoneyBudget]
    contextEstimate: NotRequired[ContextEstimate]

class TaskSnapshot(TypedDict):
    id: str
    status: TaskStatus
    revision: int
    sessionId: str
    spec: TaskSpec
    artifactRefs: list[str]
    result: str | None
    reason: str | None
    approvalId: str | None
    createdAt: str
    updatedAt: str
    retryIdentity: NotRequired[RetryIdentity]
    rootTaskId: NotRequired[str]
    writePaths: NotRequired[list[str]]
    verificationRules: NotRequired[list[FrozenVerificationRule]]
    verificationAttempts: NotRequired[int]
    routing: NotRequired[RoutingDecision]
    kind: NotRequired[Literal["work", "compaction"]]
    maintenanceOperationId: NotRequired[str]

class ApprovalRequestTarget(TypedDict):
    taskId: str
    taskRevision: int
    artifactRefs: list[str]
    sessionId: NotRequired[str]
    generation: NotRequired[int]
    dispatchId: NotRequired[str]
    providerSessionId: NotRequired[str | None]
    providerTurnId: NotRequired[str]
    requestId: NotRequired[str]
    toolName: NotRequired[str]
    permission: NotRequired[Any]
    requestDigest: NotRequired[str]

class ApprovalRequest(TypedDict):
    approvalId: str
    taskId: str
    purpose: Literal["task_acceptance", "runtime_permission"]
    revision: int
    status: Literal["pending", "approved", "denied", "expired", "invalidated"]
    target: ApprovalRequestTarget
    summary: str
    evidenceRefs: list[str]
    expiresAt: str

class UsageRecordedData(TypedDict):
    usageRecordId: str
    dispatchId: str
    provider: str

class UsageRecord(TypedDict):
    id: str
    taskId: str
    dispatchId: str
    provider: str
    inputTokens: int | None
    cachedInputTokens: int | None
    cacheWriteInputTokens: int | None
    outputTokens: int | None
    raw: Any

class SessionSnapshotForkSource(TypedDict):
    sessionId: str
    generation: int
    providerSessionId: str
    nativeCheckpoint: str
    snapshotRef: str

class SessionSnapshotGenerationsItem(TypedDict):
    generation: int
    providerSessionId: str | None
    nativeCheckpoint: NotRequired[str]
    artifactRef: str

class SessionSnapshot(TypedDict):
    id: str
    taskId: str | None
    provider: str
    model: str
    providerSessionId: str | None
    generation: int
    revision: int
    status: SessionStatus
    activeDispatchId: str | None
    pauseOrigin: NotRequired[Literal["client", "runtime"]]
    execution: NotRequired[SessionExecution]
    retryIdentity: NotRequired[RetryIdentity]
    taskIds: NotRequired[list[str]]
    rootTaskId: NotRequired[str]
    permissionProfile: NotRequired[Literal["read-only", "workspace-write"]]
    writePaths: NotRequired[list[str]]
    nativeCheckpoint: NotRequired[str]
    forkSource: NotRequired[SessionSnapshotForkSource]
    generations: NotRequired[list[SessionSnapshotGenerationsItem]]

class EngineLimits(TypedDict):
    maxActiveSessions: NotRequired[int]
    maxQuarantinedDispatches: NotRequired[int]
    maxTurnsPerTask: NotRequired[int]
    maxLogicalSessions: NotRequired[int]
    maxQueuedTasks: NotRequired[int]

class LifecycleTimeouts(TypedDict):
    acceptanceMs: NotRequired[int]
    turnMs: NotRequired[int]
    drainMs: NotRequired[int]
    interruptMs: NotRequired[int]
    reconcileMs: NotRequired[int]

class LifecycleCapability(TypedDict):
    version: Literal[1]
    reconcile: Literal["owner-attestation"]
    durableDeadlines: Literal[True]

class ExecutionIsolationCapability(TypedDict):
    version: Literal[1]
    resourceRelease: Literal[True]
    schedulerStatus: Literal[True]
    ownerConflictResolution: Literal[True]
    budgetVersion: Literal[2]

class ExecutionLease(TypedDict):
    version: Literal[1]
    status: Literal["held", "released"]
    acquiredAt: str
    releasedAt: NotRequired[str]
    releaseReason: NotRequired[str]
    releaseEvidenceRef: NotRequired[str]

class DispatchBudget(TypedDict):
    policyVersion: Literal[2]
    enteredAt: str
    acceptanceDeadlineAt: str
    deadlineAt: str
    effectiveAcceptanceMs: int
    effectiveTurnMs: int
    acceptanceSource: str
    turnSource: str

class SessionExecution(TypedDict):
    dispatchId: str
    lease: ExecutionLease
    quarantined: bool
    lastEvidence: str
    budget: NotRequired[DispatchBudget]

class SchedulerSnapshotOccupantsItem(TypedDict):
    taskId: str
    sessionId: str
    dispatchId: str
    leaseStatus: Literal["held", "released"]
    quarantined: bool
    lastEvidence: str
    enteredAt: str

class SchedulerSnapshotConflictsItem(TypedDict):
    conflictId: str
    revision: int
    dispatchId: str

class SchedulerSnapshot(TypedDict):
    maxActiveSessions: int
    maxQuarantinedDispatches: int
    executionOccupied: int
    quarantined: int
    quarantineReserved: int
    canDispatch: bool
    reasons: list[str]
    occupants: list[SchedulerSnapshotOccupantsItem]
    truncated: bool
    openConflicts: int
    conflicts: list[SchedulerSnapshotConflictsItem]
    conflictsTruncated: bool

class ExecutionConflictResolution(TypedDict):
    operationId: str
    evidenceRef: str
    occurredAt: str

class ExecutionConflict(TypedDict):
    id: str
    revision: int
    dispatchId: str
    sessionId: str
    taskId: str
    generation: int
    status: Literal["open", "resolved"]
    releaseEvidenceRef: str | None
    conflictingEvidenceRef: str
    createdAt: str
    resolution: NotRequired[ExecutionConflictResolution]

class SchedulerGetParams(TypedDict):
    pass

class SchedulerGetConflictParams(TypedDict):
    conflictId: str

class SchedulerResolveConflictParams(TypedDict):
    conflictId: str
    expectedRevision: int
    evidence: Any
    idempotencyKey: str
    expectedStoreId: str
    requestDigest: NotRequired[str]

class OperationLifecycle(TypedDict):
    enteredAt: str
    deadlineAt: str
    policyVersion: Literal[1]
    kind: Literal["drain", "interrupt", "reconcile", "shutdown"]
    expectedGeneration: int | None
    expectedDispatchId: str | None
    mayHaveBeenSent: bool
    lastEvidence: str
    expiredAt: NotRequired[str]

class OperationSnapshotErrorChoice2(TypedDict):
    code: str
    message: str

class OperationSnapshotResolution(TypedDict):
    operationId: str
    outcome: str
    occurredAt: str

class OperationSnapshot(TypedDict):
    id: str
    method: str
    scope: str
    idempotencyKey: str
    status: OperationStatus
    targetId: str
    result: Any
    error: Union["None", "OperationSnapshotErrorChoice2"]
    lifecycle: NotRequired[OperationLifecycle]
    resolution: NotRequired[OperationSnapshotResolution]
    retryIdentity: NotRequired[RetryIdentity]

class ReconcileEvidence(TypedDict):
    source: Literal["owner_attestation"]
    summary: str
    localResources: Literal["stopped", "unknown"]
    remoteExecution: Literal["stopped", "unknown"]
    sideEffects: Literal["resolved", "unknown"]
    outcome: Literal["not_executed", "completed", "failed", "interrupted", "unknown"]
    result: NotRequired[str]

class ReconcileParams(TypedDict):
    target: ControlTarget
    evidence: ReconcileEvidence
    idempotencyKey: str
    expectedStoreId: str
    requestDigest: NotRequired[str]

class ControlTarget(TypedDict):
    sessionId: str
    expectedGeneration: int
    expectedRevision: int
    expectedDispatchId: str | None
    expectedState: SessionStatus

class MessageSpec(TypedDict):
    taskId: str
    toSessionId: str
    expectedGeneration: int
    kind: Literal["assignment", "finding", "result", "question"]
    summary: str
    artifactRefs: NotRequired[list[str]]
    ttlMs: NotRequired[int]
    replyToMessageId: NotRequired[str]

class MessageSnapshot(TypedDict):
    id: str
    fromSessionId: str
    idempotencyKey: str
    status: Literal["persisted", "dispatching", "runtime_accepted", "completed", "failed", "outcome_unknown", "expired"]
    taskId: str
    toSessionId: str
    expectedGeneration: int
    kind: Literal["assignment", "finding", "result", "question"]
    summary: str
    artifactRefs: NotRequired[list[str]]
    ttlMs: NotRequired[int]
    replyToMessageId: NotRequired[str]
    retryIdentity: NotRequired[RetryIdentity]
    createdAt: NotRequired[str]
    expiresAt: NotRequired[str]
    hopCount: NotRequired[int]

class RequestParams(TypedDict):
    pass

class Request(TypedDict):
    jsonrpc: Literal["2.0"]
    id: str | int
    method: str
    params: RequestParams

class EventEnvelopeData(TypedDict):
    pass

class EventEnvelope(TypedDict):
    eventId: str
    cursor: str
    storeId: str
    schemaVersion: Literal[1]
    type: str
    taskId: str | None
    sessionId: str | None
    operationId: str | None
    occurredAt: str
    data: EventEnvelopeData

class RetryIdentity(TypedDict):
    storeId: str
    method: str
    scope: str
    idempotencyKey: str
    digestVersion: Literal[1]
    requestDigest: str

class MoneyBudget(TypedDict):
    currency: str
    maxCost: str
    reservePerDispatch: str

class ContextEstimate(TypedDict):
    inputTokens: int
    outputReserveTokens: int
    toolReserveTokens: int

class ContextPlanContextRefsItem(TypedDict):
    artifactRef: str
    version: Literal[1]

class ContextPlan(TypedDict):
    requestedMode: RoutingMode
    independent: bool
    dependencyTaskIds: NotRequired[list[str]]
    contextRefs: NotRequired[list[ContextPlanContextRefsItem]]
    candidateSessionId: NotRequired[str]
    snapshotRef: NotRequired[str]
    fallbackModes: NotRequired[list[RoutingMode]]
    maxQueueWaitMs: NotRequired[int]

class RoutingDecision(TypedDict):
    policyVersion: Literal[1]
    mode: RoutingMode
    candidateSessionId: str
    expectedGeneration: int
    enqueuedAt: str
    deadlineAt: str
    maxQueueWaitMs: int
    fallbackModes: list[RoutingMode]
    reasonCode: str
    submittedAt: NotRequired[str]
    expiredAt: NotRequired[str]

class RuleReference(TypedDict):
    id: str
    version: str

class VerificationRuleSuccess(TypedDict):
    exitCode: int

class VerificationRule(TypedDict):
    id: str
    version: str
    argv: list[str]
    cwdRelative: str
    timeoutMs: int
    permissionProfile: Literal["read-only", "workspace-write"]
    success: VerificationRuleSuccess
    maxOutputBytes: NotRequired[int]
    baselinePaths: NotRequired[list[str]]

class FrozenVerificationRuleSuccess(TypedDict):
    exitCode: int

class FrozenVerificationRule(TypedDict):
    id: str
    version: str
    argv: list[str]
    cwdRelative: str
    timeoutMs: int
    permissionProfile: Literal["read-only", "workspace-write"]
    success: FrozenVerificationRuleSuccess
    maxOutputBytes: NotRequired[int]
    baselinePaths: NotRequired[list[str]]
    digest: str

class SessionOpenSpec(TypedDict):
    runtime: RuntimeSpec
    writeScope: NotRequired[str]

class InitializeParams(TypedDict):
    protocolVersion: Literal["2.0"]
    sdkVersion: str

class InitializeResultCapabilitiesStoreNamespaces(TypedDict):
    version: Literal[1]
    expectedStoreId: NotRequired[Literal[True]]
    digestVersion: NotRequired[Literal[1]]

class InitializeResultCapabilities(TypedDict):
    storeNamespaces: InitializeResultCapabilitiesStoreNamespaces

class InitializeResult(TypedDict):
    protocolVersion: Literal["2.0"]
    engineVersion: str
    schemaVersion: Literal[3]
    instanceId: str
    storeId: str
    capabilities: InitializeResultCapabilities

class PricingPerMillion(TypedDict):
    input: str
    output: str
    cacheRead: NotRequired[str]
    cacheWrite: NotRequired[str]

class Pricing(TypedDict):
    provider: str
    model: str
    currency: str
    version: str
    inputTokenMode: Literal["total", "uncached"]
    perMillion: PricingPerMillion

class RuntimeInspection(TypedDict):
    status: Literal["found", "not_found", "unavailable", "mismatch"]
    execution: Literal["unknown"]
    providerSessionId: str | None
    records: list[Any]
    detail: str
    target: NotRequired[Any]
    truncated: bool

class StoragePolicy(TypedDict):
    quotaBytes: NotRequired[int]
    minFreeBytes: NotRequired[int]
    emergencyBytes: NotRequired[int]
    maxRecords: NotRequired[int]
    settlementReserveRecords: NotRequired[int]
    maxSettlementPerTarget: NotRequired[int]
    eventDays: NotRequired[int]
    detailDays: NotRequired[int]
    usageDays: NotRequired[int]

class SnapshotPageItemsItemValue(TypedDict):
    pass

class SnapshotPageItemsItem(TypedDict):
    kind: Literal["tasks", "sessions", "approvals"]
    value: SnapshotPageItemsItemValue

class SnapshotPage(TypedDict):
    snapshotId: str
    storeId: str
    cursor: str
    retentionFloorCursor: str
    expiresAt: str
    items: list[SnapshotPageItemsItem]
    nextOffset: int
    done: bool

class TaskCreateParams(TypedDict):
    spec: TaskSpec
    expectedStoreId: str
    idempotencyKey: str
    requestDigest: NotRequired[str]

class MessageSendParams(TypedDict):
    spec: MessageSpec
    expectedStoreId: str
    idempotencyKey: str
    requestDigest: NotRequired[str]

class SessionOpenParams(TypedDict):
    spec: SessionOpenSpec
    expectedStoreId: str
    idempotencyKey: str
    requestDigest: NotRequired[str]

class TaskMutationParams(TypedDict):
    taskId: str
    expectedStoreId: str
    idempotencyKey: str
    requestDigest: NotRequired[str]

class SessionControlParamsCommand(TypedDict):
    action: Literal["pause", "resume", "stop"]
    mode: NotRequired[Literal["drain", "interrupt"]]

class SessionControlParams(TypedDict):
    target: ControlTarget
    command: SessionControlParamsCommand
    expectedStoreId: str
    idempotencyKey: str
    requestDigest: NotRequired[str]

class SessionForkParams(TypedDict):
    target: ControlTarget
    snapshotRef: str
    expectedStoreId: str
    idempotencyKey: str
    requestDigest: NotRequired[str]

class SessionMutationParams(TypedDict):
    target: ControlTarget
    expectedStoreId: str
    idempotencyKey: str
    requestDigest: NotRequired[str]

class StoreRolloverParams(TypedDict):
    expectedStoreId: str
    idempotencyKey: str
    requestDigest: NotRequired[str]

class StoreImportParams(TypedDict):
    backupId: str
    expectedStoreId: str
    idempotencyKey: str
    requestDigest: NotRequired[str]

class ApprovalDecisionParamsDecision(TypedDict):
    choice: Literal["approve", "deny"]
    expectedRevision: int
    comment: NotRequired[str]

class ApprovalDecisionParams(TypedDict):
    approvalId: str
    decision: ApprovalDecisionParamsDecision
    expectedStoreId: str
    idempotencyKey: str
    requestDigest: NotRequired[str]

TaskStatus: TypeAlias = Literal["queued", "running", "waiting_approval", "paused", "blocked", "completed", "failed", "cancelled", "waiting_dependency", "verifying"]
SessionStatus: TypeAlias = Literal["idle", "running", "pausing", "paused", "closed", "outcome_unknown"]
OperationStatus: TypeAlias = Literal["persisted", "completed", "noop", "rejected", "failed", "outcome_unknown"]
RoutingMode: TypeAlias = Literal["continue", "parallel_tools", "reuse", "fork", "fresh"]
