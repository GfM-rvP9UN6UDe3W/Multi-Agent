# Concepts

The terms the engine, the SDKs and these documents use. Each entry says it in plain words first, then precisely.

## Engine, host and owner

**Plainly:** one process runs the whole team; everything else asks it to do things.

The engine is a single Node process that alone owns the SQLite state, the schedule, the deadlines and the calls into agent runtimes. A host is the process that runs it: your application (embedded), a child process owned by a Python program (stdio), or a standalone server (Unix socket). The owner is the client that started the host. Some actions, such as shutdown, reconciliation and resolving conflicts, are the owner's only; other socket clients get `UNAUTHORIZED`.

## Session

**Plainly:** one agent that stays warm between tasks and remembers its earlier work.

A logical session is the engine's record of one agent: its runtime (Claude or Codex), model, permission profile and native session identity. A session takes one task at a time and keeps its native history, so a later task can reuse it without starting from nothing. It can also be forked, compacted, paused, resumed or stopped.

## Task, dispatch and turn

**Plainly:** a task is a piece of work; a dispatch is one attempt to run it.

A task has a goal, acceptance criteria and an optional `contextPlan` that declares whether it starts fresh, reuses a session or forks one. When the scheduler starts it, it creates a dispatch: one attempt, with its own deadline. A turn is one exchange with the agent inside a dispatch.

## Messages

**Plainly:** a durable mailbox between agents and your application.

Messages are stored before they are delivered, so a crash does not lose them. A message to a stopped session expires instead of holding its task.

## Acceptance and approvals

**Plainly:** nothing counts as done until a person or a check you registered says so.

Task acceptance is either human review of the result or frozen verification commands the owner registered. A runtime permission approval is different: it lets the agent use a tool during its turn, and it expires.

## A/Q/R capacity

**Plainly:** how many agents can work at once, counting the ones whose outcome is still unknown.

- **A** (`executionOccupied`) counts dispatches that hold an execution lease: they may still be running.
- **Q** (`quarantined`) counts dispatches whose business outcome is unknown.
- **R** (`quarantineReserved`) reserves room for dispatches that hold a lease and are not yet quarantined, including pending cleanup.

A new dispatch starts only when `A < maxActiveSessions` (default 2) and `Q + R < maxQuarantinedDispatches` (default 32). Releasing A does not reduce Q; only reconciling the outcome does.

## Quarantine and `outcome_unknown`

**Plainly:** when the engine cannot tell whether an attempt did its work, it sets that attempt aside instead of guessing.

After a crash, a timeout or contradictory evidence, the engine does not know whether the agent finished, changed files or stopped. It marks the dispatch `outcome_unknown`, blocks the task and quarantines the dispatch. It never resends, retries or resolves it by itself.

## Execution lease and stop proof

**Plainly:** proof that an agent really stopped before its slot is given to someone else.

A dispatch holds an execution lease while it may be running. The lease is released automatically only with stop proof: evidence that nothing was submitted, or a terminal result that covers the execution plus confirmed local cleanup. A timeout, an abort signal, a finished iterator or a missing process ID is not proof.

## Owner attestation

**Plainly:** the owner states what happened, when the engine cannot know.

With `sessions.reconcile`, the owner records separately what happened to local resources, to the remote execution and to side effects. The engine releases what that evidence proves, and keeps everything else quarantined. Only the owner can attest.

## Deadlines

**Plainly:** every attempt has a time limit that nothing can extend.

A dispatch gets one total budget, 1,800 seconds by default, from the smaller of the host timeout and the adapter's cap. It includes start-up and acceptance. It is enforced on a monotonic clock, and restarts or retries do not refresh it.

## Idempotency and operations

**Plainly:** sending the same request twice does the work once.

Each change carries an idempotency key. The engine stores `(storeId, method, scope, key, digest)`, so a retry returns the first result, and a different request with the same key is refused. `operations.lookup` finds the result later.

## Store, state directory and rollover

**Plainly:** where the engine keeps its data, and how it starts a fresh one without losing the old.

The state directory holds the SQLite store and the result artifacts. It must be private and outside the workspace. A rollover closes a finished store and starts a new namespace; an archive keeps the old one readable. Old data is collected by bounded retention rules, never deleted wholesale.

## Context references

**Plainly:** earlier results a new task may read.

A `contextPlan` can list up to 20 artifacts of earlier results. Each must be readable and at most 32 KiB; the engine checks this when the task is submitted, and `context.checkRefs` reports the same answer beforehand.

## Delegation and handoffs

**Plainly:** agents can ask for help, but the host decides.

With model tools enabled, an agent can delegate a subtask or request a handoff to another agent. A delegated child starts paused until the host approves it. A handoff runs under the receiving agent's permissions once the host accepts it.

## Read fence and write paths

**Plainly:** what files an agent may look at and change.

By default, reading tools are fenced to the workspace and the configured read roots. A writable session may write only inside its declared write paths.

## Routing layer and judge

**Plainly:** an optional helper that suggests which agent should take a request.

The routing layer asks a judge you choose, a model or plain rules, and proposes an ordinary task declaration. It never submits by itself, and the engine still applies all its rules to what is submitted.

## Usage records

**Plainly:** a durable record of tokens each attempt used.

Every usage observation from a runtime is stored with one `usage.recorded` event in the same transaction. Missing values stay unknown; cost estimates from registered prices are estimates, not bills.
