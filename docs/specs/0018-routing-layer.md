# SPEC-0018: Optional routing layer with pluggable judges

Date: 2026-09-22. Status: approved by the owner (TypeScript and Python ship together; routing never crosses a group; a group is one engine, or one root task inside an engine); implemented on branch `routing-layer`. Evidence: [TDD-0018](../tdd/0018-routing-layer.md). It changes the product boundary in [AGENT_ORCHESTRATION_DESIGN.md](../../AGENT_ORCHESTRATION_DESIGN.md) §5.1.

## Why

The engine executes declared routing. A caller states the mode, the candidate session, independence, context references, the queue wait and the fallbacks, and the engine validates and enforces that declaration. Nothing in the SDK decides *what* to declare: which agent should take a request, whether to wait for a busy agent, which earlier results to carry, or which agents a new finding affects. Every host has to build that itself, and a model calling `work_delegate` cannot see what the other agents are doing.

Offline trials on 2026-09-22 with TypeSafe's Jev judgment model (`jev-1.13.0`) answered these questions in 0.7–0.9 seconds for about $0.0001 per call, including Chinese requests. A four-agent trial answered 33 routing judgments in one call; the clear cases were right, and the ambiguous ones came back with low confidence.

## Boundary

- The engine keeps declared routing unchanged. It makes no semantic judgment, and its compatibility, cross-root, capacity, write-conflict, queue and approval rules still apply to every declaration.
- Routing stays inside one group, and the router has no option to cross it. §5.1 already keeps default reuse within one root task and never across user, project or permission boundaries. The host tells the router which kind of group it runs:
  - `scope: 'root'`, the default: a group is one root task with every task below it. Candidates must share the request's root task, and the proposed task is a child of that root.
  - `scope: 'engine'`: a group is a whole engine. The host runs one engine per group, with its own workspace, and configures that engine with `allowCrossRootReuse`. Every member session of the engine can be a candidate, and the proposed task needs no parent. The engine does not report `allowCrossRootReuse` to clients, so this scope is the host's declaration. A wrong declaration surfaces as the engine's `HISTORY_REUSE_FORBIDDEN` when the proposal is submitted.
- The SDK adds an optional routing layer. A host enables it explicitly and chooses the judge: the built-in Jev adapter, or its own implementation of the `Judge` interface backed by any model or by rules. Hosts may also ignore the layer and declare routing themselves.
- The layer only proposes. A proposal is an ordinary `TaskSpec` with `contextPlan`, plus the reasons behind it; the host decides whether to submit it.
- No engine, wire protocol, schema or storage change.
- §5.1 changes from "Do not add a management model call for routing" to: "The engine and host core add no model call for routing. An application may opt into the SDK routing layer, whose judge it chooses and pays for."

## Interfaces

TypeScript, exported as `@agent-orch/sdk/routing`; Python mirrors them in `agent_orch.routing` with snake_case names and the standard library only.

- `Judge.evaluate({ state, questions })` returns one answer per question id. Question kinds:
  - `choice`: an option set, answered with the choice, probabilities and a confidence;
  - `yesno`: answered with the probability of yes;
  - `score`: ordered levels, answered with level probabilities and a confidence.
- `createJevJudge({ apiKey, model = 'jev-1.13.0', baseUrl = 'https://api.typesafe.ai', timeoutMs = 10000, fetch? })`:
  - calls `POST /v1/systemone` with a bearer token and maps the three kinds to Jev's choice, noul and score;
  - retries 429, 529 and 5xx once within the timeout, and never retries 401 or 422.
- `createRouter({ orchestrator, judge, runtimes, scope?, describe?, policy? })`. `runtimes` names the provider and default model for fresh read-only and writable work, each with an optional `small` and `large` model. It has these methods:
  - `route(request)` takes the goal, acceptance, the group's member session ids, the group's root task id for `scope: 'root'`, and optional `needsWrites` and extra task fields. It returns a `RouteProposal` and has no side effects. Under `scope: 'root'` without a root task id, the request starts a new group, and the only possible proposal is a fresh session.
  - `submit(proposal)` calls `tasks.create(proposal.spec)`.
  - `notifications({ text, fromSessionId })` returns the sessions a finding affects; `notify(...)` sends them with `messages.send`.
- A `RouteProposal` holds:
  - `spec`, the fields to submit;
  - `decision`, which is `reuse` with a session id, or `fresh`;
  - `confidence` and `needsConfirmation`;
  - `alternatives`, each with its probability;
  - `reasons`, each a code with the probabilities behind it;
  - `judge`, the model, latency and usage, or why the judge was unavailable.

## Roster and filter (deterministic)

- The host passes the group's members as session ids; they correspond to a host's agents. The router reads each with `sessions.get` and its latest task with `tasks.get`, up to `policy.maxCandidates` (default 16). It never lists other tasks, so nothing outside the members is read.
- It describes each candidate with the host's `describe` callback. The default description is the latest task goal plus the first 600 characters of its result. Because routing work to an agent changes its latest task, hosts should describe agents by a stable role. The judge sees agents under neutral aliases (A1, A2, ...), never session ids. Only the goal, these descriptions and a finding's text are sent to the judge.
- Before asking the judge, it drops the candidates the engine would refuse or that cannot take work:
  - sessions that are closed, paused, pausing or have an unknown outcome;
  - sessions without a task, whose write scope cannot be recovered;
  - under `scope: 'root'`, sessions whose root task differs from the request's;
  - a write scope or write path in the request's extra fields that differs from the candidate's.
- A reused candidate keeps its provider, model and write scope: the proposal copies them from its latest task, so the engine's compatibility check passes.
- A candidate is busy when it is not idle or its latest task has not ended, for example while that task awaits approval.

## Judgments (one judge call per route)

- `best`: a choice over the remaining candidates plus `fresh`. When the request needs writes, read-only candidates are removed after the answer and the remaining probabilities are renormalized.
- `relevant_<session>`: yes/no, whether that agent's work helps this request.
- `writes`: yes/no, asked only when the host did not set `needsWrites`.
- `size`: trivial, moderate or large, asked only when the host gave a model ladder.
- For a busy `best` candidate, two more:
  - `depends`: none, helpful or essential, how much the request depends on its current work;
  - `clash`: yes/no, whether running both at once risks editing the same code.

## Policy (deterministic; all thresholds configurable)

- **Judge unavailable** (error or timeout): propose a fresh session on the default runtime with no context references, with reason `JUDGE_UNAVAILABLE`, and require confirmation by default.
- **Fresh**: when `best` is `fresh`, or no candidate is relevant (every `relevant` below 0.5), propose `fresh`. Candidates with `relevant` of at least 0.7 contribute their latest result artifact to `contextRefs`, highest probability first, at most 20.
- **Idle best**: reuse it.
- **Busy best**:
  - If `clash` is at least 0.5, or `depends` is essential with at least 0.5, reuse it and wait up to `policy.busyWaitMs` (default 20 minutes). The fallback is `fresh` carrying its latest result, unless `depends` is essential with at least 0.7; then there is no fallback.
  - Otherwise propose `fresh` now, carrying its latest result.
- **Model**: only fresh sessions choose one. A trivial `size` of at least 0.85 selects the small model, a large `size` of at least 0.7 selects the large one, and anything else keeps the default. Reuse keeps the candidate's model, because the engine requires it.
- **needsConfirmation** is set when any of these holds:
  - `best` confidence is below 0.85;
  - the top two options are within 0.2 of each other;
  - `writes` is between 0.3 and 0.7;
  - the judge was unavailable.
- `independent` is declared `true` for reuse and for fresh child tasks, as the engine requires. The waiting behavior comes from the queue and its fallback, not from dependencies.

## Notifications

For each other session in the source's group whose current task is not terminal, the judge answers yes/no: could this finding change what that agent should do or has done?

- At 0.7 or more, the session is proposed for a `finding` message.
- Between 0.5 and 0.7, it is listed for confirmation.
- The source session is excluded.
- An idle agent whose task ended cannot receive messages under the engine's rules. It is reported as affected, so the host can start a follow-up task instead.
- If the judge fails, the plan names no agent and reports why.

## Acceptance criteria

- **R01** The router works with any `Judge` implementation. A fake judge drives every policy test.
- **R02** A submitted proposal is never refused for compatibility, cross-root or closed-session reasons when the declared scope matches the engine, verified against a real engine with the fake runtime under both scopes. No candidate, context reference or notification comes from outside the members, or, under `scope: 'root'`, from outside the root task.
- **R03** The policy table above holds case by case: idle best, busy with clash, busy with essential and helpful dependence, no relevant agent, a write-only need, and the model ladder.
- **R04** `contextRefs` carries the relevant agents' latest result artifacts, ordered by probability, at most 20.
- **R05** Low confidence, a narrow margin or uncertainty about writes sets `needsConfirmation` and lists the alternatives. `route` never submits.
- **R06** A judge error or timeout yields the deterministic fallback proposal with `JUDGE_UNAVAILABLE`.
- **R07** Notifications exclude the source, respect the thresholds, and report affected sessions that cannot receive messages.
- **R08** The Jev adapter sends the documented request, header and body, maps the answers and handles errors. It is tested against a local HTTP fake, with no network and no credentials.
- **R09** Python mirrors R01–R08.
- **R10** Documentation: a README section, the wiring guide, and the §5.1 amendment.

## Verification

Ordinary tests use the fake judge, a local HTTP fake of the Jev API and the fake runtime, with no network, credentials or model calls. Live Jev calls are not part of this change. A follow-up is a labelled set of about 40 routing cases in Chinese and English, run by the owner with their own `JEV_API_KEY`. It would report agreement with the labels and calibrate the default thresholds, and it would stay outside CI.
