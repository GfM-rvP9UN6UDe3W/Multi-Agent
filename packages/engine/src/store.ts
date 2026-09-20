import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, chmodSync, writeFileSync, existsSync } from 'node:fs';
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
] as const;
type Table = (typeof TABLES)[number];

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

export class Store {
  readonly db: DatabaseSync;
  readonly lock: DatabaseSync;
  readonly storeId: string;
  readonly workspace: string;
  readonly stateDir: string;
  private closed = false;

  constructor(workspace: string, stateDir: string) {
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
      if (version && version !== '1' && version !== '2')
        fail('SCHEMA_MISMATCH', `Unsupported store schema ${version}`);
      const previousWorkspace = meta('workspace');
      if (previousWorkspace && previousWorkspace !== this.workspace)
        fail('WORKSPACE_MISMATCH', 'State belongs to a different workspace');
      this.storeId = meta('storeId') ?? randomUUID();
      if (version === '1') {
        const backup = join(this.stateDir, `store-schema1-${randomUUID()}.sqlite`);
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
            (saved.get('schemaVersion') as { value: string }).value !== '1' ||
            (saved.get('storeId') as { value: string }).value !== this.storeId ||
            (saved.get('workspace') as { value: string }).value !== this.workspace
          )
            fail('SCHEMA_MIGRATION_FAILED', 'Schema 1 recovery backup validation failed');
        } finally {
          verified.close();
        }
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
        const set = this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)');
        set.run('schemaVersion', '2');
        if (version === '1')
          this.db.prepare('UPDATE metadata SET value=? WHERE key=?').run('2', 'schemaVersion');
        set.run('workspace', this.workspace);
        set.run('storeId', this.storeId);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      chmodSync(join(this.stateDir, 'store.sqlite'), 0o600);
      mkdirSync(join(this.stateDir, 'artifacts'), { recursive: true, mode: 0o700 });
    } catch (error) {
      database?.close();
      this.lock.close();
      throw error;
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
    return (
      this.db
        .prepare(
          "SELECT data FROM tasks WHERE json_extract(data, '$.status')='queued' ORDER BY rowid",
        )
        .all() as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  dispatchCount(taskId: string): number {
    return (
      this.db
        .prepare("SELECT count(*) AS count FROM dispatches WHERE json_extract(data, '$.taskId')=?")
        .get(taskId) as { count: number }
    ).count;
  }
  put(table: Table, id: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO ${table}(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(id, JSON.stringify(value));
  }
  remove(table: Table, id: string): void {
    this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
  }
  operation(id: string): OperationSnapshot {
    const row = this.db.prepare('SELECT data FROM operations WHERE id=?').get(id) as
      | { data: string }
      | undefined;
    if (!row) fail('NOT_FOUND', 'Operation not found', { id });
    return JSON.parse(row.data);
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
  }
  event(
    type: string,
    data: Record<string, Json>,
    refs: { taskId?: string; sessionId?: string; operationId?: string } = {},
  ): EventEnvelope {
    const event: EventEnvelope = {
      eventId: randomUUID(),
      cursor: '0',
      storeId: this.storeId,
      schemaVersion: 1,
      type,
      taskId: refs.taskId ?? null,
      sessionId: refs.sessionId ?? null,
      operationId: refs.operationId ?? null,
      occurredAt: new Date().toISOString(),
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
      BigInt(after) > BigInt(last.cursor)
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
    const digest = createHash('sha256').update(text).digest('hex');
    const path = join(this.stateDir, 'artifacts', `${digest}.txt`);
    if (!existsSync(path)) writeFileSync(path, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const ref = `sha256:${digest}`;
    this.put('artifacts', ref, {
      id: ref,
      path,
      sha256: digest,
      sizeBytes: Buffer.byteLength(text),
    });
    return ref;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    this.lock.close();
  }
}
