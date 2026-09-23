# SPEC-0009 implementation evidence

Dates: 2026-09-20–21. Status: authorized implementation and offline acceptance complete. This is not real-provider or public-release acceptance. Earlier sections preserve intermediate RED/GREEN results chronologically; their pending statements apply to that recorded stage and are superseded by the completion matrix and final verification below.

## Dependencies, write ownership and registered verification

Initial RED: `node --test tests/engine/design-completion.test.ts` produced **0 passed / 6 failed**. Failures were missing `dependencyTaskIds`, two simultaneous workspace writers, and unsupported checks acceptance. No native models or credentials were used.

GREEN: the same six cases pass. Commands are real Node subprocesses, including nonzero exit, timeout/kill, and workspace mutation during verification. Results retain the registered rule digest, content baseline and bounded output in an immutable artifact. The preauthorized command runs as the host OS user; baseline checks detect changes, but do not claim an OS sandbox. Native sandbox acceptance remains a separate gate.

Python: `PYTHONPATH=python/src python3 -m unittest python.tests.test_node_e2e.NodeHostTests.test_f01_f08_real_node_dependency_and_registered_check -v` passes against the actual Node stdio host. It verifies dependency waiting with zero occupied slots and completed only after prerequisite acceptance plus the registered command.

## Logical sessions and declared routing

Initial RED: `node --test tests/engine/session-routing.test.ts` produced **0 passed / 4 failed**: unsupported session opening and rejected contextPlan. GREEN: all four pass, covering no-model logical opening, serial native-ID reuse, cross-root refusal, persistent queue expiry without late submission, and an explicitly declared fresh fallback.

Intermediate regression: `node --test tests/engine/*.test.ts` **86 passed / 0 failed**, and `npm run typecheck` passes. These counts do not cover later increments.

The first full Node/Python invocation hit the environment's Unix-socket `EPERM`. Those runs are not recorded as passes. A foundation assertion that malformed checks must always be unsupported was updated to expect validation failure now that registered checks exist. Full tests with local IPC permission remain required after integration.

## Session lifecycle and bound engine tools

Session lifecycle RED: the routing suite first reported **4 passed / 2 failed** for missing fork/compact/rotate/stop. Its six cases now pass. Fork preparation is explicitly a logical receipt (`nativeForkPending`); the first execution must fork at the frozen native checkpoint and return a different native identity. Rotation preserves a content-addressed generation snapshot. Compaction has its own durable maintenance task/operation and only completes with native evidence. Stop closes scheduling without relabeling an already accepted task as cancelled.

Provider lifecycle RED: `node --test tests/contract/native-session-lifecycle.test.ts` **0 passed / 6 failed**. GREEN: **6 passed**, using actual owned Node children for Claude cleanup and a real Codex stdio protocol peer. Both adapters pass fork checkpoint parameters and reject compaction success without a boundary. These are offline transport cases, not saved-history or real-model acceptance. The implementation was checked against installed Claude SDK 0.3.274 declarations and Codex CLI 0.153.4 generated protocol types, plus [Claude session guidance](https://code.claude.com/docs/en/agent-sdk/sessions) and [Codex App Server protocol](https://learn.chatgpt.com/docs/app-server).

Tool-entry RED: `node --test tests/engine/runtime-tools.test.ts` **0 passed / 3 failed**. GREEN: **3 passed** for fixed tools, bound identity, inherited task policy, idempotent delegation, subtree rejection, stale-grant revocation and repeated-read limits. The tools are opt-in owner configuration (`tools.enabled`). This step tests the engine entry points, not the still-pending native MCP transport.

Latest intermediate engine run: **91 passed / 0 failed** and TypeScript checking passes. Queue timers were corrected to rearm when awakened before their monotonic deadline; they do not renew the persisted admission deadline. Full wire/IPC/package acceptance remains pending.

## Private MCP transport, permission approval and inspection

Private bridge RED: the first `tests/contract/tool-bridge.test.ts` case failed because the implementation module did not exist. After implementation and adapter integration, **3 cases pass**, including actual owned Codex/stdio bridge processes, credential refusal, bounded requests, fixed tool names and revoked dispatch credentials. These tests require local Unix-socket IPC permission.

The explicit installed-SDK check also passes:

```sh
node tests/fixtures/claude-native-mcp-smoke.ts '/Users/masonlee/Claude/Projects/op agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'
```

It exercises installed Claude SDK **0.3.274**, its real in-process MCP server and permission callback against an offline owned subprocess. All four tools and one `Read` permission request reach the supplied engine-style handlers, with **zero model calls**. The four owner-enabled orchestration tools are preapproved at the native MCP layer; their engine authorization and limits still apply. Native permission requests are a separate approval channel, not task acceptance.

Post-implementation regression coverage (no initial RED claimed): `tests/engine/runtime-approval.test.ts` **4 passed**, `tests/contract/runtime-approval.test.ts` **2 passed**, and `tests/contract/runtime-inspection.test.ts` **2 passed**. Cases cover approve/deny/expiry/cancel/replay, exact Codex thread/turn permission responses, a real read-only `thread/read` child, and bounded inspection failure without changing task acceptance. Python `test_f07_runtime_permission_is_not_task_acceptance` passes through the actual Node stdio host.

Message-limit RED: after correcting a fixture's nonexistent `tasks.pause` call, the case failed on unsupported `ttlMs`. GREEN: `tests/engine/message-limits.test.ts` **1 passed**, showing expiry, durable rate limits, idempotent retry and restart behavior. Hop limits are implemented; dedicated chain/failure coverage is still required.

## Cost normalization and budget reservation

Accounting RED: `tests/engine/accounting.test.ts` initially failed because the module did not exist. GREEN plus integration regression: **2 passed**, covering exact decimal pricing with disjoint cache buckets, unknown fields, separate keep/compact request sequences, and concurrent dispatch reservations. Known complete usage settles unused reservation; absent usage retains its reserved balance. These are registered-price estimates, not provider invoices or no-overspend guarantees. Economic automatic selection remains disabled.

The first intermediate full run after tool integration reported Node **374 passed / 3 failed / 0 skipped** out of 377 and Python **46 passed**. The three Node assertions still expected the pre-fork Codex result shape; they were updated to include the required native checkpoint. A later targeted check also updates raw-usage expectations to preserve the cumulative source snapshot alongside normalized deltas. Those earlier full-run failures are not presented as a passing final regression.

AC-F01–F17 are tracked in the specification. This intermediate evidence does not mark session fork/compact/rotate, private runtime tools, permission approvals, budgets, storage governance, archive rollover, package artifacts or native acceptance as complete. Each requires its own implementation and failure-path evidence before the final completion matrix is updated.

## Namespace-bound writes and storage lifecycle (2026-09-20)

Namespace RED: `node --test tests/contract/store-namespaces.test.ts` reported **0 passed / 2 failed**: protocol 1.0 was still accepted, and receipts had no immutable store identity. GREEN: **2 passed**. Wire 2.0 now requires `expectedStoreId` before mutation or expiry side effects, negotiates `storeNamespaces.version=1`, and returns a versioned retry identity. Both clients retain method/scope/key/store/digest across retries and explicit namespace refresh. Digest v1 sorts UTF-8 object keys and encodes finite JSON numbers as binary64, so Python and TypeScript agree without decimal-text ambiguity. Real Python managed-host rollover/retry coverage passes, including Unicode input and the old receipt remaining recoverable in the archive.

Storage RED: the new governance suite failed on its missing implementation module. GREEN: **3 cases passed** for retained lifetime tombstones, reference protection, fixed snapshot pages/cursor expiry, and scaled admission/settlement reserves. References are indexed transactionally; reverse reachability protects shared artifacts without decoding all retained objects for every GC candidate. GC has a bounded candidate count/byte budget and a 50 ms target; callers must not assume one batch drains all eligible work. Tests use controlled retention time. The million-record and 10 GiB defaults are policy values, not measured capacity claims.

Rollover RED: `tests/contract/store-rollover.test.ts` initially reported **0 passed / 2 failed**, because rollover was absent. Initial GREEN: **2 passed**. Subsequent regression cases verify backup-before-K, execution/cancellation of K, rollover, import of the old backup under a fresh identity, old-store retry rejection, archived receipt recovery, and refusal to revive a retired writer after restoring an old control manifest. A real competing subprocess cannot acquire a second control owner. Opening an archive through the writable Store path fails before changing archive files.

Post-implementation fault regression (no fabricated pre-implementation RED): **18 actual subprocess crash points** across preparing, archiving, archive verification, standby preparation, retirement and commitment pass. They include the gap after old-store retirement and the gap after manifest commitment before activation/receipt. Recovery continues the original rollover ID without copied executable tasks or model calls. Three artifact-write crash points and five garbage-collection crash points also pass. A real SQLite page limit produces `SQLITE_FULL`; failed operation persistence rolls back, admission stops, and the emergency file is released. Separate actual child-process cases inject full storage after dispatch and inside terminal settlement; restart preserves unknown state and makes **zero replay calls**.

Schema migration creates and verifies the legacy recovery SQLite file plus a complete bundle containing retained artifacts and managed runtime history before schema 3 commits. A fault immediately before migration commit leaves the original schema unchanged and the bundle verifiable. Native history outside managed storage is not asserted to be copied. Archive reads verify registered identity, database integrity and digests; corruption never becomes a `NOT_FOUND` result.

An intermediate full run reported Node **410 passed / 4 failed**, Python **47 passed**. Three failures depended on tiny real-time windows under heavy parallel filesystem load; one assumed a single GC batch completed all work. Approval-expiry tests now use controlled wall time, the GC test follows bounded batches, and the test runner uses four worker processes. Runtime execution deadlines are unchanged. The targeted lifecycle/history recheck passed **44/44**. A subsequent full run is recorded separately after completion; the intermediate failures remain visible here.

## Final edge, CLI and contract completion

Later regression coverage extends accounting to late usage, original-owner preservation across serial reuse, direct/tree totals, repeated upstream IDs in different dispatches, and idempotent host overhead. Message-hop chains remain bounded after restart. Imported unfinished work without an original active dispatch now receives a quarantined synthetic reconciliation target instead of an unusable blocked record; the import test resolves it explicitly without model replay.

Edge RED/GREEN: snapshot clock rollback and verifier inherited-pipe cleanup initially failed, then passed with monotonic 60-second lease expiry and independent bounded verification cleanup. Unconfirmed verifier resources retain the execution/write lease. A queued task whose registered write scope changes before dependency acceptance is blocked before dispatch. These are local boundary checks, not an OS sandbox proof.

GC payload/archive corruption RED: `node --test tests/engine/storage-governance.test.ts tests/contract/store-rollover.test.ts` reported **8 passed / 2 failed**. Artifact payload bytes had not counted toward the 8 MiB batch budget, and missing archive components were mislabeled unavailable. GREEN: **10 passed** after fixing byte accounting/cursor continuation and distinguishing an inaccessible root from a missing component in an accessible archive. Oversized single artifacts are reported and retained rather than violating the bound.

CLI run/attach/control and offline doctor were implemented after an initial **0/2** CLI feature RED. The doctor checks actual dependency versions, Node/SQLite and access without opening the application's state database or calling a model. CLI observation detaches at actionable states by default, explicit TTY decisions carry the exact approval revision, and control freezes its original target. Existing shutdown/request-deadline contracts remain enforced.

Generated protocol parity receives regression coverage rather than a fabricated RED. The shared schema now includes wire 2.0, namespace identity, routing/checks, logical nullable sessions, runtime approval and lifecycle fields. `generate:protocol` deterministically emits four artifacts with the source SHA-256. Actual payload and corrupted variants are checked through TS and Python; unsupported schema assertion keywords fail closed. This is a supported subset validator, not a complete JSON Schema implementation.

Both native tools now run through an actual engine in offline acceptance. `native-mcp-engine-smoke.ts` delegates, messages, reads and pauses the delegated child before any child model call. The installed Claude SDK **0.3.274** and actual Codex CLI **0.153.4** protocol-generation preflight pass. Four tools are preapproved at native MCP but still enforce engine grants; native Read permission uses the separate approval callback. **Zero model calls and no login credential inspection.**

Storage-degraded shutdown RED: new TS client/Unix-host tests reported **0 passed / 2 failed**, and the actual SQLite-full Python-to-Node case failed because the client retained its owner handle after resources had closed. GREEN: **14/14** targeted Node shutdown/storage-fault cases and **1/1** Python case passed. The engine preserves STORAGE_DEGRADED_CLOSED with `durableReceipt:false`; host sockets/pipes and both client handles now retire after confirmed resource closure while retaining the error. The Node owner exits normally. SHUTDOWN_INCOMPLETE continues to keep its live handle.

## Capacity and supported environments

Reproduce with `node scripts/capacity-benchmark.ts 1000,10000 100`; [raw report](0009-capacity.json) records the exact host and measurements. These samples used Darwin 25.6.0 arm64, Apple M5 Pro (18 CPUs, 64 GiB physical memory), Node 24.14.0 and deterministic offline execution. Each sample has 100 new tasks after retained history is seeded.

| Retained tasks / records | Dispatches per second | Admission p95 | Observed peak RSS | First snapshot page | GC batches |
| --- | --- | --- | --- | --- | --- |
| 1,000 / 3,000 | 21.62 | 5.12 ms | 123.7 MiB | 4.32 ms | Approximately 51 ms each |
| 10,000 / 30,000 | 21.02 | 8.44 ms | 141.0 MiB | 40.64 ms | Approximately 52 ms each |

SQLite BEGIN p95 was roughly 0.003 ms in one owning process; that is not multi-writer contention throughput. Synchronous reference work can exceed the 50 ms GC target slightly; the count/byte limits remain hard. Quota accounting and some ledger queries still depend on retained data size. No million-record/10 GiB or long-lived production claim is made. Samples preceded the final GC payload correction and shutdown-envelope fix; neither changed the benchmark's payload-free workload. The raw report is preserved rather than relabeled as a new measurement.

`.github/workflows/offline.yml` configures macOS 14 and Ubuntu 24.04 with Node 22.18.0/Python 3.11.13 and Node 24.14.0/Python 3.14.6, plus exact native protocol-only jobs. These remote cells were **not executed** in this task. No weekly automation was created. [Acceptance instructions](../acceptance/README.md) distinguish configured and measured environments.

## Local distributions and runnable parity

`npm run build:packages` emits five JavaScript/declaration tarballs with optional independent adapters. Python's wheel includes generated schemas/types and no third-party runtime dependency; the sdist rebuilds in the prepared isolated build environment. Package smoke performs six modes: installed embedded TS, packaged Codex private MCP, Codex-only import, Claude-only import, installed Python with owned Node host, and Python after rebuilding/reinstalling the sdist. All installs are offline in fresh temporary environments; no native dependency or model is implicitly installed/invoked.

The matching `examples/typescript/checks-and-dependencies.ts` and `examples/python/checks_and_dependencies.py` both complete two fake tasks through registered real-process checks and read a fixed four-item state snapshot. An initial TS example used a nullable-offset termination assumption and hit SNAPSHOT_EXPIRED; it was corrected to honor `done`. Python uses `snapshot["items"]` to avoid the Mapping.items name collision. Both corrected examples pass with zero models.

Native acceptance is prepared only. `native-acceptance.mjs prepare` writes the reviewable plan without credentials or models; run requires its explicitly authorized SHA-256, exact versions, one read-only bounded turn, registered pricing and spending estimate. No real-provider run, actual native OS sandbox, external host integration, economic experiment, publication, commit or push occurred in this increment.


## Final verification

Final full runs after the storage-degraded client/host fix:

| Command / boundary | Result |
| --- | --- |
| `npm test` | **433 passed, 0 failed, 0 skipped**; approximately 31.3 s |
| `npm run test:python` | **48 passed**, 0 skipped; approximately 13.0 s |
| `npm run typecheck` | Passed |
| `npm run format:check` | Passed, including scripts and examples |
| `npm run check:generated` | Passed; 57 definitions / four generated artifacts |
| Pinned native protocol check | Claude SDK 0.3.274 / Codex CLI 0.153.4 passed, zero models |
| Matching TS/Python dependency/check/snapshot examples | Both passed; two completed tasks and four snapshot items each |
| `npm run build:packages` | Five private local npm tarballs emitted with declarations and SHA-256 manifest |
| Isolated Python `build --no-isolation --sdist --wheel` | Wheel and sdist emitted |
| `PACKAGE_BUILD_PYTHON=... npm run test:packages` | All six clean offline installation/runtime modes passed on the final rebuilt packages |
| `git diff --check` | Passed |

Local artifacts are under `dist/release`; final logs and source/artifact identities are under `dist/verification`. These ignored build outputs are not committed. The source changes remain uncommitted on local main based on f18906b. All edits are confined to this repository/task-owned temporary files; the installed native SDK was read from another project for the explicit offline transport check, without modifying that project.

Prepared CI is not executed CI. Prepared native acceptance is not a model run. Economic automatic selection remains disabled. No production-readiness, real native sandbox, complete real-model safety, measured savings or publication claim follows from these checks.
