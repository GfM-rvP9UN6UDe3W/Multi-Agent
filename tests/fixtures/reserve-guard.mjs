// SPEC-0011 R10: a test engine uses a 4 KiB emergency reserve, not the 256 MiB production default.
// `npm test` and `npm run test:python` load this module. It adds itself to NODE_OPTIONS, so the CLI
// hosts, fixtures and examples that tests start load it too. A process fails before it writes more
// than 4 KiB to emergency.reserve, or to emergency.reserve.partial, under which the engine writes
// the reserve before renaming it (SPEC-0028 W02). Writes through file descriptors and through
// fs.promises file handles both count (SPEC-0028 W03). The runnable examples keep the production
// default, because their tests run them as a reader does.
import fs from 'node:fs';
import { basename, sep } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const LIMIT = 4096;
const NAMES = new Set(['emergency.reserve', 'emergency.reserve.partial']);
const self = fileURLToPath(import.meta.url);
if (!(process.env.NODE_OPTIONS ?? '').includes(self))
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import ${JSON.stringify(self)}`]
    .filter(Boolean)
    .join(' ');

const real = (path) => {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
};
const examples = real(fileURLToPath(new URL('../../examples', import.meta.url))) + sep;
const entry = process.argv[1] ? real(process.argv[1]) : '';

/** The length of one write, as fs.writeSync and FileHandle.write take their arguments. */
function length(data, rest) {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (typeof rest[1] === 'number') return rest[1];
  if (rest[0] && typeof rest[0] === 'object' && typeof rest[0].length === 'number')
    return rest[0].length;
  return data.byteLength;
}
/** Fails before a write makes a reserve grow past LIMIT. */
function count(reserve, bytes) {
  if (reserve.bytes + bytes <= LIMIT) return;
  const command = process.argv.slice(1).join(' ') || '(no script)';
  throw Object.assign(
    new Error(
      `${reserve.path} would grow past ${LIMIT} bytes in \`node ${command}\`. Test engines ` +
        'use storage: { emergencyBytes: 4096 }; in a CLI configuration, ' +
        '"storage": {"emergencyBytes": 4096} (SPEC-0011 R10, tests/fixtures/reserve-guard.mjs).',
    ),
    { code: 'TEST_RESERVE_GUARD' },
  );
}
const size = (data) => (typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength);

if (!entry.startsWith(examples)) {
  const { openSync, writeSync, closeSync } = fs;
  const reserves = new Map();
  fs.openSync = function (path, ...rest) {
    const fd = openSync.call(this, path, ...rest);
    if (NAMES.has(basename(String(path)))) reserves.set(fd, { path: String(path), bytes: 0 });
    return fd;
  };
  fs.writeSync = function (fd, data, ...rest) {
    const reserve = reserves.get(fd);
    if (!reserve) return writeSync.call(this, fd, data, ...rest);
    count(reserve, length(data, rest));
    const written = writeSync.call(this, fd, data, ...rest);
    reserve.bytes += written;
    return written;
  };
  fs.closeSync = function (fd) {
    reserves.delete(fd);
    return closeSync.call(this, fd);
  };
  const { open } = fs.promises;
  fs.promises.open = async function (path, ...rest) {
    const handle = await open.call(this, path, ...rest);
    if (!NAMES.has(basename(String(path)))) return handle;
    const reserve = { path: String(path), bytes: 0 };
    const { write, writev, writeFile, appendFile } = handle;
    handle.write = async function (data, ...args) {
      count(reserve, length(data, args));
      const result = await write.call(this, data, ...args);
      reserve.bytes += result.bytesWritten;
      return result;
    };
    handle.writev = async function (buffers, ...args) {
      count(
        reserve,
        buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0),
      );
      const result = await writev.call(this, buffers, ...args);
      reserve.bytes += result.bytesWritten;
      return result;
    };
    for (const [name, original] of [
      ['writeFile', writeFile],
      ['appendFile', appendFile],
    ])
      handle[name] = async function (data, ...args) {
        count(reserve, size(data));
        await original.call(this, data, ...args);
        reserve.bytes += size(data);
      };
    return handle;
  };
  syncBuiltinESMExports();
}
