# SPEC-0003-B: Archiving and explicit store rollover after capacity backpressure

Date: 2026-09-19. Status: **design agreed; TDD implementation pending; no RED/GREEN evidence**. This supplements AC-B01–B07 of [SPEC-0003](./0003-policy-retention-deadlines.md) with AC-B08–B18. It depends on [A](./0003-a-lifecycle.md) owner reconciliation and prior [A2](./0003-a2-execution-isolation.md) execution/outcome isolation. APIs, configuration, and failure recovery described here are unimplemented. Existing passing tests do not validate this specification.

## 1. Goals, scope, and exclusions

Minimal tombstones live as long as their store. At the proposed one-million minimal-snapshot/tombstone new-work threshold, owners may auditably raise capacity or, after settlement prerequisites are met, explicitly roll over: archive the old store and accept new work in a new one. Do not delete deduplication identities to free admission capacity or move old tasks into the new store for replay.

Scope is local, single-owner, whole-store offline archiving, read-only archive queries, and active-store switching. Per-record tombstone migration, multi-machine clusters, distributed locks, automatic archive deletion, business-task migration, and global cross-store idempotency are excluded. An archive preserves data still retained at that point; it cannot recover bodies legally collected earlier under AC-B01–B04.

This specification authorizes later fault tests in exclusively owned temporary directories, not implementation, migration, switching, or deletion of real data in this design increment. The bilingual, dual-runtime delivery commitment remains unchanged.

## 2. Identity, authorization, and query contract

### 2.1 Immutable request identity

Every business mutation carries `expectedStoreId`. Callers retain the full retry identity `(storeId, method, scope, idempotencyKey)` and a digest from the same versioned normalization algorithm. SDKs freeze that identity before sending and return it in both successful receipts and transport exceptions. Reconnection, re-handshake, or host switching must not replace a pending retry's old storeId with the current one.

The new host validates identity before idempotency lookup or mutation. Old-store mutations return `STORE_NAMESPACE_MISMATCH`, including expected/current storeId and queryable archiveId when available, without creating operations, messages, tasks, or dispatches. Missing identity returns `STORE_NAMESPACE_REQUIRED`. Old requests have only read/query receipt-recovery paths; never redirect them into new-store mutations.

Mandatory namespace binding is breaking: target `protocolVersion="2.0"` with `storeNamespaces.version=1`. Migrated hosts reject 1.0 handshakes with `PROTOCOL_MISMATCH` before business execution. New SDKs refuse writable state if a 2.0 handshake lacks the capability; ignoring extra fields is not compatibility. Upgrade shared schema, both SDKs, CLI, and host together. Increment database schemaVersion from the last released migration at B implementation time, separately from wire 2.0. Do not enable rollover before both languages are wired.

### 2.2 Owner administration and trusted directories

Add owner-only `stores.rollover({expectedStoreId, idempotencyKey})`, returning durable `rolloverId`, and read-only `rollovers.get({rolloverId})` for progress/results. Store management records in the control directory, deduplicated by original storeId, method, and key. Same-key retries do not start another switch; changed payloads conflict. After active-store change, retries only retrieve the original record and do not authorize another rollover.

Owner configuration specifies `controlDir`, `storesRoot`, and `archiveRoot`; the host generates managed child-directory names. Business requests, model tools, and archive queries cannot supply arbitrary local paths/URLs or override configuration. Directories must be real absolute paths, exclusively owned by the current user and outside the workspace. Reject symlinks, traversal, and untrusted archive references. Existing embedded/managed-stdio owner identity may administer; ordinary sockets/model tools receive `UNAUTHORIZED`.

The atomic control-directory manifest contains store identity, role, managed location, archive verification data, and rollover records. It does not duplicate every business idempotency key into an online index. Historical tombstones stay in read-only original-store archives, so the online directory grows with store count rather than historical request count.

### 2.3 Archive queries

`archives.lookup({storeId, method, scope, idempotencyKey, requestDigest?})` locates archives only through the manifest and enforces original-scope authorization. Return the original operation if details survive. If only a tombstone remains, return `OPERATION_HISTORY_EXPIRED`, original operationId, known terminal state, and retained result references. A mismatched supplied digest returns `IDEMPOTENCY_CONFLICT`. Artifact reads use registered archive artifactId/digest, never caller paths.

Return `NOT_FOUND` only after successfully opening/verifying the correct archive and completing the lookup. An unregistered store, inaccessible archive, or failed integrity check returns `ARCHIVE_NOT_FOUND`, `ARCHIVE_UNAVAILABLE`, or `ARCHIVE_CORRUPT`, respectively. None authorizes replay in a new store. Verification covers at least storeId, schema, database integrity, and manifest digests for files read. Old events retain original storeId/cursor; collected history follows the original retentionFloorCursor rather than joining the new log.

## 3. Backpressure and rollover prerequisites

One million is a new-business backpressure line, not a physical ban on every INSERT. Before admission, reserve bounded settlement records and disk space for existing-task approval/cancel/reconcile and audits, state/terminal persistence, GC completion, rollover manifests, and archive verification. Implementation must enumerate record bounds for supported settlement chains and reject new work before reserves become insufficient. Do not assume capacity remains after hitting the limit. Same-key retries reuse records/reservations.

Settlement capacity cannot fund tasks.create, messages.send, new dispatches, execution-producing resume, or arbitrary new business. Saved-result acceptance resume may settle work only after proving it cannot dispatch a model request. Repeated unnecessary control records under new keys cannot consume unlimited reserves; reject excess explicitly while retaining history. Continue a management operation under its original rolloverId. The parent specification's 256 MiB emergency file frees reserved metadata space, not guaranteed whole-archive capacity. Actual SQLITE_FULL/ENOSPC still stops dispatch under AC-B06.

All of these are required before archive/switch:

- New business/model dispatch is durably stopped. Every Task is completed/failed/cancelled; no queued/running/paused/waiting work remains to continue.
- No active or possibly submitted unreconciled dispatch, unresolved outcome_unknown, evidence conflict, or retained runtime-resource occupancy remains.
- No pending approval, unprocessed message/outbox, pending control, unfinished GC, or file commit remains. Only this rollover management operation may be in progress.
- All owned runtime consumer/cleanup handles are confirmed ended. The old writer can stop exclusively. Active snapshot leases have expired or been normally released; do not discard protected references to force a switch.
- Required databases, artifacts, managed runtime history, and pinned references are readable/verifiable. Destination capacity is sufficient, and every write entry point supports fencing below.

Old unknown operations retain history but no longer count as unresolved when valid A resolution exists, the associated task is terminal, and resource isolation is released. Process exit, owner acceptance of risk, copying a database, or changing storeId cannot replace reconciliation. Failed prerequisites return `ROLLOVER_BLOCKED` with stable object IDs/reasons. Keep the old store in settlement mode for queries, approval, cancel, and reconciliation. No force/ignoreUnknown bypass is allowed.

Static pins need not be deleted: archive their referenced content completely and preserve protection. References requiring object mutation or resumed execution are not static and must be resolved first. Never automatically move pending/unknown work, cancel-and-requeue it unchanged, or create replacement tasks targeting the same work.

When owners cancel work that has definitely not executed, persist auditable non-executed terminal states for tasks/messages/outbox and retain deduplication records. Deleting queue rows is insufficient. Uncertain execution must first be reconciled and cannot use this unexecuted-cancel path.

## 4. One writer and recoverable switching

Use one OS owner lock for the control directory. The active engine holds it and the current store lock. The manifest records `activeStoreId` and a non-reusable `writerEpoch`. Every write entry point validates binding at startup and epoch ownership before model dispatch, control, or persistent mutation. A disappeared old PID is not takeover authority.

All write entry points, including direct stateDir opening, obey registration. A retired marker and minimum writable schema version make old programs refuse startup. If a supported entry point cannot enforce these rules, preflight returns `ROLLOVER_UNSUPPORTED` without switching. This contract covers supported hosts, not manual database edits, lock deletion, or bypass by the same OS user.

Record each recoverable rollover phase before crossing its irreversible boundary. Write the manifest via a same-directory temporary file, fsync, atomic replacement, and parent-directory sync. Database and directory changes are not one fictional transaction.

| Phase | Required actions | Crash recovery |
| --- | --- | --- |
| preparing | Save identity/original writerEpoch, close admission/dispatch, check blockers and capacity | Old store stays in settlement/reconciliation; no automatic execution. Continue after checks; blockers remain queryable |
| archiving | Exclusively stop old writes; create an offline consistent managed staging copy under archiveRoot with database, retained artifacts, runtime history, and manifest | Never publish an unverified copy. Resume or discard only this operation's marked staging copy. Original data remains authoritative and cannot be deleted |
| archive_verified | Verify storeId/schema/digests/references; atomically rename staging to final archive on the same filesystem; persist verification | Reverify/reuse the same archive identity. Keep original dispatch stopped |
| new_prepared | Create an empty store under storesRoot with a fresh storeId, originStoreId/rolloverId, and standby role; copy no tasks/operations/messages | No business writes/dispatch. Reuse the marked store and stable identity on retry |
| old_retired | Persist retired role, invalid epoch, and archive reference in old store; close old writer | Retired database marker prevents revival even if phase record lags. Verify archive/standby and continue. A temporary absence of writers is allowed; two writers are forbidden |
| committed | Atomically register old archive, set new activeStoreId/writerEpoch, and complete rollover result in the manifest; then allow new host startup | Manifest is authoritative. New store gets at most one writer; old store is read-only. Recover lost receipt by rolloverId/original management key without another switch |

Always open archives read-only; they cannot become a second writer with the same storeId. New business writes begin only after committed. Corrupt archive/standby before commit stops switching with an explicit error, never skipped checks. After old_retired, do not automatically roll back to the old writer: repair and continue the same rollover, preserving original data and phase evidence.

If archive space is insufficient before commit, do not delete old data/deduplication identities. Return a capacity error; the owner can adjust trusted storage/capacity and continue the original operation. Do not automatically delete the original directory after commit either. Later redundant-copy collection needs a separately scoped maintenance contract preserving archive integrity.

## 5. Idempotency and backup boundaries

The new store does not inherit old business keys. Guarantee that old requests carrying their original storeId cannot execute in the new store and that old tombstones remain locatable. Do not claim to recognize the same business intent after a caller changes storeId/key. Cross-store deduplication requires a separate stable businessOperationId and authoritative business index, outside this increment.

Preserve AC-B07: normal restart keeps storeId; old-backup rollback, independent import, or cloning creates a fresh storeId, records provenance, and never automatically resumes execution. An old active-directory/epoch backup cannot revive a retired writer. Restoring an old snapshot cannot reconstruct later side effects or missing tombstones; reconcile unknowns. Archives are read-only evidence, not a bypass into writable recovery.

## 6. Numbered acceptance criteria

- **AC-B08 (thresholds and permission):** use scaled test quotas with the same logic as one million. Refuse new task/message/dispatch while preserving same-key lookup. Audit owner quota changes with old/new values and identity; reject ordinary clients/model tools. The alternative is explicit rollover, never automatic tombstone deletion.
- **AC-B09 (settlement reserves):** at exact admission exhaustion, accepted work can still approve/cancel/reconcile and rollover can persist phases. Insufficient reserves stop admission earlier. Same-key retries do not count twice; different-key floods cannot borrow indefinitely. Real persistence faults still stop dispatch without fake durable success.
- **AC-B10 (namespaces):** TS/Python save/retry complete identity. After switching, old-key requests, lost-receipt retries, and requests lingering on old connections fail before new-store mutations. Reject missing fields/unnegotiated clients. SDKs never silently replace expectedStoreId.
- **AC-B11 (directory and archive lookup):** read-only lookup finds original receipts/tombstones by storeId, preserving expired-detail and conflict behavior. Online indexes contain only store/archive records. Reject caller paths, symlinks, escaping files, unauthorized reads, and unknown stores. Old cursors cannot be used in new stores.
- **AC-B12 (corruption fails closed):** missing/inaccessible archives, corrupt databases, mismatched storeId, and artifact digest failures return archive errors, not NOT_FOUND, without model calls/new operations. Only a genuine absence in a verified archive returns NOT_FOUND.
- **AC-B13 (rollover blockers):** individually construct paused/pending work, unprocessed outbox, unresolved unknowns, evidence conflicts, active resources, unfinished GC, and active snapshots. Each blocks with object IDs. Process exit or force is insufficient. Valid resolution plus terminal tasks and stopped resources clears the applicable blocker. No executable old-task copies appear in the new store.
- **AC-B14 (consistent archive):** retain original storeId, all surviving tombstones, and protected references. Verify WAL state, shared artifacts, and runtime-file fixtures. Capacity/integrity failures neither register a usable archive nor delete originals/activate the new store.
- **AC-B15 (phase-by-phase crashes):** crash/restart before and after every phase action, especially after retired but before manifest update and after manifest commit but before receipt. Recover only the same rolloverId without automatic dispatch. Uncommitted stores remain standby; committed stores use only the new epoch. Original-request lookup is unambiguous.
- **AC-B16 (old-writer fencing):** real subprocesses compete for control/store locks and attempt old epoch, direct old stateDir, old-schema writes, and archive writes. At most one active writer may submit/control/dispatch. PID reuse grants no ownership and triggers no unrelated-process killing. Unsupported fencing entry points block the whole rollover.
- **AC-B17 (old/new idempotency):** old key plus old storeId fails in the new store and is recoverable from archives. First use of the same bare key in a new store belongs to a new namespace, without inherited business deduplication. Document caller responsibility for changing identities/keys; provide no automatic old-request recreation shortcut.
- **AC-B18 (backup and rollback):** reproduce old backup → execute K → archive/switch → import old backup → retry K. Import gets a fresh identity without automatically executing old work or rebinding old requests. Restoring an old manifest cannot revive retired writers. Reconciliation/archive/recovery uses no paid models; both SDKs observe matching states/errors.

Implementation must first write failing AC tests and record actual RED, then GREEN. Use temporary directories, real SQLite/filesystems, controlled failure points, and owned fixture subprocesses, with both SDKs for shared protocol acceptance. Only the specification is complete; there are no new test results or verified million-record/disk-quota defaults.
