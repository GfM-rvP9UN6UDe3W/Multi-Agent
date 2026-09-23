import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  ClaudeQueryFactory,
  ClaudeQueryRequest,
} from '../../packages/adapter-claude/src/index.ts';

// Real, offline child: only stdin EOF or an explicit test-owned signal stops it.
export function claudeProcess(request: ClaudeQueryRequest): ChildProcessWithoutNullStreams {
  const options = {
    command: process.execPath,
    args: ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'],
    cwd: request.options.cwd,
    env: {},
    signal: new AbortController().signal,
  };
  return request.options.spawnClaudeCodeProcess(options);
}

// Installs its handlers before ready resolves, so a cleanup signal cannot win the startup race.
export function stubbornClaudeProcess(request: ClaudeQueryRequest): {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
} {
  const child = request.options.spawnClaudeCodeProcess({
    command: process.execPath,
    args: [
      '-e',
      'process.on("SIGTERM", () => {}); process.stdin.resume(); setInterval(() => {}, 1000); process.stdout.write("ready\\n");',
    ],
    cwd: request.options.cwd,
    env: {},
    signal: new AbortController().signal,
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish(new Error('Offline Claude child readiness timed out after 5000 ms'));
      try {
        child.kill('SIGKILL');
      } catch {
        // The rejected readiness promise already reports the bounded failure.
      }
    }, 5000);
    const onData = () => finish();
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        new Error(`Offline Claude child exited before readiness (code ${code}, signal ${signal})`),
      );
    function finish(error?: Error) {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    }
    child.stdout.once('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  return { child, ready };
}

export function withClaudeProcess(
  factory: ClaudeQueryFactory,
  holdUntil?: Promise<void>,
): ClaudeQueryFactory {
  return (request) => {
    const held = holdUntil ? stubbornClaudeProcess(request) : undefined;
    const child = held?.child ?? claudeProcess(request);
    const stop = () => {
      if (held) child.kill('SIGKILL');
      else child.stdin.end();
    };
    try {
      const query = factory(request);
      return {
        ...(query.interrupt ? { interrupt: query.interrupt.bind(query) } : {}),
        [Symbol.asyncIterator]() {
          const iterator = query[Symbol.asyncIterator]();
          return {
            async next() {
              await held?.ready;
              return iterator.next();
            },
            return: iterator.return?.bind(iterator),
            throw: iterator.throw?.bind(iterator),
          };
        },
        close() {
          try {
            return query.close?.();
          } finally {
            if (holdUntil) void holdUntil.then(stop);
            else stop();
          }
        },
      };
    } catch (error) {
      stop();
      throw error;
    }
  };
}

/**
 * A forced cleanup kills the Claude process's group (SPEC-0023 P04). A test that needs a process to
 * outlive its cleanup makes every group signal fail with EPERM until the test ends, as when
 * permissions forbid the signal.
 */
export function refuseGroupSignals(t: { after(fn: () => void): void }): void {
  const signal = process.kill;
  process.kill = ((pid: number, sig?: string | number) => {
    if (pid < 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    return signal.call(process, pid, sig);
  }) as typeof process.kill;
  t.after(() => {
    process.kill = signal;
  });
}
