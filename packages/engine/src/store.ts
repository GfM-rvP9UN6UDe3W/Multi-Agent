import { completeMigrationBackup } from './archive.ts';
import { atomicFile, syncDirectory } from './durable-files.ts';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  realpathSync,
  chmodSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  lstatSync,
} from 'node:fs';
import { isAbsolute, relative, join, sep, dirname, basename, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fail } from './errors.ts';
import type { EventEnvelope, EventPage, Json, OperationSnapshot, TaskSnapshot } from './types.ts';

const TABLES = [
  'tasks',
  'sessions',
  'messages',
  'outbox',
  'approvals',
  'dispatches',
  'artifacts',
  'usage',
  'execution_conflicts',
  'tool_calls',
  'tool_loops',
  'costs',
  'budget_reservations',
  'storage_pins',
  'gc_jobs',
  'file_commits',
  'storage_reserves',
] as const;
export type Table = (typeof TABLES)[number];

function isOutside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
}

// Resolve an existing ancestor before mkdir, including /tmp aliases and symlinks.
function futureRealpath(path: string): string {
  const missing: string[] = [];
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return join(realpathSync(ancestor), ...missing);
}

export interface StoreOptions {
  now?: () => number;
  fault?: (point: string) => void;
  fence?: () => void;
  allowStandby?: boolean;
}
export class Store {
  readonly db: DatabaseSync;
  readonly lock: DatabaseSync;
  readonly storeId: string;
  readonly workspace: string;
  readonly stateDir: string;
  private closed = false;
  readonly now: () => number;
  readonly options: StoreOptions;
  degraded = false;

  constructor(workspace: string, stateDir: string, options: StoreOptions = {}) {
    this.options = options;
    this.now = options.now ?? Date.now;
    if (!isAbsolute(workspace) || !isAbsolute(stateDir))
      fail('VALIDATION_ERROR', 'workspace and stateDir must be absolute');
    this.workspace = realpathSync(workspace);
    const candidate = futureRealpath(stateDir);
    if (!isOutside(this.workspace, candidate) || !isOutside(candidate, this.workspace))
      fail('VALIDATION_ERROR', 'workspace and stateDir must not contain each other');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.stateDir = realpathSync(stateDir);
    if (!isOutside(this.workspace, this.stateDir) || !isOutside(this.stateDir, this.workspace))
      fail('VALIDATION_ERROR', 'workspace and stateDir must not contain each other');
    // Reject retired/archived/registered/future stores before changing any file or journal mode.
    const existingDatabase = join(this.stateDir, 'store.sqlite');
    if (existsSync(existingDatabase)) {
      if (
        !lstatSync(existingDatabase).isFile() ||
        realpathSync(existingDatabase) !== existingDatabase
      )
        fail('UNTRUSTED_PATH', 'Store database must be a regular file');
      const probe = new DatabaseSync(existingDatabase, { readOnly: true });
      try {
        const hasMetadata = probe
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'")
          .get();
        if (hasMetadata) {
          const meta = (key: string) =>
            (
              probe.prepare('SELECT value FROM metadata WHERE key=?').get(key) as
                | { value: string }
                | undefined
            )?.value;
          const version = meta('schemaVersion'),
            role = meta('role');
          if (version && !['1', '2', '3'].includes(version))
            fail('SCHEMA_MISMATCH', `Unsupported store schema ${version}`);
          if (
            role === 'retired' ||
            role === 'archive' ||
            (role === 'standby' && !options.allowStandby)
          )
            fail('STORE_RETIRED', 'This store is not writable', { role });
          if (meta('controlDir') && !options.fence)
            fail('STORE_FENCED', 'Registered stores require their control owner');
        }
      } finally {
        probe.close();
      }
    }
    options.fence?.();
    chmodSync(this.stateDir, 0o700);
    this.lock = new DatabaseSync(join(this.stateDir, 'owner.sqlite'));
    try {
      this.lock.exec(
        'PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS ownership (owner TEXT);',
      );
    } catch (error) {
      this.lock.close();
      if ((error as { errcode?: number }).errcode === 5 || /locked|busy/i.test(String(error)))
        fail('HOST_ALREADY_RUNNING', 'Another engine owns stateDir', { stateDir: this.stateDir });
      throw error;
    }
    let database: DatabaseSync | undefined;
    try {
      chmodSync(join(this.stateDir, 'owner.sqlite'), 0o600);
      database = new DatabaseSync(join(this.stateDir, 'store.sqlite'));
      this.db = database;
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL)',
      );
      const meta = (key: string) =>
        (
          this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as
            | { value: string }
            | undefined
        )?.value;
      const version = meta('schemaVersion');
      if (version && !['1', '2', '3'].includes(version))
        fail('SCHEMA_MISMATCH', `Unsupported store schema ${version}`);
      const role = meta('role');
      if (role === 'retired' || role === 'archive' || (role === 'standby' && !options.allowStandby))
        fail('STORE_RETIRED', 'This store is not writable', { role });
      if (meta('controlDir') && !options.fence)
        fail('STORE_FENCED', 'Registered stores require their control owner');
      options.fence?.();
      const previousWorkspace = meta('workspace');
      if (previousWorkspace && previousWorkspace !== this.workspace)
        fail('WORKSPACE_MISMATCH', 'State belongs to a different workspace');
      this.storeId = meta('storeId') ?? randomUUID();
      if (version && version !== '3') {
        const backup = join(this.stateDir, `store-schema${version}-${randomUUID()}.sqlite`);
        options.fault?.('migration.backup_started');
        this.db.prepare('VACUUM INTO ?').run(backup);
        chmodSync(backup, 0o600);
        const verified = new DatabaseSync(backup, { readOnly: true });
        try {
          const check = verified.prepare('PRAGMA integrity_check').get() as {
            integrity_check: string;
          };
          const saved = verified.prepare('SELECT value FROM metadata WHERE key=?');
          if (
            check.integrity_check !== 'ok' ||
            (saved.get('schemaVersion') as { value: string }).value !== version ||
            (saved.get('storeId') as { value: string }).value !== this.storeId ||
            (saved.get('workspace') as { value: string }).value !== this.workspace
          )
            fail('SCHEMA_MIGRATION_FAILED', 'Recovery backup validation failed');
        } finally {
          verified.close();
        }
        completeMigrationBackup(backup, this.stateDir, this.storeId, version);
        options.fault?.('migration.backup_verified');
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const table of TABLES)
          this.db.exec(
            `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
          );
        this.db.exec(
          'CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY,method TEXT NOT NULL,scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(method,scope,key))',
        );
        this.db.exec(
          'CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT,taskId TEXT,data TEXT NOT NULL)',
        );
        this.db.exec('CREATE INDEX IF NOT EXISTS events_task_cursor ON events(taskId,cursor)');
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS tasks_status ON tasks(json_extract(data, '$.status'))",
        );
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS dispatches_task ON dispatches(json_extract(data, '$.taskId'))",
        );
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS dispatches_lease ON dispatches(json_extract(data,'$.executionLease.status')); CREATE INDEX IF NOT EXISTS dispatches_quarantine ON dispatches(json_extract(data,'$.quarantined')); CREATE INDEX IF NOT EXISTS dispatches_verification ON dispatches(json_extract(data,'$.verificationPending')); CREATE INDEX IF NOT EXISTS conflicts_status ON execution_conflicts(json_extract(data,'$.status'));",
        );
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS dispatches_session ON dispatches(json_extract(data, '$.sessionId'))",
        );
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS retention_records (table_name TEXT NOT NULL, id TEXT NOT NULL, changed_at INTEGER NOT NULL, terminal_at INTEGER, active INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(table_name,id));
          CREATE INDEX IF NOT EXISTS retention_age ON retention_records(table_name,terminal_at);
          CREATE TABLE IF NOT EXISTS record_refs(source_table TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL, PRIMARY KEY(source_table,source_id,target_id));
          CREATE INDEX IF NOT EXISTS refs_target ON record_refs(target_id);
          CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, cursor TEXT NOT NULL, floor TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS snapshot_items (snapshot_id TEXT NOT NULL, ordinal INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(snapshot_id,ordinal));`);
        if (
          !(
            this.db.prepare('PRAGMA table_info(retention_records)').all() as { name: string }[]
          ).some((column) => column.name === 'active')
        )
          this.db.exec(
            'ALTER TABLE retention_records ADD COLUMN active INTEGER NOT NULL DEFAULT 1',
          );
        const set = this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)');
        set.run('schemaVersion', '3');
        if (version && version !== '3')
          this.db.prepare('UPDATE metadata SET value=? WHERE key=?').run('3', 'schemaVersion');
        set.run('workspace', this.workspace);
        set.run('storeId', this.storeId);
        set.run('retentionFloorCursor', '0');
        set.run('role', 'active');
        if (meta('referenceIndexVersion') !== '1') {
          for (const table of TABLES)
            for (const row of this.db.prepare(`SELECT id,data FROM ${table}`).all() as {
              id: string;
              data: string;
            }[])
              this.track(table, row.id, JSON.parse(row.data));
          for (const row of this.db.prepare('SELECT id,data FROM operations').all() as {
            id: string;
            data: string;
          }[])
            this.track('operations', row.id, JSON.parse(row.data));
          set.run('referenceIndexVersion', '1');
        }
        if (version && version !== '3') options.fault?.('migration.before_commit');
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      chmodSync(join(this.stateDir, 'store.sqlite'), 0o600);
      for (const name of ['artifacts', 'file-commits', 'quarantine']) {
        const path = join(this.stateDir, name);
        if (existsSync(path) && (!lstatSync(path).isDirectory() || realpathSync(path) !== path))
          fail('UNTRUSTED_PATH', 'Managed file directory is not canonical');
      }
      mkdirSync(join(this.stateDir, 'artifacts'), { recursive: true, mode: 0o700 });
      mkdirSync(join(this.stateDir, 'file-commits'), { recursive: true, mode: 0o700 });
      mkdirSync(join(this.stateDir, 'quarantine'), { recursive: true, mode: 0o700 });
      this.recoverFiles();
    } catch (error) {
      database?.close();
      this.lock.close();
      throw error;
    }
  }
  transaction<T>(fn: () => T): T {
    this.assertWritable();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.storageFailure(error);
      throw error;
    }
  }
  assertWritable(): void {
    if (this.closed) fail('CLIENT_CLOSED', 'Store is closed');
    this.options.fence?.();
    if (this.metadata('role') === 'retired' || this.metadata('role') === 'archive')
      fail('STORE_RETIRED', 'Store is read-only');
    if (this.degraded) fail('STORAGE_DEGRADED', 'Storage failure requires restart and recovery');
  }
  storageFailure(error: unknown): void {
    const code = (error as { code?: string; errcode?: number }).code ?? '';
    const sqlite = (error as { errcode?: number }).errcode;
    if (
      ['ENOSPC', 'EIO', 'EROFS'].includes(code) ||
      (sqlite !== undefined && [10, 13, 14].includes(sqlite & 255))
    ) {
      this.degraded = true;
      try {
        unlinkSync(join(this.stateDir, 'emergency.reserve'));
        syncDirectory(this.stateDir);
      } catch {
        /* The original failure remains authoritative. */
      }
    }
  }
  private write<T>(fn: () => T): T {
    this.assertWritable();
    if (!this.db.isTransaction) return this.transaction(fn);
    return fn();
  }
  metadata(key: string): string | undefined {
    return (
      this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as
        | { value: string }
        | undefined
    )?.value;
  }
  setMetadata(key: string, value: string): void {
    this.write(() =>
      this.db
        .prepare(
          'INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run(key, value),
    );
  }
  private track(table: string, id: string, value: any): void {
    const settled = [
      'completed',
      'failed',
      'cancelled',
      'closed',
      'consumed',
      'expired',
      'approved',
      'rejected',
      'invalidated',
      'noop',
    ].includes(value.status);
    const terminal =
      table === 'artifacts' ||
      table === 'usage' ||
      settled ||
      (value.status === 'outcome_unknown' && value.resolution);
    const active =
      table === 'tasks'
        ? !['completed', 'failed', 'cancelled'].includes(value.status)
        : ['messages', 'outbox'].includes(table)
          ? !settled
          : table === 'dispatches'
            ? value.executionLease?.status === 'held' ||
              value.quarantined ||
              value.verificationPending
            : table === 'approvals'
              ? value.status === 'pending'
              : table === 'operations'
                ? value.status === 'persisted' ||
                  (value.status === 'outcome_unknown' && !value.resolution)
                : table === 'execution_conflicts'
                  ? value.status === 'open'
                  : table === 'storage_pins';
    this.db
      .prepare(
        `INSERT INTO retention_records(table_name,id,changed_at,terminal_at,active) VALUES (?,?,?,?,?)
      ON CONFLICT(table_name,id) DO UPDATE SET changed_at=excluded.changed_at,active=excluded.active,
      terminal_at=CASE WHEN excluded.terminal_at IS NULL THEN NULL ELSE COALESCE(retention_records.terminal_at,excluded.terminal_at) END`,
      )
      .run(table, id, this.now(), terminal ? this.now() : null, active ? 1 : 0);
    const refs = new Set<string>();
    const visit = (child: unknown, key = '') => {
      if (typeof child === 'string') {
        if (/(Id|Ids|Ref|Refs)$/.test(key) || ['id', 'ref'].includes(key)) refs.add(child);
      } else if (Array.isArray(child)) for (const item of child) visit(item, key);
      else if (child && typeof child === 'object')
        for (const [name, item] of Object.entries(child))
          if (!['raw', 'goal', 'summary', 'text', 'prompt'].includes(name)) visit(item, name);
    };
    visit(value);
    this.db.prepare('DELETE FROM record_refs WHERE source_table=? AND source_id=?').run(table, id);
    const insert = this.db.prepare('INSERT OR IGNORE INTO record_refs VALUES (?,?,?)');
    for (const ref of refs) if (ref !== id) insert.run(table, id, ref);
  }
  assertDetails(operation: OperationSnapshot): void {
    if ((operation as any).historyExpired)
      fail(
        'OPERATION_HISTORY_EXPIRED',
        'Operation detail was collected; never replay this identity',
        {
          operationId: operation.id,
          status: operation.status,
          targetId: operation.targetId,
          result: operation.result,
        },
      );
  }
  confirmFiles(): void {
    this.recoverFiles();
  }
  get isClosed(): boolean {
    return this.closed;
  }
  private recoverFiles(): void {
    for (const name of readdirSync(join(this.stateDir, 'file-commits'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const journal = join(this.stateDir, 'file-commits', name);
      const entry = JSON.parse(readFileSync(journal, 'utf8')) as {
        ref: string;
        sha256: string;
        sizeBytes: number;
      };
      if (name !== `${entry.sha256}.json` || entry.ref !== `sha256:${entry.sha256}`)
        fail('ARTIFACT_CORRUPT', 'Invalid file commit identity');
      const path = join(this.stateDir, 'artifacts', `${entry.sha256}.txt`);
      if (existsSync(path)) {
        const bytes = readFileSync(path);
        if (
          !lstatSync(path).isFile() ||
          bytes.length !== entry.sizeBytes ||
          createHash('sha256').update(bytes).digest('hex') !== entry.sha256
        )
          fail('ARTIFACT_CORRUPT', 'Interrupted artifact failed verification');
        if (!this.get('artifacts', entry.ref))
          this.put('artifacts', entry.ref, {
            id: entry.ref,
            path,
            sha256: entry.sha256,
            sizeBytes: entry.sizeBytes,
            recoveredOrphan: true,
          });
      } else if (
        this.get<any>('artifacts', entry.ref)?.historyExpired ||
        this.get<any>('gc_jobs', entry.ref)?.status === 'pending'
      ) {
        continue;
      } else if (this.get('artifacts', entry.ref))
        fail('ARTIFACT_CORRUPT', 'Committed artifact is missing');
      unlinkSync(journal);
    }
    syncDirectory(join(this.stateDir, 'file-commits'));
  }
  get<T>(table: Table, id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }
  require<T>(table: Table, id: string): T {
    const value = this.get<T>(table, id);
    if (!value) fail('NOT_FOUND', `${table} object not found`, { id });
    return value;
  }
  all<T>(table: Table): T[] {
    return (
      this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  queuedTasks(): TaskSnapshot[] {
    return this.tasksInState('queued');
  }
  tasksInState(status: string): TaskSnapshot[] {
    return (
      this.db
        .prepare("SELECT data FROM tasks WHERE json_extract(data, '$.status')=? ORDER BY rowid")
        .all(status) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  dispatchCount(taskId: string): number {
    return (
      this.db
        .prepare("SELECT count(*) AS count FROM dispatches WHERE json_extract(data, '$.taskId')=?")
        .get(taskId) as { count: number }
    ).count;
  }
  activeDispatches(sessionId?: string): Record<string, unknown>[] {
    const predicate =
      "(json_extract(data, '$.executionLease.status')='held' OR json_extract(data, '$.quarantined')=1 OR json_extract(data, '$.verificationPending')=1)";
    return (
      this.db
        .prepare(
          `SELECT data FROM dispatches WHERE ${predicate}${sessionId ? " AND json_extract(data, '$.sessionId')=?" : ''}`,
        )
        .all(...(sessionId ? [sessionId] : [])) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  put(table: Table, id: string, value: unknown): void {
    this.write(() => {
      this.db
        .prepare(
          `INSERT INTO ${table}(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
        )
        .run(id, JSON.stringify(value));
      this.track(table, id, value);
    });
  }
  remove(table: Table, id: string): void {
    this.write(() => {
      this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
      this.db.prepare('DELETE FROM retention_records WHERE table_name=? AND id=?').run(table, id);
      this.db
        .prepare('DELETE FROM record_refs WHERE source_table=? AND source_id=?')
        .run(table, id);
    });
  }
  findOperationById(id: string): any {
    const row = this.db.prepare('SELECT data FROM operations WHERE id=?').get(id) as
      | { data: string }
      | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  operation(id: string): OperationSnapshot {
    const row = this.db.prepare('SELECT data FROM operations WHERE id=?').get(id) as
      | { data: string }
      | undefined;
    if (!row) fail('NOT_FOUND', 'Operation not found', { id });
    const operation = JSON.parse(row.data);
    this.assertDetails(operation);
    return operation;
  }
  operations(): OperationSnapshot[] {
    return (this.db.prepare('SELECT data FROM operations').all() as { data: string }[]).map((row) =>
      JSON.parse(row.data),
    );
  }
  findOperation(
    method: string,
    scope: string,
    key: string,
  ): { operation: OperationSnapshot; digest: string } | undefined {
    const row = this.db
      .prepare('SELECT data,digest FROM operations WHERE method=? AND scope=? AND key=?')
      .get(method, scope, key) as { data: string; digest: string } | undefined;
    return row ? { operation: JSON.parse(row.data), digest: row.digest } : undefined;
  }
  saveOperation(operation: OperationSnapshot, digest?: string): void {
    this.write(() => {
      if (digest !== undefined)
        this.db
          .prepare('INSERT INTO operations(id,method,scope,key,digest,data) VALUES (?,?,?,?,?,?)')
          .run(
            operation.id,
            operation.method,
            operation.scope,
            operation.idempotencyKey,
            digest,
            JSON.stringify(operation),
          );
      else
        this.db
          .prepare('UPDATE operations SET data=? WHERE id=?')
          .run(JSON.stringify(operation), operation.id);
      this.track('operations', operation.id, operation);
    });
  }
  event(
    type: string,
    data: Record<string, Json>,
    refs: { taskId?: string; sessionId?: string; operationId?: string } = {},
  ): EventEnvelope {
    return this.write(() => {
      const event: EventEnvelope = {
        eventId: randomUUID(),
        cursor: '0',
        storeId: this.storeId,
        schemaVersion: 1,
        type,
        taskId: refs.taskId ?? null,
        sessionId: refs.sessionId ?? null,
        operationId: refs.operationId ?? null,
        occurredAt: new Date(this.now()).toISOString(),
        data,
      };
      const row = this.db
        .prepare('INSERT INTO events(taskId,data) VALUES (?,?)')
        .run(event.taskId, JSON.stringify(event));
      event.cursor = String(row.lastInsertRowid);
      this.db
        .prepare('UPDATE events SET data=? WHERE cursor=?')
        .run(JSON.stringify(event), row.lastInsertRowid);
      return event;
    });
  }
  events(
    after: string,
    storeId: string | undefined,
    taskId: string | undefined,
    limit: number,
  ): EventPage {
    const last = this.db.prepare('SELECT COALESCE(MAX(cursor),0) AS cursor FROM events').get() as {
      cursor: number;
    };
    if (
      (storeId !== undefined && storeId !== this.storeId) ||
      (after !== '0' && storeId === undefined) ||
      !/^\d+$/.test(after) ||
      BigInt(after) < BigInt(this.metadata('retentionFloorCursor') ?? '0') ||
      BigInt(after) >
        BigInt(Math.max(last.cursor, Number(this.metadata('retentionFloorCursor') ?? 0)))
    )
      fail('CURSOR_EXPIRED', 'Cursor must belong to this store and retained log');
    const rows = this.db
      .prepare('SELECT cursor,data FROM events WHERE cursor>? ORDER BY cursor LIMIT ?')
      .all(after, limit) as { cursor: number; data: string }[];
    const events: EventEnvelope[] = [];
    let cursor = after;
    let bytes = 0;
    for (const row of rows) {
      const event = JSON.parse(row.data) as EventEnvelope;
      if (!taskId || event.taskId === taskId) {
        const size = Buffer.byteLength(row.data, 'utf8') + 1;
        if (size > 768 * 1024)
          fail('FRAME_TOO_LARGE', 'Stored event exceeds the replay page limit');
        if (bytes + size > 768 * 1024) break;
        bytes += size;
        events.push(event);
      }
      // Advance only past scanned records, never past an event deferred to the next page.
      cursor = String(row.cursor);
    }
    return { events, cursor, storeId: this.storeId };
  }
  artifact(text: string): string {
    this.assertWritable();
    const digest = createHash('sha256').update(text).digest('hex');
    const path = join(this.stateDir, 'artifacts', `${digest}.txt`),
      ref = `sha256:${digest}`;
    const record = { id: ref, path, sha256: digest, sizeBytes: Buffer.byteLength(text) };
    const journal = join(this.stateDir, 'file-commits', `${digest}.json`);
    for (const directory of [dirname(path), dirname(journal)])
      if (realpathSync(directory) !== directory)
        fail('UNTRUSTED_PATH', 'Artifact directory changed');
    try {
      atomicFile(journal, JSON.stringify({ ref, ...record }));
      this.options.fault?.('artifact.prepared');
      if (!existsSync(path)) atomicFile(path, text);
      if (
        !lstatSync(path).isFile() ||
        realpathSync(path) !== path ||
        createHash('sha256').update(readFileSync(path)).digest('hex') !== digest
      )
        fail('ARTIFACT_CORRUPT', 'Existing artifact failed digest verification');
      this.options.fault?.('artifact.renamed');
      this.put('artifacts', ref, record);
      this.options.fault?.('artifact.registered');
      // Journal removal is deferred until recovery when the outer transaction is known committed.
      return ref;
    } catch (error) {
      this.storageFailure(error);
      throw error;
    }
  }
  artifactText(ref: string, maxBytes = 65536): string {
    const record = this.require<{
      path: string;
      sha256: string;
      sizeBytes: number;
      historyExpired?: boolean;
    }>('artifacts', ref);
    if (record.historyExpired)
      fail('ARTIFACT_HISTORY_EXPIRED', 'Artifact content was collected', { ref });
    if (record.sizeBytes > maxBytes)
      fail('ARTIFACT_TOO_LARGE', 'Artifact exceeds the requested inline limit');
    const path = join(this.stateDir, 'artifacts', `${record.sha256}.txt`);
    if (realpathSync(path) !== path)
      fail('ARTIFACT_CORRUPT', 'Artifact path must not be a symlink');
    const bytes = readFileSync(path);
    if (
      bytes.length !== record.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== record.sha256
    )
      fail('ARTIFACT_CORRUPT', 'Artifact content does not match its immutable digest');
    return bytes.toString('utf8');
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    this.lock.close();
  }
}
