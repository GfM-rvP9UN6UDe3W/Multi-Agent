import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fail } from './errors.ts';
import { digest, fields, integer, object, string, strings } from './validation.ts';
import type { FrozenVerificationRule, VerificationRule } from './types.ts';

export function contains(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

export function workspacePath(workspace: string, path: string): string {
  const canonical = realpathSync(resolve(workspace, path));
  if (!contains(realpathSync(workspace), canonical))
    fail('INVALID_WORKSPACE_SCOPE', 'Path leaves the registered workspace');
  return canonical;
}

export function normalizeRules(
  workspace: string,
  input: VerificationRule[] = [],
): FrozenVerificationRule[] {
  if (!Array.isArray(input) || input.length > 100)
    fail('VALIDATION_ERROR', 'At most 100 verification rules may be registered');
  const seen = new Set<string>();
  return input.map((value) => {
    const rule = object(value, 'verificationRule');
    fields(rule, [
      'id',
      'version',
      'argv',
      'cwdRelative',
      'timeoutMs',
      'permissionProfile',
      'success',
      'maxOutputBytes',
      'baselinePaths',
    ]);
    const success = object(rule.success, 'success');
    fields(success, ['exitCode']);
    const cwdRelative = string(rule.cwdRelative, 'cwdRelative', 4096);
    if (isAbsolute(cwdRelative)) fail('VALIDATION_ERROR', 'cwdRelative must be relative');
    workspacePath(workspace, cwdRelative);
    const argv = strings(rule.argv, 'argv', 1, 100);
    if (!isAbsolute(argv[0]))
      fail('VALIDATION_ERROR', 'Verification executable must be an absolute path');
    if (!['read-only', 'workspace-write'].includes(rule.permissionProfile as string))
      fail('VALIDATION_ERROR', 'Invalid verification permissionProfile');
    const normalized: VerificationRule = {
      id: string(rule.id, 'rule.id', 128),
      version: string(rule.version, 'rule.version', 128),
      argv,
      cwdRelative,
      timeoutMs: integer(rule.timeoutMs, 'timeoutMs', 1, 3600000),
      permissionProfile: rule.permissionProfile as VerificationRule['permissionProfile'],
      success: { exitCode: integer(success.exitCode, 'exitCode', 0, 255) },
      maxOutputBytes: integer(rule.maxOutputBytes ?? 65536, 'maxOutputBytes', 1, 262144),
      baselinePaths:
        rule.baselinePaths === undefined
          ? [cwdRelative]
          : strings(rule.baselinePaths, 'baselinePaths', 1),
    };
    for (const path of normalized.baselinePaths!) workspacePath(workspace, path);
    const key = ruleKey(normalized.id, normalized.version);
    if (seen.has(key)) fail('VALIDATION_ERROR', 'Duplicate verification rule id/version');
    seen.add(key);
    return { ...normalized, digest: digest(normalized) };
  });
}

/** Unambiguous key of a rule version; `id` and `version` may both contain `@` (SPEC-0014 W05). */
export function ruleKey(id: string, version: string): string {
  return JSON.stringify([id, version]);
}

/**
 * Configured rules plus a store's registered rules (SPEC-0014 W03–W05). Identity comes from each
 * row's content, so rows written under rc.8's `id@version` keys load unchanged. A registered rule
 * whose identity is already effective with other content fails with VALIDATION_ERROR.
 */
export function effectiveRules(
  workspace: string,
  configured: VerificationRule[] | undefined,
  stored: unknown[],
): { rules: FrozenVerificationRule[]; runtime: Set<string> } {
  const rules = normalizeRules(workspace, configured);
  const runtime = new Set<string>();
  for (const row of stored) {
    const { digest: _digest, ...value } = row as FrozenVerificationRule;
    const [rule] = normalizeRules(workspace, [value]);
    const key = ruleKey(rule.id, rule.version);
    const existing = rules.find((r) => r.id === rule.id && r.version === rule.version);
    if (existing) {
      if (existing.digest !== rule.digest)
        fail('VALIDATION_ERROR', `Verification rule ${key} has conflicting definitions`);
      continue;
    }
    rules.push(rule);
    runtime.add(key);
  }
  return { rules, runtime };
}

/** A bounded content baseline. Excludes Git internals; source/untracked files remain included. */
export function workspaceBaseline(workspace: string, paths: string[]): string {
  const hash = createHash('sha256');
  const seen = new Set<string>();
  let bytes = 0;
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    if (seen.size > 20000)
      fail(
        'BASELINE_LIMIT',
        'Verification baseline exceeds 20000 entries; register narrower baselinePaths',
      );
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = workspacePath(workspace, path);
      hash.update(`link:${relative(workspace, path)}:${target}\n`);
      visit(target);
    } else if (stat.isDirectory()) {
      hash.update(`directory:${relative(workspace, path)}\n`);
      for (const child of readdirSync(path).sort()) {
        if (child !== '.git') visit(resolve(path, child));
      }
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 64 * 1024 * 1024)
        fail(
          'BASELINE_LIMIT',
          'Verification baseline exceeds 64 MiB; register narrower baselinePaths',
        );
      hash.update(`file:${relative(workspace, path)}:${stat.mode}:`);
      hash.update(readFileSync(path));
    } else fail('INVALID_WORKSPACE_SCOPE', 'Verification baseline contains a special file');
  };
  for (const path of [...paths].sort()) visit(workspacePath(workspace, path));
  return hash.digest('hex');
}

export interface VerificationEvidence {
  ruleId: string;
  ruleVersion: string;
  ruleDigest: string;
  argv: string[];
  cwd: string;
  before: string | null;
  after: string | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  output: string;
  outputTruncated: boolean;
  passed: boolean;
  resourcesStopped: boolean;
  error?: string;
}

export async function verifyRule(
  workspace: string,
  rule: FrozenVerificationRule,
  signal: AbortSignal,
): Promise<VerificationEvidence> {
  const result: VerificationEvidence = {
    ruleId: rule.id,
    ruleVersion: rule.version,
    ruleDigest: rule.digest,
    argv: rule.argv,
    cwd: '',
    before: null,
    after: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    output: '',
    outputTruncated: false,
    passed: false,
    resourcesStopped: true,
  };
  try {
    const { digest: frozen, ...normalized } = rule;
    if (digest(normalized) !== frozen)
      fail('VERIFICATION_RULE_CHANGED', 'Frozen rule digest does not match');
    result.cwd = workspacePath(workspace, rule.cwdRelative);
    result.before = workspaceBaseline(workspace, rule.baselinePaths!);
    if (signal.aborted) return { ...result, error: 'Verification cancelled before submission' };
    await new Promise<void>((resolveDone) => {
      const child = spawn(rule.argv[0], rule.argv.slice(1), {
        cwd: result.cwd,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      result.resourcesStopped = false;
      const chunks: Buffer[] = [];
      let finished = false;
      let cleanup: ReturnType<typeof setTimeout> | undefined;
      let length = 0;
      const consume = (chunk: Buffer) => {
        const remaining = Math.max(0, rule.maxOutputBytes! - length);
        if (chunk.length > remaining) result.outputTruncated = true;
        if (remaining) {
          chunks.push(chunk.subarray(0, remaining));
          length += Math.min(chunk.length, remaining);
        }
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      const finish = (stopped: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (cleanup) clearTimeout(cleanup);
        signal.removeEventListener('abort', kill);
        result.resourcesStopped = stopped;
        if (!stopped)
          result.error = 'Verification cleanup is unconfirmed; owner reconciliation is required';
        result.output = Buffer.concat(chunks).toString('utf8');
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        resolveDone();
      };
      const kill = () => {
        cleanup ??= setTimeout(() => finish(false), 500);
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* The owned process may already have exited. */
        }
      };
      const timeout = setTimeout(() => {
        result.timedOut = true;
        kill();
      }, rule.timeoutMs);
      signal.addEventListener('abort', kill, { once: true });
      if (signal.aborted) kill();
      child.once('error', (error) => {
        result.error = error.message;
      });
      child.once('close', (code, exitSignal) => {
        result.exitCode = code;
        result.signal = exitSignal;
        // A closed pipe alone does not prove that members of the owned process group stopped.
        const groupAlive = () => {
          if (process.platform === 'win32' || !child.pid) return false;
          try {
            process.kill(-child.pid, 0);
            return true;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code !== 'ESRCH';
          }
        };
        if (!groupAlive()) {
          finish(true);
          return;
        }
        kill();
        const poll = () => {
          if (finished) return;
          if (!groupAlive()) finish(true);
          else setTimeout(poll, 10);
        };
        poll();
      });
    });
    result.after = workspaceBaseline(workspace, rule.baselinePaths!);
    result.passed =
      result.resourcesStopped &&
      !result.error &&
      !signal.aborted &&
      !result.timedOut &&
      result.signal === null &&
      result.exitCode === rule.success.exitCode &&
      result.before === result.after;
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Verification failed';
  }
  return result;
}
