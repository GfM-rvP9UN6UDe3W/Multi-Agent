// Preload for a socket host child (SPEC-0023 S01). Right after the host writes its ready line, the
// process stalls for STALL_MS, as a loaded runner can deschedule it, so a signal sent as soon as
// the line is read arrives before the host runs again. The line is written synchronously, so the
// reader sees it before the stall on every platform.
import { writeSync } from 'node:fs';

const STALL_MS = 300;
const pause = new Int32Array(new SharedArrayBuffer(4));
const write = process.stderr.write;
process.stderr.write = function (this: typeof process.stderr, chunk: unknown, ...rest: unknown[]) {
  if (typeof chunk !== 'string' || !chunk.startsWith('orchvia listening on '))
    return Reflect.apply(write, this, [chunk, ...rest]) as boolean;
  writeSync(2, chunk);
  Atomics.wait(pause, 0, 0, STALL_MS);
  return true;
} as typeof process.stderr.write;
