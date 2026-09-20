import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { ClaudeQueryFactory } from '../../packages/adapter-claude/src/index.ts';

export const interruptChild = fileURLToPath(
  new URL('./claude-interrupt-child.ts', import.meta.url),
);
export function offlineInterruptQuery(mode = 'confirm', audit = ''): ClaudeQueryFactory {
  return (request) => {
    const child = request.options.spawnClaudeCodeProcess({
      command: process.execPath,
      args: [interruptChild, mode, request.options.resume ?? '', audit],
      env: {},
      cwd: request.options.cwd,
      signal: request.options.abortController.signal,
    });
    const lines = createInterface({ input: child.stdout });
    const write = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
    const receipts = new Map<string, () => void>();
    let sequence = 0;
    const pump = (async () => {
      for await (const message of request.prompt) write(message);
    })();
    void pump.catch(() => {});
    return {
      async *[Symbol.asyncIterator]() {
        for await (const line of lines) {
          const value = JSON.parse(line);
          if (value.type === 'control_response') {
            receipts.get(value.response.request_id)?.();
            receipts.delete(value.response.request_id);
          } else yield value;
        }
      },
      interrupt() {
        const id = String(++sequence);
        return new Promise<void>((resolve) => {
          receipts.set(id, resolve);
          write({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } });
        });
      },
      close() {
        child.stdin.end();
        lines.close();
      },
    };
  };
}
