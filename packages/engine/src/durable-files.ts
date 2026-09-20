import {
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  renameSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fail } from './errors.ts';

export function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function atomicFile(path: string, content: string | Buffer): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  syncDirectory(dirname(path));
}
export function fileDigest(path: string): string {
  if (!lstatSync(path).isFile()) fail('ARCHIVE_CORRUPT', 'Expected a regular file');
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
export function regularFiles(
  root: string,
  prefix = '',
): { path: string; relative: string; size: number }[] {
  const result: { path: string; relative: string; size: number }[] = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name),
      relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
      fail('UNTRUSTED_PATH', 'Managed storage cannot contain symlinks', { relative });
    if (stat.isDirectory()) result.push(...regularFiles(path, relative));
    else if (stat.isFile()) result.push({ path, relative, size: stat.size });
    else fail('UNTRUSTED_PATH', 'Managed storage contains a non-regular file', { relative });
  }
  return result;
}
