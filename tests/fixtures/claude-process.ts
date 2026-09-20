import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
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
  return { child, ready: once(child.stdout, 'data').then(() => {}) };
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
