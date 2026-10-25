import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { AccountConnection, UsageWindow } from '../src/shared/types';
import { APP_VERSION } from '../src/shared/version';

type Json = Record<string, unknown>;
function object(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}
function label(value: unknown): string | null {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) || null
    : null;
}
function seconds(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 8.64e12
    ? new Date(value * 1000).toISOString()
    : null;
}
export interface AccountQuota {
  windows: UsageWindow[];
  plan: string | null;
  resetCredits?: { count: number; expiresAt: string | null }[];
  resetCreditCount?: number;
  observedAt: string;
}
export interface AccountSnapshot {
  connection: AccountConnection;
  quota?: AccountQuota;
}
export class AccountQueryError extends Error {
  constructor(
    readonly kind: 'missing-cli' | 'signed-out' | 'unsupported' | 'timeout' | 'unavailable',
  ) {
    super(kind);
  }
}
export function resolveCodexHome(configuredPath = '', environment = process.env): string {
  const path = resolve(configuredPath || environment.CODEX_HOME || join(homedir(), '.codex'));
  return ['sessions', 'archived_sessions'].includes(basename(path).toLowerCase())
    ? dirname(path)
    : path;
}
export async function findCodexExecutable(environment = process.env): Promise<string> {
  const candidates =
    process.platform === 'win32' && environment.LOCALAPPDATA
      ? [join(environment.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')]
      : [];
  for (const entry of (environment.PATH ?? '').split(delimiter)) {
    if (entry && isAbsolute(entry))
      candidates.push(join(entry, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  }
  if (process.platform !== 'win32') candidates.push(join(homedir(), '.local', 'bin', 'codex'));
  for (const path of [...new Set(candidates)]) {
    try {
      await access(path);
      if ((await stat(path)).isFile()) return path;
    } catch {
      /* Try another installed CLI location. */
    }
  }
  throw new AccountQueryError('missing-cli');
}
export function normalizeAccountQuota(value: unknown, observedAt: string): AccountQuota {
  const response = object(value);
  if (!response) throw new AccountQueryError('unavailable');
  const byId = object(response.rateLimitsByLimitId);
  const entries =
    byId && Object.keys(byId).length ? Object.values(byId).slice(0, 16) : [response.rateLimits];
  const windows: UsageWindow[] = [];
  let plan: string | null = null;
  for (const entry of entries) {
    const bucket = object(entry);
    if (!bucket) continue;
    plan ??= label(bucket.planType);
    const scope =
      label(bucket.limitName) || (bucket.limitId === 'codex' ? null : label(bucket.limitId));
    for (const key of ['primary', 'secondary']) {
      const raw = object(bucket[key]);
      if (!raw || typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent))
        continue;
      const duration =
        typeof raw.windowDurationMins === 'number' &&
        Number.isFinite(raw.windowDurationMins) &&
        raw.windowDurationMins > 0
          ? raw.windowDurationMins
          : null;
      const name =
        duration === 10080
          ? 'Weekly'
          : duration === 1440
            ? 'Daily'
            : duration && duration % 60 === 0
              ? `${duration / 60} hour`
              : duration
                ? `${duration} minute`
                : key === 'primary'
                  ? 'Primary'
                  : 'Secondary';
      windows.push({
        label: scope ? `${scope} · ${name}` : name,
        usedPercent: Math.min(100, Math.max(0, raw.usedPercent)),
        windowMinutes: duration,
        resetsAt: seconds(raw.resetsAt),
        observedAt,
      });
    }
  }
  if (!entries.some((entry) => object(entry))) throw new AccountQueryError('unavailable');
  const quota: AccountQuota = { windows: windows.slice(0, 16), plan, observedAt };
  const credits = object(response.rateLimitResetCredits);
  if (
    credits &&
    typeof credits.availableCount === 'number' &&
    Number.isSafeInteger(credits.availableCount) &&
    credits.availableCount >= 0
  ) {
    quota.resetCreditCount = credits.availableCount;
    quota.resetCredits = [];
    if (Array.isArray(credits.credits))
      for (const entry of credits.credits.slice(0, credits.availableCount)) {
        const credit = object(entry);
        if (credit?.status === 'available')
          quota.resetCredits.push({ count: 1, expiresAt: seconds(credit.expiresAt) });
      }
    const unknown = credits.availableCount - quota.resetCredits.length;
    if (unknown > 0) quota.resetCredits.push({ count: unknown, expiresAt: null });
  }
  return quota;
}

interface QueryOptions {
  home: string;
  signal?: AbortSignal;
  executable?: string;
  prefixArgs?: string[];
  timeoutMs?: number;
}
export interface QueryResult {
  identity: string;
  quota: AccountQuota;
}
/** The only outgoing RPCs are initialize, initialized, account/read(false), and rateLimits/read.
 * Codex owns credentials and their normal renewal. This app never reads token files, signs out,
 * starts login, forces a refresh, starts a model turn, or redeems reset credits. */
export async function queryCodexAccount(options: QueryOptions): Promise<QueryResult> {
  const executable = options.executable ?? (await findCodexExecutable());
  if (options.signal?.aborted) throw new AccountQueryError('unavailable');
  return new Promise((resolveQuery, reject) => {
    const child = spawn(
      executable,
      [
        ...(options.prefixArgs ?? []),
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        'analytics.enabled=false',
      ],
      {
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CODEX_HOME: options.home },
        cwd: homedir(),
      },
    );
    let buffer = '';
    let totalBytes = 0;
    let account: Json | null = null;
    let settled = false;
    let stage = 1;
    const finish = (error?: AccountQueryError, result?: QueryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      child.stdin.destroy();
      child.kill();
      if (error) reject(error);
      else resolveQuery(result!);
    };
    const abort = () => finish(new AccountQueryError('unavailable'));
    const timer = setTimeout(
      () => finish(new AccountQueryError('timeout')),
      options.timeoutMs ?? 15_000,
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    const send = (message: Json) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.on('error', () => finish(new AccountQueryError('unavailable')));
    child.on('error', () => finish(new AccountQueryError('missing-cli')));
    child.on('exit', () => {
      if (!settled) finish(new AccountQueryError('unavailable'));
    });
    // Drain diagnostics but never expose subprocess stderr, which can contain local account data.
    child.stderr.on('data', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > 1024 * 1024) {
        finish(new AccountQueryError('unavailable'));
        return;
      }
      buffer += chunk;
      let end: number;
      while (!settled && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: Json | null;
        try {
          message = object(JSON.parse(line));
        } catch {
          continue;
        }
        if (!message) continue;
        if (typeof message.method === 'string') {
          if ('id' in message)
            send({
              id: message.id,
              error: { code: -32601, message: 'This client supports usage reads only.' },
            });
          continue;
        }
        if (message.id !== stage) continue;
        const error = object(message.error);
        if (error) {
          const description = typeof error.message === 'string' ? error.message : '';
          const kind =
            /unauthori[sz]ed|not (?:logged|signed) in|authentication required|sign in again|refresh token.*(?:expired|revoked|reuse)/i.test(
              description,
            )
              ? 'signed-out'
              : error.code === -32601
                ? 'unsupported'
                : 'unavailable';
          finish(new AccountQueryError(kind));
          return;
        }
        if (stage === 1) {
          stage = 2;
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/read', params: { refreshToken: false } });
        } else if (stage === 2) {
          account = object(object(message.result)?.account);
          if (!account) {
            finish(new AccountQueryError('signed-out'));
            return;
          }
          if (
            !['chatgpt', 'chatgptAuthTokens', 'agentIdentity', 'personalAccessToken'].includes(
              String(account.type),
            )
          ) {
            finish(new AccountQueryError('unsupported'));
            return;
          }
          stage = 3;
          send({ id: 3, method: 'account/rateLimits/read' });
        } else if (stage === 3) {
          try {
            const quota = normalizeAccountQuota(message.result, new Date().toISOString());
            quota.plan ??= label(account?.planType);
            const result = object(message.result);
            const identity = createHash('sha256')
              .update(String(result?.accountId ?? account?.email ?? account?.type))
              .digest('hex');
            finish(undefined, { identity, quota });
          } catch {
            finish(new AccountQueryError('unavailable'));
          }
        }
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'codex_dashboard', title: 'Codex Dashboard', version: APP_VERSION },
      },
    });
  });
}

export function createCodexAccountClient(
  options: {
    query?: typeof queryCodexAccount;
    now?: () => number;
    intervalMs?: number;
  } = {},
) {
  const query = options.query ?? queryCodexAccount;
  const now = options.now ?? Date.now;
  let context = '';
  let snapshot: AccountSnapshot | undefined;
  let nextAttempt = 0;
  let failures = 0;
  let pending: Promise<AccountSnapshot> | undefined;
  let controller: AbortController | undefined;
  let disposed = false;
  return {
    async read(configuredPath = '', force = false): Promise<AccountSnapshot> {
      const home = resolveCodexHome(configuredPath);
      if (pending) {
        await pending;
        if (home !== context) return this.read(configuredPath, force);
        return structuredClone(snapshot!);
      }
      if (disposed) throw new AccountQueryError('unavailable');
      if (context !== home) {
        context = home;
        snapshot = undefined;
        failures = 0;
        nextAttempt = 0;
      }
      if (!force && snapshot && now() < nextAttempt) return structuredClone(snapshot);
      controller = new AbortController();
      pending = (async () => {
        const checkedAt = new Date(now()).toISOString();
        try {
          const result = await query({ home, signal: controller!.signal });
          failures = 0;
          nextAttempt = now() + (options.intervalMs ?? 120_000);
          snapshot = {
            quota: result.quota,
            connection: {
              status: 'connected',
              checkedAt,
              lastSuccessAt: result.quota.observedAt,
              fromCache: false,
              message: 'Connected through your existing Codex sign-in. Codex manages your session.',
            },
          };
        } catch (error) {
          failures++;
          nextAttempt = now() + Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4));
          const kind = error instanceof AccountQueryError ? error.kind : 'unavailable';
          const previous = kind === 'signed-out' ? undefined : snapshot?.quota;
          const message =
            kind === 'missing-cli'
              ? 'Codex CLI was not found. Install or update the official Codex app, then retry.'
              : kind === 'signed-out'
                ? 'Codex reports that sign-in is required. Sign in in Codex, then retry here.'
                : kind === 'unsupported'
                  ? 'This Codex sign-in or CLI version does not support account usage. Update Codex and use a ChatGPT sign-in.'
                  : previous
                    ? 'Account check temporarily failed. Showing the last successful reading; retrying automatically.'
                    : 'Account usage is temporarily unavailable. Your Codex sign-in has not been cleared; retrying automatically.';
          snapshot = {
            quota: previous,
            connection: {
              status: kind === 'signed-out' ? 'signed-out' : previous ? 'retrying' : 'unavailable',
              checkedAt,
              lastSuccessAt: previous?.observedAt ?? null,
              fromCache: !!previous,
              message,
            },
          };
        }
        return structuredClone(snapshot!);
      })();
      try {
        return await pending;
      } finally {
        pending = undefined;
        controller = undefined;
      }
    },
    dispose() {
      disposed = true;
      controller?.abort();
    },
  };
}

export function applyAccountSnapshot(
  provider: import('../src/shared/types').ProviderSnapshot,
  account: AccountSnapshot,
) {
  provider.connection = account.connection;
  if (account.quota) {
    provider.source = 'account';
    provider.status = 'connected';
    provider.windows = account.quota.windows;
    provider.plan = account.quota.plan;
    provider.resetCredits = account.quota.resetCredits;
    provider.resetCreditCount = account.quota.resetCreditCount;
    provider.message = account.connection.message;
    provider.warnings = provider.warnings.filter(
      (message) => !/quota windows|recorded reset time/i.test(message),
    );
  }
  // Local token activity and its timestamp remain independent from account quota freshness.
}
