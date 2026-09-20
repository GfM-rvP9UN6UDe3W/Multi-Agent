# SPEC-0001: Bilingual orchestration foundation

Date: 2026-09-19. Status: the first increment is implemented; see [verification evidence](../tdd/0001-evidence.md). Basis: sections 3, 4, 6, and 10 of `AGENT_ORCHESTRATION_DESIGN.md`. Method: TDD, with behavior tests written to the workspace and observed failing before implementation and recorded GREEN results. At the time of this increment, Git had not been initialized; that work did not publish or commit code.

[SPEC-0003-A](./0003-a-lifecycle.md) subsequently added durable deadlines, unknown-outcome isolation, and owner attestation on the same wire 1.0 protocol. This document preserves the foundation acceptance IDs; see the [0003-A evidence](../tdd/0003-a-evidence.md) for later results.

## 1. Delivery scope

Deliver a locally runnable first increment: one Node engine, SQLite WAL, an embedded TS SDK, stdio/Unix-socket hosts, an asynchronous Python client, human acceptance, durable events and messages, bounded concurrency, pause/resume/cancel, and conservative restart. Use a deterministic runtime for failure paths. Test the two provider adapters separately with protocol fixtures and explicitly identify paid, real-model acceptance as unverified.

The increment uses a per-turn `execute(input)` asynchronous event stream internally. This is a provisional adapter interface under the full design's open/submit/observe lifecycle, with no public compatibility guarantee. Fork, compact, rotate, model-tool delegation, MCP callback bridges, automatic verification commands, monetary budgets, shared-file write locks, and automatic context optimization are outside this increment. Unsupported calls must fail explicitly rather than simulate success. The complete first version follows later stages of the main design.

Require Node.js 22.18+ (built-in TypeScript stripping and `node:sqlite`) and Python 3.11+. TypeScript uses erasable syntax and development-time type checking. Python uses only the standard library and the same host; it does not implement a second scheduler.

## 2. Acceptance criteria

- AC01: Only one engine may hold the OS file lock for a stateDir; a second startup returns HOST_ALREADY_RUNNING. workspace/stateDir must be real absolute directories, and stateDir must be outside workspace. Validate database version and workspace identity at startup.
- AC02: Persist task creation, its operation, and events in one transaction. Identical method+scope+idempotencyKey and normalized payload return the same object; a different payload returns IDEMPOTENCY_CONFLICT. This remains true after restart.
- AC03: Scheduling is ordinary program logic. maxActiveSessions bounds global concurrency, and each session has at most one dispatch at a time. Only explicitly configured provider/model pairs are allowed. Task creation acknowledgment is not execution completion.
- AC04: Persist runtime results before requesting task_acceptance approval. Keep the task waiting_approval. Human decisions require a valid approvalId/revision; approve yields completed and deny yields failed. Reject duplicate, expired, or wrong-target approvals. Ordinary messages cannot approve tasks.
- AC05: Log cursors are ordered decimal strings bound to storeId. Commit state changes and their events atomically. Bounded cursor reads bridge history and live events without losing early arrivals. Reject unknown storeId and out-of-range cursors explicitly.
- AC06: Wait timeout/local coroutine cancellation only stops waiting; it does not cancel submitted work. Explicit tasks.cancel requires confirmation of the current dispatch's terminal state. Disconnection without terminal evidence yields blocked/outcome_unknown.
- AC07: close(drain) stops new dispatch, waits for current turns, and pauses unexecuted work. On timeout, throw SHUTDOWN_INCOMPLETE and retain the client/operationId for continued drain or interrupt. Socket-client disconnect must not close the host; non-owner shutdown is forbidden.
- AC08: On restart, old queued work becomes paused and old running/dispatching work becomes blocked/outcome_unknown. Do not call models automatically or resend blindly. Preserve accepted terminal states and auditable events.
- AC09: Persist messages and outbox entries together. Target task/session/generation must match; duplicate keys must not create another turn. Paused, approval-waiting, or unknown recipients store messages only. Idle active tasks may receive a batch; runtime acceptance evidence advances runtime_accepted and a real terminal state advances completed.
- AC10: Session control checks expectedRevision/expectedGeneration/expectedDispatchId/expectedState. Reject stale controls without affecting new turns. pause(drain) waits for the current turn; pause(interrupt) waits for terminal evidence. Unsupported capabilities fail explicitly.
- AC11: Use single-line UTF-8 JSON-RPC 2.0, a 1 MiB frame limit, and at most 64 pending requests per connection. stdout carries protocol only; consume stderr separately. Handshake before business requests. Invalid methods/fields return explicit errors. Slow event consumers must not create unbounded host-side push queues.
- AC12: TS embedded, Python stdio, and TS/Python Unix clients use the same engine through create → events → human acceptance → terminal state. Python does not read SQLite. Missing values in the four model-usage categories remain null; do not invent zeros or costs.

## 3. First-increment wire contract (1.0)

Parameters are objects. Requests use `{jsonrpc:"2.0",id,method,params}`. Success is `{jsonrpc:"2.0",id,result}`; failure is `{jsonrpc:"2.0",id,error:{code:-32000,message,data:{code:<stable error code>,...}}}`. Clients generate and retain idempotency keys unless callers explicitly supply them. Trusted local business clients share `ownerScope=local`; this is not multi-user isolation.

| Method | params | result |
| --- | --- | --- |
| initialize | protocolVersion:"1.0", sdkVersion:string | protocolVersion,engineVersion,schemaVersion,instanceId,storeId,capabilities |
| tasks.create | spec:TaskSpec, idempotencyKey:string | TaskSnapshot |
| tasks.get | taskId | TaskSnapshot |
| tasks.resume / tasks.cancel | taskId,idempotencyKey | OperationSnapshot |
| sessions.get | sessionId | SessionSnapshot |
| sessions.control | target,command,idempotencyKey | OperationSnapshot |
| sessions.reconcile (0003-A extension) | target,evidence:ReconcileEvidence,idempotencyKey; host owner only | OperationSnapshot |
| messages.send | spec:MessageSpec,idempotencyKey | MessageSnapshot |
| messages.get | messageId | MessageSnapshot |
| operations.get | operationId | OperationSnapshot |
| operations.lookup | method,scope,idempotencyKey | OperationSnapshot or NOT_FOUND |
| approvals.get | approvalId | ApprovalRequest |
| approvals.decide | approvalId,decision:{choice,expectedRevision},idempotencyKey | OperationSnapshot |
| events.read | afterCursor?:string,storeId?:string,taskId?:string,limit?:number | {events:EventEnvelope[],cursor:string,storeId:string} |
| usage.get | taskId | {records:UsageRecord[],completeness:"unknown" or "reported"} |
| capabilities.get | provider?:string | Capability object |
| host.shutdown / host.shutdown.continue | mode:"drain" or "interrupt",timeoutMs:number,operationId?:string | {status:"closed",operationId} |

The SDK's asynchronous events iterator uses bounded `events.read` cursor pulls (50 ms idle wait by default). These query the database without requesting a model. Future subscriptions must preserve cursor/storeId semantics. wait also reads task/operation state only; timeout returns TIMEOUT without remote cancellation. Initial afterCursor defaults to "0", the initial position of the current store. Explicit nonzero resume cursors require storeId.

TaskSpec: `{goal,runtime:{provider,model},acceptance:{mode:"human",criteria:string[]}}`. Store complete runtime output in `stateDir/artifacts/<sha256>.txt`. If result or approval summary exceeds 64 KiB UTF-8, return a clearly marked preview and artifactRefs; human acceptance may require inspecting the complete artifact. events.read pages by both count and a 768 KiB encoded-byte budget; its cursor must not skip unreturned records. TaskSnapshot includes at least `id,status,revision,sessionId,spec,artifactRefs,result:null|string,reason:null|string,approvalId:null|string,createdAt,updatedAt`. SessionSnapshot includes at least `id,taskId,provider,model,providerSessionId:null|string,generation,revision,status,activeDispatchId:null|string`.

MessageSpec: `{taskId,toSessionId,expectedGeneration,kind,summary,artifactRefs?:string[]}`; the host derives the sender. OperationSnapshot: `{id,method,scope,idempotencyKey,status,targetId,result,error}`. ApprovalRequest: `{approvalId,taskId,purpose:"task_acceptance",revision,status,target,summary,evidenceRefs,expiresAt}`. EventEnvelope: `{eventId,cursor,storeId,schemaVersion:1,type,taskId,sessionId,operationId,occurredAt,data}`.

SessionControlTarget requires `sessionId,expectedGeneration,expectedRevision,expectedDispatchId:null|string,expectedState`. command: `{action:"pause"|"resume",mode?:"drain"|"interrupt"}`; other actions return UNSUPPORTED_CAPABILITY. Terminal tasks cannot receive messages or resume. Approving an old result does not automatically deliver a paused session's mailbox. After approval expiry, task/session resume only requests acceptance again; it does not reproduce the result. blocked/outcome_unknown cannot resume directly. 0003-A adds owner-only `sessions.reconcile`, whose exact target must include the non-null quarantined dispatch ID.

0003-A negotiates `initialize.capabilities.lifecycle={version:1,reconcile:"owner-attestation",durableDeadlines:true}`. Older clients may ignore optional additions; newer SDKs do not send reconcile to hosts lacking the capability. OperationSnapshot may include `lifecycle` and `resolution`. The historical A host defaults are `acceptanceMs=30000,turnMs=300000,drainMs=300000,interruptMs=30000,reconcileMs=60000`, each an integer in 1..86400000 ms. [A2](./0003-a2-execution-isolation.md) supersedes the new-turn default and execution-slot accounting. Timeout preserves unknown outcomes and isolation; late evidence does not automatically resume work. SPEC-0003-A defines attestation fields, permissions, and branches; this is not automatic upstream inspection.

Python converts known protocol-envelope fields to snake_case. Custom `data` follows defined known-field rules; arbitrary user-object keys are not rewritten. The SDK provides TaskSpec, RuntimeSpec, AcceptanceSpec, ReconcileEvidence, LifecycleTimeouts, attribute-access snapshots, and handles. Python callers write timeouts into host JSON and pass it through the existing `engine_command` `--config` argument; no new local parameter is added.

## 4. Tests and evidence

Test names reference acceptance IDs. Write tests and observe RED before implementation, then run GREEN, type checking, and real subprocess integration for both languages. Ordinary tests use only fake runtimes, temporary workspace/stateDir directories, and local sockets. They must not read login credentials or invoke paid models. Provider-protocol tests use controlled subprocess/SDK fixtures and do not establish real-provider acceptance.

Record command results in `docs/tdd/0001-evidence.md`, distinguishing unit tests, contract tests, actual subprocess wiring, and unverified real models. README supplies executable local examples and acceptance commands. Update design and usage status/links, while keeping future interfaces explicitly marked as unimplemented.
