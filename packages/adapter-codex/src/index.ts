import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import type {
  ExecutionEvidence,
  Json,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeInput,
  RuntimeTerminalEvent,
} from '../../engine/src/types.ts';

type Message = Record<string, unknown>;
function record(value: unknown): Message | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Message)
    : null;
}
function nonnegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class MessageQueue {
  static readonly limit = 256;
  private values: (Message | null)[] = [];
  private waiting: {
    resolve: (value: Message | null) => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
  } | null = null;
  private ended = false;
  push(value: Message | null): boolean {
    if (this.ended) return true;
    if (value === null) this.ended = true;
    if (this.waiting) {
      const { resolve, timer } = this.waiting;
      this.waiting = null;
      if (timer) clearTimeout(timer);
      resolve(value);
    } else if (value !== null) {
      if (this.values.length >= MessageQueue.limit) return false;
      this.values.push(value);
    }
    return true;
  }
  async next(remainingMs: () => number): Promise<Message | null> {
    if (this.values.length > 0) return this.values.shift() ?? null;
    if (this.ended) return null;
    return new Promise((resolve, reject) => {
      const waiting: NonNullable<MessageQueue['waiting']> = { resolve, reject };
      const check = () => {
        if (this.waiting !== waiting) return;
        try {
          const remaining = remainingMs();
          if (remaining <= 0) throw new Error('Codex app-server response timed out');
          waiting.timer = setTimeout(check, Math.max(1, remaining));
        } catch (error) {
          this.waiting = null;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      this.waiting = waiting;
      check();
    });
  }
}

class AppServerConnection {
  private child: ChildProcessWithoutNullStreams;
  private queue = new MessageQueue();
  private deferred: Message[] = [];
  private nextId = 0;
  private protocolError: string | null = null;
  private exited: Promise<void>;
  private exitConfirmed = false;
  private shutdownRequested = false;
  private closing: Promise<boolean> | null = null;
  private remainingRequestMs: () => number;
  private closeTimeoutMs: number;
  constructor(
    child: ChildProcessWithoutNullStreams,
    timeouts: { remainingRequestMs: () => number; closeTimeoutMs: number },
    onExit: () => void,
  ) {
    this.child = child;
    this.remainingRequestMs = timeouts.remainingRequestMs;
    this.closeTimeoutMs = timeouts.closeTimeoutMs;
    this.exited = new Promise((resolve) => {
      const confirmExit = () => {
        this.exitConfirmed = true;
        resolve();
        onExit();
      };
      child.once('exit', confirmExit);
      child.once('error', () => {
        if (child.pid === undefined) confirmExit();
      });
    });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let lineEnd: number;
      while ((lineEnd = buffer.indexOf('\n')) >= 0) {
        if (lineEnd > 1_048_576) {
          this.protocolError = 'Codex app-server frame exceeds 1 MiB';
          child.kill();
          return;
        }
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line) continue;
        try {
          const message = record(JSON.parse(line));
          if (!message) throw new Error('non-object message');
          if (!this.queue.push(message)) {
            this.protocolError = 'Codex app-server queue limit exceeded';
            this.queue.push(null);
            child.kill();
            return;
          }
        } catch {
          this.protocolError = 'Codex app-server emitted invalid JSON';
          child.kill();
          return;
        }
      }
      if (buffer.length > 1_048_576) {
        this.protocolError = 'Codex app-server frame exceeds 1 MiB';
        child.kill();
      }
    });
    child.stderr.resume();
    child.stdin.on('error', (error) => {
      this.protocolError = error.message;
      this.queue.push(null);
    });
    child.on('error', (error) => {
      this.protocolError = error.message;
      this.queue.push(null);
    });
    child.on('close', () => this.queue.push(null));
  }
  send(method: string, params?: Message): number {
    if (this.shutdownRequested || this.exitConfirmed)
      throw new Error('Codex app-server connection is closed');
    const id = ++this.nextId;
    this.child.stdin.write(JSON.stringify({ method, id, ...(params ? { params } : {}) }) + '\n');
    return id;
  }
  notify(method: string, params: Message = {}): void {
    if (this.shutdownRequested || this.exitConfirmed)
      throw new Error('Codex app-server connection is closed');
    this.child.stdin.write(JSON.stringify({ method, params }) + '\n');
  }
  async request(method: string, params?: Message, onSent?: () => void): Promise<Message> {
    if (this.remainingRequestMs() <= 0) throw new Error('Codex app-server response timed out');
    const id = this.send(method, params);
    onSent?.();
    while (true) {
      const remaining = this.remainingRequestMs();
      if (remaining <= 0) throw new Error('Codex app-server response timed out');
      const message = await this.queue.next(this.remainingRequestMs);
      if (!message) throw new Error(this.protocolError ?? 'Codex app-server disconnected');
      if (message.id !== id) {
        if (this.deferred.length >= MessageQueue.limit)
          throw new Error('Codex app-server queue limit exceeded');
        this.deferred.push(message);
        continue;
      }
      if (message.error) {
        const failure = record(message.error);
        throw new Error(
          typeof failure?.message === 'string' ? failure.message : `${method} failed`,
        );
      }
      const result = record(message.result);
      if (!result) throw new Error(`${method} returned invalid result`);
      return result;
    }
  }
  async next(remainingTurnMs: () => number): Promise<Message | null> {
    const remaining = remainingTurnMs();
    if (remaining <= 0) throw new Error('Codex app-server turn terminal timed out');
    return this.deferred.shift() ?? (await this.queue.next(remainingTurnMs));
  }
  failure(): string | null {
    return this.protocolError;
  }
  hasActiveResources(): boolean {
    return !this.exitConfirmed;
  }
  close(): Promise<boolean> {
    if (this.exitConfirmed) return Promise.resolve(true);
    if (this.closing) return this.closing;
    this.shutdownRequested = true;
    this.deferred = [];
    this.queue.push(null);
    const closing = this.stop();
    this.closing = closing;
    void closing.then(
      () => {
        if (this.closing === closing) this.closing = null;
      },
      () => {
        if (this.closing === closing) this.closing = null;
      },
    );
    return this.closing;
  }
  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exitConfirmed) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
  private async stop(): Promise<boolean> {
    this.child.stdin.end();
    if (await this.waitForExit(0)) return true;
    this.child.kill('SIGTERM');
    if (await this.waitForExit(this.closeTimeoutMs)) return true;
    this.child.kill('SIGKILL');
    return this.waitForExit(this.closeTimeoutMs);
  }
}

export interface CodexAdapterConfig {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  closeTimeoutMs?: number;
}

function timeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function managedHome(stateDir: string): string {
  if (!isAbsolute(stateDir)) throw new Error('Codex stateDir must be absolute');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const state = realpathSync(stateDir);
  const home = join(state, 'runtime', 'codex');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const actual = realpathSync(home);
  if (!actual.startsWith(state + sep)) throw new Error('Codex managed home escapes stateDir');
  chmodSync(home, 0o700);
  const configPath = join(actual, 'config.toml');
  const config =
    'mcp_servers = {}\n[agents]\nenabled = false\n[features]\nmulti_agent = false\nmulti_agent_v2 = false\napps = false\nplugins = false\nremote_plugin = false\nbrowser_use = false\ncomputer_use = false\nimage_generation = false\nhooks = false\n';
  try {
    writeFileSync(configPath, config, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!lstatSync(configPath).isFile() || readFileSync(configPath, 'utf8') !== config) {
      throw new Error('Codex managed config differs from expected read-only profile');
    }
  }
  return actual;
}

function isolatedEnv(configured?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const supplied = configured ?? {};
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    ...supplied,
  };
}

function defensiveArgs(args: string[], workspace: string): string[] {
  const untrustedProjects: string[] = [];
  for (let path = workspace; ; path = dirname(path)) {
    untrustedProjects.push('-c', `projects.${JSON.stringify(path)}.trust_level="untrusted"`);
    if (dirname(path) === path) break;
  }
  return [
    ...args,
    '--disable',
    'multi_agent',
    '--disable',
    'multi_agent_v2',
    '--disable',
    'apps',
    '--disable',
    'plugins',
    '--disable',
    'remote_plugin',
    '--disable',
    'browser_use',
    '--disable',
    'browser_use_external',
    '--disable',
    'browser_use_full_cdp_access',
    '--disable',
    'computer_use',
    '--disable',
    'image_generation',
    '--disable',
    'hooks',
    '-c',
    'agents.enabled=false',
    '-c',
    'mcp_servers={}',
    '-c',
    'project_root_markers=[]',
    ...untrustedProjects,
  ];
}

export function createCodexAdapter(config: CodexAdapterConfig = {}): RuntimeAdapter {
  const acceptanceCapMs = timeout(config.requestTimeoutMs, 0) || null;
  const turnCapMs = timeout(config.turnTimeoutMs, 0) || null;
  const owned = new Map<string, Set<AppServerConnection>>();
  let stopping = false;
  const prune = (sessionId: string) => {
    const connections = owned.get(sessionId);
    if (!connections) return false;
    for (const connection of connections) {
      if (!connection.hasActiveResources()) connections.delete(connection);
    }
    if (!connections.size) owned.delete(sessionId);
    return connections.size > 0;
  };
  return {
    provider: 'codex',
    capabilities: () => ({
      provider: 'codex',
      resume: true,
      interrupt: true,
      permissionProfiles: ['read-only'],
      fork: false,
      compact: false,
      toolBridge: false,
      executionBudget: { version: 2, acceptanceCapMs, turnCapMs },
      executionEvidence: { version: 1, terminalCoversExecution: true },
    }),
    hasActiveResources: (sessionId) => prune(sessionId),
    async close() {
      stopping = true;
      const results = await Promise.allSettled(
        [...owned.values()].flatMap((connections) =>
          [...connections].map((connection) => connection.close()),
        ),
      );
      for (const sessionId of owned.keys()) prune(sessionId);
      if (owned.size || results.some((result) => result.status === 'rejected')) {
        throw Object.assign(new Error('Codex owned app-server resources have not all exited'), {
          code: 'SHUTDOWN_INCOMPLETE',
        });
      }
    },
    async *execute(input: RuntimeInput): AsyncIterable<RuntimeEvent> {
      const started = performance.now();
      const budget = input.executionBudget;
      const reporter = input.reportExecutionEvidence;
      let sequence = 0;
      let turnSent = false;
      let threadId = input.providerSessionId;
      let turnId: string | null = null;
      let observedTerminal: RuntimeTerminalEvent | undefined;
      const report = (
        source: ExecutionEvidence['source'],
        localResources: ExecutionEvidence['localResources'],
        detail: string,
        terminal = observedTerminal,
      ) => {
        if (!reporter) return;
        const evidence: ExecutionEvidence = {
          version: 1,
          sequence: ++sequence,
          dispatchId: input.dispatchId,
          sessionId: input.sessionId,
          generation: input.generation ?? 1,
          provider: 'codex',
          providerSessionId: threadId,
          providerTurnId: turnId,
          source,
          observedAt: new Date().toISOString(),
          localResources,
          remoteExecution: !turnSent || observedTerminal ? 'stopped' : 'unknown',
          detail,
          ...(terminal ? { terminal } : {}),
        };
        try {
          reporter(evidence);
        } catch (error) {
          process.emitWarning(`Codex execution evidence callback failed: ${errorMessage(error)}`);
        }
      };
      const remaining = (value: number) => {
        if (!Number.isFinite(value)) throw new Error('Codex execution budget must be finite');
        return value;
      };
      const remainingTurnMs = () =>
        remaining(
          budget
            ? budget.remainingTurnMs()
            : (turnCapMs ?? 1800000) - (performance.now() - started),
        );
      const remainingAcceptanceMs = () =>
        Math.min(
          remainingTurnMs(),
          remaining(
            budget
              ? budget.remainingAcceptanceMs()
              : (acceptanceCapMs ?? 30000) - (performance.now() - started),
          ),
        );
      const preSubmission = (event: RuntimeTerminalEvent) => {
        report(
          'pre_submission',
          'stopped',
          'No business turn was submitted and no local resources were acquired',
          event,
        );
        return event;
      };
      if (stopping) {
        yield preSubmission({
          type: 'error',
          message: 'Codex adapter is closing',
          outcome: 'failed',
        });
        return;
      }
      if (input.permissionProfile !== 'read-only') {
        yield preSubmission({
          type: 'error',
          message: 'Codex adapter supports read-only only',
          outcome: 'failed',
        });
        return;
      }
      if (input.signal.aborted) {
        yield preSubmission({ type: 'interrupted' });
        return;
      }
      if (budget && budget.policyVersion !== 2) {
        yield preSubmission({
          type: 'error',
          message: 'Codex execution budget policy is unsupported',
          outcome: 'failed',
        });
        return;
      }
      let home: string;
      let workspace: string;
      let child: ChildProcessWithoutNullStreams;
      try {
        if (remainingAcceptanceMs() <= 0)
          throw new Error('Codex execution budget expired before startup');
        home = managedHome(input.stateDir);
        workspace = realpathSync(input.workspace);
        child = spawn(
          config.command ?? 'codex',
          defensiveArgs(config.args ?? ['app-server'], workspace),
          {
            cwd: workspace,
            env: { ...isolatedEnv(config.env), CODEX_HOME: home, CODEX_SQLITE_HOME: home },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
      } catch (error) {
        yield preSubmission({ type: 'error', message: errorMessage(error), outcome: 'failed' });
        return;
      }
      const connection = new AppServerConnection(
        child,
        {
          remainingRequestMs: remainingAcceptanceMs,
          closeTimeoutMs: timeout(config.closeTimeoutMs, 1_000),
        },
        () =>
          report(
            turnSent ? 'resource_observation' : 'pre_submission',
            'stopped',
            turnSent
              ? 'The owned app-server child exited; remote stopping requires a matching terminal'
              : 'The owned app-server child exited before any business turn was submitted',
          ),
      );
      const connections = owned.get(input.sessionId) ?? new Set<AppServerConnection>();
      connections.add(connection);
      owned.set(input.sessionId, connections);
      let terminal = false;
      let interruptSent = false;
      let answer = '';
      let sawUsage = false;
      const seenUsage = new Set<string>();
      const requestInterrupt = (): void => {
        if (!input.signal.aborted || !threadId || !turnId || interruptSent) return;
        interruptSent = true;
        try {
          connection.send('turn/interrupt', { threadId, turnId });
        } catch {
          /* disconnect is reported as unknown below */
        }
      };
      input.signal.addEventListener('abort', requestInterrupt);
      try {
        await connection.request('initialize', {
          clientInfo: { name: 'agent_orch', title: 'Agent Orchestration', version: '0.1.0' },
        });
        connection.notify('initialized');
        const thread = await connection.request(
          input.providerSessionId ? 'thread/resume' : 'thread/start',
          {
            ...(input.providerSessionId ? { threadId: input.providerSessionId } : {}),
            model: input.model,
            cwd: input.workspace,
            sandbox: 'read-only',
            approvalPolicy: 'never',
          },
        );
        threadId =
          typeof record(thread.thread)?.id === 'string'
            ? (record(thread.thread)!.id as string)
            : null;
        if (!threadId) throw new Error('Codex thread response lacks id');
        if (input.signal.aborted) {
          yield { type: 'interrupted' };
          return;
        }
        const turn = await connection.request(
          'turn/start',
          {
            threadId,
            input: [{ type: 'text', text: input.prompt }],
            cwd: input.workspace,
            approvalPolicy: 'never',
            sandboxPolicy: { type: 'readOnly', networkAccess: false },
          },
          () => {
            turnSent = true;
          },
        );
        turnId =
          typeof record(turn.turn)?.id === 'string' ? (record(turn.turn)!.id as string) : null;
        if (!turnId) throw new Error('Codex turn response lacks id');
        yield { type: 'accepted', providerSessionId: threadId };
        requestInterrupt();
        while (true) {
          const message = await connection.next(remainingTurnMs);
          if (!message)
            throw new Error(
              connection.failure() ?? 'Codex app-server disconnected before turn completion',
            );
          const params = record(message.params);
          if (!params || params.threadId !== threadId) continue;
          if (params.turnId && params.turnId !== turnId) continue;
          if (message.method === 'item/completed') {
            const item = record(params.item);
            if (item?.type === 'agentMessage' && typeof item.text === 'string') answer = item.text;
          } else if (message.method === 'thread/tokenUsage/updated') {
            const tokenUsage = record(params.tokenUsage);
            const last = record(tokenUsage?.last);
            const total = record(tokenUsage?.total);
            if (!last) continue;
            const signature = total ? JSON.stringify(total) : JSON.stringify(last);
            if (seenUsage.has(signature)) continue;
            seenUsage.add(signature);
            sawUsage = true;
            const totalCount = nonnegativeInt(total?.totalTokens);
            yield {
              type: 'usage',
              usageId: `${turnId}:total:${totalCount ?? 'unknown'}:${seenUsage.size}`,
              usage: {
                inputTokens: nonnegativeInt(last.inputTokens),
                cachedInputTokens: nonnegativeInt(last.cachedInputTokens),
                cacheWriteInputTokens: nonnegativeInt(last.cacheWriteInputTokens),
                outputTokens: nonnegativeInt(last.outputTokens),
                raw: last as Json,
              },
            };
          } else if (message.method === 'turn/completed') {
            const completed = record(params.turn);
            if (completed?.id !== turnId) continue;
            terminal = true;
            if (completed.status === 'interrupted') observedTerminal = { type: 'interrupted' };
            else if (completed.status === 'failed')
              observedTerminal = {
                type: 'error',
                message:
                  typeof record(completed.error)?.message === 'string'
                    ? (record(completed.error)!.message as string)
                    : 'Codex turn failed',
                outcome: 'failed',
              };
            else if (completed.status === 'completed')
              observedTerminal = {
                type: 'result',
                text: answer,
                providerSessionId: threadId,
              };
            if (observedTerminal)
              report(
                'runtime_terminal',
                connection.hasActiveResources() ? 'unknown' : 'stopped',
                'Matching native thread and turn terminal covers this read-only execution',
              );
            if (!(await connection.close())) {
              yield {
                type: 'error',
                message: 'Codex app-server process did not exit after SIGKILL',
                outcome: 'unknown',
              };
              return;
            }
            if (remainingTurnMs() <= 0) {
              yield {
                type: 'error',
                message: 'Codex app-server turn terminal timed out',
                outcome: 'unknown',
              };
            } else if (observedTerminal?.type === 'result') {
              if (!sawUsage)
                yield {
                  type: 'usage',
                  usageId: `${turnId}:missing`,
                  usage: {
                    inputTokens: null,
                    cachedInputTokens: null,
                    cacheWriteInputTokens: null,
                    outputTokens: null,
                    raw: null,
                  },
                };
              yield observedTerminal;
            } else if (observedTerminal) {
              yield observedTerminal;
            } else {
              yield {
                type: 'error',
                message: 'Codex turn ended with invalid status',
                outcome: 'unknown',
              };
            }
            return;
          }
        }
      } catch (error) {
        if (!terminal) {
          const exited = await connection.close();
          if (!exited)
            report(
              turnSent ? 'resource_observation' : 'pre_submission',
              'unknown',
              'Owned app-server cleanup has not confirmed process exit',
            );
          yield {
            type: 'error',
            message: exited
              ? errorMessage(error)
              : 'Codex app-server process did not exit after SIGKILL',
            outcome: turnSent || !exited ? 'unknown' : 'failed',
          };
        }
      } finally {
        input.signal.removeEventListener('abort', requestInterrupt);
        await connection.close();
        prune(input.sessionId);
      }
    },
  };
}
