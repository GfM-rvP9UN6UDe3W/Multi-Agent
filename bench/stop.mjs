// SPEC-0021 E04: the host's proof that one writable Claude dispatch stopped. The engine releases
// the dispatch's execution lease only after this proof (docs/guide.md, observeExecutionStop).
//
// The two tracks of the orchvia arm share one workspace, so "nothing runs in the workspace" is no
// proof: the other track's Claude process legitimately does. Instead:
// 1. this dispatch's own Claude process has exited, as the adapter reports; then
// 2. every process that still uses the workspace descends from this harness: the other track's
//    live Claude process, or a check the harness started. A process that outlived its parent was
//    reparented away from the harness, and while it runs no dispatch can prove its stop.
// Errors and timeouts never prove a stop.
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Process ids with a file or their working directory under `directory`. With +D, lsof exits with 1
 * when some file under the directory is open in no process, even if it lists others; only that
 * exit without a message is read as a result.
 */
async function processesUsing(directory) {
  try {
    const { stdout } = await run('lsof', ['-Fp', '+D', directory], { timeout: 10_000 });
    return parseIds(stdout);
  } catch (error) {
    if (error.code === 1 && !String(error.stderr ?? '').trim())
      return parseIds(String(error.stdout ?? ''));
    throw error;
  }
}

const parseIds = (stdout) =>
  stdout
    .split('\n')
    .filter((line) => line.startsWith('p'))
    .map((line) => Number(line.slice(1)));

/** The parent of every running process. */
async function parents() {
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 10_000 });
  const map = new Map();
  for (const line of stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) map.set(pid, ppid);
  }
  return map;
}

/** True when `pid` is `ancestor` or descends from it; a process that already exited counts too. */
function descendsFrom(pid, ancestor, parentOf) {
  if (!parentOf.has(pid)) return true;
  for (let current = pid, depth = 0; current > 1 && depth < 64; depth++) {
    if (current === ancestor) return true;
    current = parentOf.get(current);
  }
  return false;
}

export async function executionStopped({
  adapter,
  workspace,
  target,
  signal,
  harness = process.pid,
}) {
  try {
    while (adapter.hasActiveResources(target.sessionId)) {
      if (signal.aborted) return false;
      await sleep(50, undefined, { signal });
    }
    const using = await processesUsing(workspace);
    if (using.length === 0) return true;
    const parentOf = await parents();
    return !signal.aborted && using.every((pid) => descendsFrom(pid, harness, parentOf));
  } catch {
    return false;
  }
}
