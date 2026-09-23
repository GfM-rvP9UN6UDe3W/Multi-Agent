// Preload for a CLI host child. Once the host receives SIGTERM, every durable sync point takes
// SYNC_MS, as on a loaded CI disk: each fs.fsyncSync, each SQLite COMMIT and each database close,
// which checkpoints the WAL. What is written, and in which order, does not change.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const SYNC_MS = 250;
const pause = new Int32Array(new SharedArrayBuffer(4));
let slow = false;
const sync = () => {
  if (slow) Atomics.wait(pause, 0, 0, SYNC_MS);
};
process.prependListener('SIGTERM', () => {
  slow = true;
});

const fsync = fs.fsyncSync;
Object.assign(fs, {
  fsyncSync(fd: number) {
    fsync(fd);
    sync();
  },
});
syncBuiltinESMExports();
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
  exec.call(this, sql);
  if (/^\s*COMMIT\b/i.test(sql)) sync();
};
const close = DatabaseSync.prototype.close;
DatabaseSync.prototype.close = function (this: DatabaseSync) {
  close.call(this);
  sync();
};
