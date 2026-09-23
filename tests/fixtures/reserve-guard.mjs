// SPEC-0011 R10: a test engine uses a 4 KiB emergency reserve, not the 256 MiB production default.
// `npm test` and `npm run test:python` load this module. It adds itself to NODE_OPTIONS, so the CLI
// hosts, fixtures and examples that tests start load it too. A process fails before it writes more
// than 4 KiB to emergency.reserve. The runnable examples keep the production default, because their
// tests run them as a reader does.
import fs from 'node:fs';
import { basename, sep } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const LIMIT = 4096;
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

if (!entry.startsWith(examples)) {
  const { openSync, writeSync, closeSync } = fs;
  const reserves = new Map();
  fs.openSync = function (path, ...rest) {
    const fd = openSync.call(this, path, ...rest);
    if (basename(String(path)) === 'emergency.reserve')
      reserves.set(fd, { path: String(path), bytes: 0 });
    return fd;
  };
  fs.writeSync = function (fd, data, ...rest) {
    const reserve = reserves.get(fd);
    if (!reserve) return writeSync.call(this, fd, data, ...rest);
    const length =
      typeof data === 'string'
        ? Buffer.byteLength(data)
        : typeof rest[1] === 'number'
          ? rest[1]
          : data.byteLength;
    if (reserve.bytes + length > LIMIT) {
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
    const written = writeSync.call(this, fd, data, ...rest);
    reserve.bytes += written;
    return written;
  };
  fs.closeSync = function (fd) {
    reserves.delete(fd);
    return closeSync.call(this, fd);
  };
  syncBuiltinESMExports();
}
