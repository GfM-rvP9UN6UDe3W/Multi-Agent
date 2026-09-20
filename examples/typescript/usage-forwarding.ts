// Offline ledger/outbox example. The destination must support the same idempotency key.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createFakeAdapter } from '../../packages/engine/src/index.ts';
import { createOrchestrator } from '../../packages/sdk-typescript/src/index.ts';

const root = await realpath(await mkdtemp(join(tmpdir(), 'usage-forward-')));
const workspace = join(root, 'workspace');
await mkdir(workspace);
const fake = createFakeAdapter();
const client = await createOrchestrator({
  workspace,
  stateDir: join(root, 'engine'),
  adapters: [
    {
      ...fake,
      async *execute(input) {
        yield {
          type: 'usage',
          usageId: 'fixture',
          usage: {
            inputTokens: 7,
            cachedInputTokens: null,
            cacheWriteInputTokens: null,
            outputTokens: 2,
            raw: { source: 'offline-fixture' },
          },
        };
        yield* fake.execute(input);
      },
    },
  ],
});
function openOutbox() {
  const db = new DatabaseSync(join(root, 'host-outbox.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS outbox (
      storeId TEXT NOT NULL, recordId TEXT NOT NULL, payload TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (storeId, recordId));
    CREATE TABLE IF NOT EXISTS checkpoint (storeId TEXT PRIMARY KEY, cursor TEXT NOT NULL);`);
  return db;
}
let outbox = openOutbox();
let destination = new DatabaseSync(join(root, 'fixture-ledger.sqlite'));
destination.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
  CREATE TABLE ledger (storeId TEXT NOT NULL, recordId TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (storeId, recordId));`);
let deliveryAttempts = 0;

async function ingest(replay = false) {
  const storeId = client.info.storeId;
  const checkpoint = outbox
    .prepare('SELECT cursor FROM checkpoint WHERE storeId=?')
    .get(storeId) as { cursor: string } | undefined;
  const page = await client.events.read({
    storeId,
    afterCursor: replay ? '0' : (checkpoint?.cursor ?? '0'),
    limit: 256,
  });
  assert.equal(page.storeId, storeId);
  const records = [];
  for (const event of page.events)
    if (event.type === 'usage.recorded')
      records.push(await client.usage.getRecord(event.data.usageRecordId as string));
  outbox.exec('BEGIN IMMEDIATE');
  try {
    for (const record of records) {
      const payload = JSON.stringify(record);
      const prior = outbox
        .prepare('SELECT payload FROM outbox WHERE storeId=? AND recordId=?')
        .get(storeId, record.id) as { payload: string } | undefined;
      if (prior)
        assert.equal(prior.payload, payload, 'Conflicting usage identity requires investigation');
      else
        outbox
          .prepare('INSERT INTO outbox(storeId,recordId,payload) VALUES (?,?,?)')
          .run(storeId, record.id, payload);
    }
    // The records become durable in the SAME transaction as the advanced checkpoint.
    const cursor =
      checkpoint && BigInt(checkpoint.cursor) > BigInt(page.cursor)
        ? checkpoint.cursor
        : page.cursor;
    outbox.prepare('INSERT OR REPLACE INTO checkpoint VALUES (?,?)').run(storeId, cursor);
    outbox.exec('COMMIT');
  } catch (error) {
    outbox.exec('ROLLBACK');
    throw error;
  }
}

async function deliver(loseAcknowledgment = false) {
  const rows = outbox.prepare('SELECT * FROM outbox WHERE sent=0').all() as {
    storeId: string;
    recordId: string;
    payload: string;
  }[];
  for (const row of rows) {
    deliveryAttempts++;
    // Replace this fixture transaction with a host ledger API accepting (storeId, recordId).
    // A timeout is ambiguous: retry the SAME identity, never count it again as a new call.
    const prior = destination
      .prepare('SELECT payload FROM ledger WHERE storeId=? AND recordId=?')
      .get(row.storeId, row.recordId) as { payload: string } | undefined;
    if (prior) assert.equal(prior.payload, row.payload);
    else
      destination
        .prepare('INSERT INTO ledger VALUES (?,?,?)')
        .run(row.storeId, row.recordId, row.payload);
    if (loseAcknowledgment)
      throw new Error('Fixture: ledger committed but acknowledgment was lost');
    outbox
      .prepare('UPDATE outbox SET sent=1 WHERE storeId=? AND recordId=?')
      .run(row.storeId, row.recordId);
  }
}

try {
  const task = await client.tasks.create(
    {
      goal: 'Observe one offline usage record',
      runtime: { provider: 'fake', model: 'offline' },
      acceptance: { mode: 'human', criteria: ['Review fixture'] },
    },
    { idempotencyKey: 'fixture-task' },
  );
  for await (const event of client.events({ taskId: task.id, signal: AbortSignal.timeout(2000) })) {
    if (event.type === 'approval.requested') break;
  }
  await ingest();
  await assert.rejects(deliver(true), /acknowledgment was lost/);
  outbox.close();
  destination.close();
  outbox = openOutbox();
  destination = new DatabaseSync(join(root, 'fixture-ledger.sqlite'));
  await ingest(); // Resume the committed checkpoint after reopening the host's database.
  await ingest(true); // Deliberately replay the older cursor as well.
  await deliver();
  const records = destination.prepare('SELECT payload FROM ledger').all() as { payload: string }[];
  const inputTokens = records.reduce((sum, row) => sum + JSON.parse(row.payload).inputTokens, 0);
  console.log(
    JSON.stringify({
      runtime: 'fake',
      replayed: true,
      deliveryAttempts,
      ledgerRows: records.length,
      inputTokens,
    }),
  );
} finally {
  outbox.close();
  destination.close();
  await client.close({ mode: 'drain', timeoutMs: 2000 });
  await rm(root, { recursive: true, force: true });
}
