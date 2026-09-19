#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createEngine } from '../../engine/src/index.ts';
import { connectOrchestrator } from '../../sdk-typescript/src/index.ts';
import { engineConfig, loadConfig } from './config.ts';
import { startStdioHost, startUnixHost } from './host.ts';

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function flags(args: string[], allowed: string[]): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!name.startsWith('--') || !allowed.includes(name.slice(2)))
      fail('INVALID_ARGUMENT', `Unknown argument: ${name}`);
    const key = name.slice(2);
    if (key in result) fail('INVALID_ARGUMENT', `Duplicate argument: ${name}`);
    if (key === 'stdio') result[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail('INVALID_ARGUMENT', `Missing value for ${name}`);
      result[key] = value;
    }
  }
  return result;
}
function required(options: Record<string, string | true>, key: string) {
  if (typeof options[key] !== 'string') fail('INVALID_ARGUMENT', `--${key} is required`);
  return options[key] as string;
}
function print(value: unknown) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  if (command === '--help' || command === 'help') {
    process.stdout.write(
      'agent-orch host --config FILE [--stdio | --socket PATH]\nagent-orch doctor --config FILE | --socket PATH\nagent-orch submit --socket PATH --task FILE [--idempotency-key KEY]\nagent-orch status --socket PATH --task TASK_ID\nagent-orch approve --socket PATH --approval ID --revision N --decision approve|deny [--idempotency-key KEY]\n',
    );
    return;
  }
  if (command === 'host') {
    const options = flags(args, ['config', 'stdio', 'socket']);
    if (options.stdio && options.socket)
      fail('INVALID_ARGUMENT', '--stdio and --socket are mutually exclusive');
    // Runtime diagnostics must never corrupt the stdio wire stream.
    console.log = console.info = console.debug = (...values: unknown[]) => console.error(...values);
    const config = await loadConfig(required(options, 'config'));
    const socketPath =
      typeof options.socket === 'string' ? options.socket : config.transport?.socketPath;
    const stdio = options.stdio === true || (!options.socket && config.transport?.mode === 'stdio');
    if (!stdio && !socketPath)
      fail('INVALID_ARGUMENT', 'Use --stdio, --socket PATH, or configure transport.socketPath');
    const engine = await createEngine(await engineConfig(config));
    try {
      if (stdio) {
        const connection = startStdioHost(engine);
        const stop = () => connection.close();
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);
        try {
          await connection.closed;
        } finally {
          process.removeListener('SIGTERM', stop);
          process.removeListener('SIGINT', stop);
        }
      } else {
        const host = await startUnixHost(engine, { socketPath: socketPath! });
        let stopping = false;
        const stop = () => {
          if (stopping) return;
          stopping = true;
          host
            .close({ mode: 'interrupt', timeoutMs: config.shutdown?.timeoutMs ?? 1000 })
            .catch((error) => {
              stopping = false;
              console.error(
                JSON.stringify({ code: error.code ?? 'SHUTDOWN_FAILED', message: error.message }),
              );
            });
        };
        process.on('SIGTERM', stop);
        process.on('SIGINT', stop);
        process.stderr.write(`agent-orch listening on ${socketPath}\n`);
        try {
          await host.closed;
        } finally {
          process.removeListener('SIGTERM', stop);
          process.removeListener('SIGINT', stop);
        }
      }
    } catch (error) {
      await engine.close({ mode: 'interrupt', timeoutMs: 1000 }).catch(() => {});
      throw error;
    }
    return;
  }
  if (!['doctor', 'status', 'submit', 'approve'].includes(command))
    fail(
      'UNSUPPORTED_COMMAND',
      `Command is not implemented in foundation 1.0: ${command ?? '(missing)'}`,
    );
  const allowed =
    command === 'doctor'
      ? ['config', 'socket']
      : command === 'status'
        ? ['socket', 'task']
        : command === 'submit'
          ? ['socket', 'task', 'idempotency-key']
          : ['socket', 'approval', 'revision', 'decision', 'idempotency-key'];
  const options = flags(args, allowed);
  if (command === 'doctor' && options.config) {
    if (options.socket) fail('INVALID_ARGUMENT', 'doctor accepts either --config or --socket');
    const config = await loadConfig(required(options, 'config'));
    print({
      ok: true,
      mode: 'configuration-only',
      workspace: config.workspace,
      stateDir: config.stateDir,
      providers: Object.keys(config.providers),
      runtimeAcceptance: 'not_run',
    });
    return;
  }
  const client = await connectOrchestrator({ socketPath: required(options, 'socket') });
  try {
    if (command === 'doctor') print({ ok: true, ...client.info, runtimeAcceptance: 'not_run' });
    else if (command === 'status') print(await client.tasks.get(required(options, 'task')));
    else if (command === 'submit') {
      const spec = JSON.parse(await readFile(required(options, 'task'), 'utf8'));
      const task = await client.tasks.create(spec, {
        idempotencyKey:
          typeof options['idempotency-key'] === 'string' ? options['idempotency-key'] : undefined,
      });
      print(task.initial);
    } else {
      const decision = required(options, 'decision');
      if (decision !== 'approve' && decision !== 'deny')
        fail('INVALID_ARGUMENT', '--decision must be approve or deny');
      const revision = Number(required(options, 'revision'));
      if (!Number.isSafeInteger(revision) || revision < 0)
        fail('INVALID_ARGUMENT', '--revision must be a non-negative integer');
      const operation = await client.approvals.decide(
        required(options, 'approval'),
        { choice: decision, expectedRevision: revision },
        {
          idempotencyKey:
            typeof options['idempotency-key'] === 'string' ? options['idempotency-key'] : undefined,
        },
      );
      print(operation.initial);
    }
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      JSON.stringify({ code: error.code ?? 'CLI_ERROR', message: error.message }) + '\n',
    );
    process.exitCode = 1;
  });
}
