import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  existsSync,
  lstatSync,
  realpathSync,
  readFileSync,
  copyFileSync,
  chmodSync,
  unlinkSync,
  statfsSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { atomicFile, fileDigest, regularFiles, syncDirectory } from './durable-files.ts';
import type { Store } from './store.ts';
import { fail } from './errors.ts';

export interface ArchiveManifest {
  version: 1;
  storeId: string;
  schemaVersion: string;
  operationId: string;
  createdAt: string;
  files: { path: string; sha256: string; sizeBytes: number }[];
}
function safePath(root: string, path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    path.includes('\\')
  )
    fail('ARCHIVE_CORRUPT', 'Archive manifest contains an invalid relative file');
  const full = join(root, path),
    rel = relative(root, full);
  if (
    rel.startsWith('..' + sep) ||
    rel === '..' ||
    realpathSync(dirname(full)) !== dirname(full) ||
    !lstatSync(full).isFile()
  )
    fail('ARCHIVE_CORRUPT', 'Archive file escapes its managed directory');
  return full;
}
export function verifyArchive(
  path: string,
  expected: { storeId: string; manifestDigest?: string },
  full = false,
): ArchiveManifest {
  let rootAccessible = false;
  try {
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path)
      fail('ARCHIVE_CORRUPT', 'Archive directory is not canonical');
    rootAccessible = true;
    const manifestPath = join(path, 'archive.json');
    if (expected.manifestDigest && fileDigest(manifestPath) !== expected.manifestDigest)
      fail('ARCHIVE_CORRUPT', 'Archive manifest digest changed');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ArchiveManifest;
    if (
      manifest.version !== 1 ||
      manifest.storeId !== expected.storeId ||
      !Array.isArray(manifest.files)
    )
      fail('ARCHIVE_CORRUPT', 'Archive identity does not match registration');
    const seen = new Set<string>();
    for (const file of manifest.files) {
      if (seen.has(file.path)) fail('ARCHIVE_CORRUPT', 'Duplicate archive file');
      seen.add(file.path);
      const filePath = safePath(path, file.path);
      if (
        (full || file.path === 'store.sqlite') &&
        (lstatSync(filePath).size !== file.sizeBytes || fileDigest(filePath) !== file.sha256)
      )
        fail('ARCHIVE_CORRUPT', 'Archive file digest changed', { file: file.path });
    }
    if (!seen.has('store.sqlite')) fail('ARCHIVE_CORRUPT', 'Archive database is missing');
    const db = new DatabaseSync(join(path, 'store.sqlite'), { readOnly: true });
    try {
      const check = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      const meta = db.prepare('SELECT value FROM metadata WHERE key=?');
      if (
        check.integrity_check !== 'ok' ||
        (meta.get('storeId') as any)?.value !== expected.storeId ||
        (meta.get('schemaVersion') as any)?.value !== manifest.schemaVersion ||
        (meta.get('role') as any)?.value !== 'archive'
      )
        fail('ARCHIVE_CORRUPT', 'Archive database identity or integrity failed');
      if (full) {
        for (const row of db.prepare('SELECT data FROM artifacts').all() as { data: string }[]) {
          const artifact = JSON.parse(row.data);
          if (artifact.historyExpired) continue;
          const file = manifest.files.find(
            (file) => file.path === `artifacts/${artifact.sha256}.txt`,
          );
          if (!file || file.sha256 !== artifact.sha256 || file.sizeBytes !== artifact.sizeBytes)
            fail('ARCHIVE_CORRUPT', 'Retained artifact is missing from archive');
        }
      }
    } finally {
      db.close();
    }
    return manifest;
  } catch (error) {
    if ((error as any).code === 'ARCHIVE_CORRUPT') throw error;
    if ((error as any).code === 'ENOENT' && rootAccessible)
      fail('ARCHIVE_CORRUPT', 'Registered archive is missing a required component');
    if (['ENOENT', 'EACCES', 'EPERM'].includes((error as any).code))
      fail('ARCHIVE_UNAVAILABLE', 'Registered archive is inaccessible');
    fail('ARCHIVE_CORRUPT', 'Archive verification failed');
  }
}
export function createArchive(store: Store, staging: string, operationId: string): ArchiveManifest {
  store.assertWritable();
  if (store.db.isTransaction)
    fail('ARCHIVE_UNAVAILABLE', 'Archive requires a settled database view');
  store.confirmFiles();
  if (!existsSync(staging)) {
    mkdirSync(staging, { mode: 0o700 });
    atomicFile(
      join(staging, 'staging.json'),
      JSON.stringify({ operationId, storeId: store.storeId }),
    );
  }
  const marker = JSON.parse(readFileSync(join(staging, 'staging.json'), 'utf8'));
  if (
    marker.operationId !== operationId ||
    marker.storeId !== store.storeId ||
    realpathSync(staging) !== staging
  )
    fail('ARCHIVE_CORRUPT', 'Staging directory belongs to another operation');
  if (existsSync(join(staging, 'archive.json')))
    return verifyArchive(staging, { storeId: store.storeId }, true);
  const files = ['artifacts', 'runtime'].flatMap((directory) =>
    existsSync(join(store.stateDir, directory))
      ? regularFiles(join(store.stateDir, directory), directory)
      : [],
  );
  const bytes =
    files.reduce((sum, file) => sum + file.size, 0) +
    lstatSync(join(store.stateDir, 'store.sqlite')).size +
    (existsSync(join(store.stateDir, 'store.sqlite-wal'))
      ? lstatSync(join(store.stateDir, 'store.sqlite-wal')).size
      : 0);
  const free = statfsSync(dirname(staging));
  if (free.bavail * free.bsize < bytes * 1.2 + 16 * 1024 ** 2)
    fail('ARCHIVE_CAPACITY', 'Insufficient free space for a complete verified archive');
  const databasePath = join(staging, 'store.sqlite');
  if (existsSync(databasePath)) unlinkSync(databasePath); // Only this operation's unpublished staging database.
  store.db.prepare('VACUUM INTO ?').run(databasePath);
  chmodSync(databasePath, 0o600);
  const copy = new DatabaseSync(databasePath);
  try {
    copy.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    copy
      .prepare(
        "INSERT INTO metadata(key,value) VALUES ('role','archive') ON CONFLICT(key) DO UPDATE SET value='archive'",
      )
      .run();
  } finally {
    copy.close();
  }
  for (const file of files) {
    const target = join(staging, file.relative);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(file.path, target);
    chmodSync(target, 0o600);
    // fsync through atomic replacement so an archive never advertises only page-cache durability.
    atomicFile(target, readFileSync(target));
  }
  const manifest: ArchiveManifest = {
    version: 1,
    storeId: store.storeId,
    schemaVersion: store.metadata('schemaVersion')!,
    operationId,
    createdAt: new Date(store.now()).toISOString(),
    files: [
      {
        path: 'store.sqlite',
        sha256: fileDigest(databasePath),
        sizeBytes: lstatSync(databasePath).size,
      },
      ...files.map((file) => ({
        path: file.relative,
        sha256: fileDigest(join(staging, file.relative)),
        sizeBytes: file.size,
      })),
    ],
  };
  atomicFile(join(staging, 'archive.json'), JSON.stringify(manifest));
  syncDirectory(staging);
  return verifyArchive(staging, { storeId: store.storeId }, true);
}
export function archiveArtifact(
  path: string,
  manifest: ArchiveManifest,
  ref: string,
  maxBytes: number,
): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(ref)) fail('VALIDATION_ERROR', 'Invalid artifact reference');
  const registered = manifest.files.find((file) => file.path === `artifacts/${ref.slice(7)}.txt`);
  if (!registered)
    fail('ARTIFACT_HISTORY_EXPIRED', 'Artifact body is not retained in this archive');
  if (registered.sizeBytes > maxBytes)
    fail('ARTIFACT_TOO_LARGE', 'Archived artifact exceeds inline limit');
  const file = safePath(path, registered.path);
  if (fileDigest(file) !== registered.sha256 || registered.sha256 !== ref.slice(7))
    fail('ARCHIVE_CORRUPT', 'Archive artifact digest changed');
  return readFileSync(file, 'utf8');
}

export function completeMigrationBackup(
  backupPath: string,
  stateDir: string,
  storeId: string,
  schemaVersion: string,
): string {
  const bundle = `${backupPath}.bundle`;
  mkdirSync(bundle, { mode: 0o700 });
  const databasePath = join(bundle, 'store.sqlite');
  copyFileSync(backupPath, databasePath);
  chmodSync(databasePath, 0o600);
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    db.prepare(
      "INSERT INTO metadata(key,value) VALUES ('role','archive') ON CONFLICT(key) DO UPDATE SET value='archive'",
    ).run();
  } finally {
    db.close();
  }
  const files = ['artifacts', 'runtime'].flatMap((directory) =>
    existsSync(join(stateDir, directory)) ? regularFiles(join(stateDir, directory), directory) : [],
  );
  for (const file of files) {
    const target = join(bundle, file.relative);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    atomicFile(target, readFileSync(file.path));
  }
  const manifest: ArchiveManifest = {
    version: 1,
    storeId,
    schemaVersion,
    operationId: `schema-migration:${schemaVersion}`,
    createdAt: new Date().toISOString(),
    files: [
      {
        path: 'store.sqlite',
        sha256: fileDigest(databasePath),
        sizeBytes: lstatSync(databasePath).size,
      },
      ...files.map((file) => ({
        path: file.relative,
        sha256: fileDigest(join(bundle, file.relative)),
        sizeBytes: file.size,
      })),
    ],
  };
  atomicFile(join(bundle, 'archive.json'), JSON.stringify(manifest));
  verifyArchive(bundle, { storeId }, true);
  return bundle;
}
