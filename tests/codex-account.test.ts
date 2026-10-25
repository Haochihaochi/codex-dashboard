import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccountQueryError,
  applyAccountSnapshot,
  createCodexAccountClient,
  normalizeAccountQuota,
  queryCodexAccount,
  resolveCodexHome,
} from '../electron/codex-account';
import type { QueryResult } from '../electron/codex-account';
import { readCodexUsage } from '../electron/usage';

const folders: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-account-test-'));
  folders.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(folders.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const now = Date.parse('2026-10-25T14:00:00Z');
const quotaResponse = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: now / 1000 + 3600 },
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      planType: 'pro',
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: now / 1000 + 3600 },
      secondary: { usedPercent: 48, windowDurationMins: 10080, resetsAt: now / 1000 + 86400 },
    },
  },
  rateLimitResetCredits: {
    availableCount: 3,
    credits: [{ status: 'available', expiresAt: now / 1000 + 86400, id: 'PRIVATE_CREDIT_ID' }],
  },
  accountId: 'PRIVATE_ACCOUNT_ID',
};
function result(): QueryResult {
  return {
    identity: 'account-fingerprint',
    quota: normalizeAccountQuota(quotaResponse, new Date(now).toISOString()),
  };
}

describe('Codex account quota', () => {
  it('prefers current multi-bucket quotas, preserves observation time, and handles reset counts without exposing IDs', () => {
    const quota = normalizeAccountQuota(quotaResponse, new Date(now).toISOString());
    expect(quota.windows.map((window) => window.usedPercent)).toEqual([12, 48]);
    expect(quota.windows[1].label).toBe('Weekly');
    expect(quota.windows[0].observedAt).toBe(new Date(now).toISOString());
    expect(quota.resetCreditCount).toBe(3);
    expect(quota.resetCredits).toEqual([
      { count: 1, expiresAt: new Date(now + 86400000).toISOString() },
      { count: 2, expiresAt: null },
    ]);
    expect(JSON.stringify(quota)).not.toContain('PRIVATE');
  });
  it('distinguishes unknown credits, zero credits, and an authenticated account with unreported windows', () => {
    expect(
      normalizeAccountQuota({ rateLimits: { primary: null } }, new Date(now).toISOString()).windows,
    ).toEqual([]);
    expect(
      normalizeAccountQuota(
        { rateLimits: {}, rateLimitResetCredits: null },
        new Date(now).toISOString(),
      ).resetCreditCount,
    ).toBeUndefined();
    expect(
      normalizeAccountQuota(
        { rateLimits: {}, rateLimitResetCredits: { availableCount: 0, credits: [] } },
        new Date(now).toISOString(),
      ).resetCreditCount,
    ).toBe(0);
    expect(() => normalizeAccountQuota({}, new Date(now).toISOString())).toThrow(AccountQueryError);
  });
  it('resolves the same Codex home from a selected sessions folder or CODEX_HOME', () => {
    const root = join(tmpdir(), 'codex-custom-home');
    expect(resolveCodexHome(join(root, 'sessions'))).toBe(root);
    expect(resolveCodexHome('', { CODEX_HOME: root })).toBe(root);
  });
});

describe('account recovery', () => {
  it('deduplicates concurrent checks and polls account usage less often than local activity', async () => {
    const query = vi.fn().mockResolvedValue(result());
    let clock = now;
    const client = createCodexAccountClient({ query, now: () => clock });
    const [first, second] = await Promise.all([client.read(), client.read()]);
    expect(first).toEqual(second);
    expect(query).toHaveBeenCalledTimes(1);
    clock += 30_000;
    await client.read();
    expect(query).toHaveBeenCalledTimes(1);
    await client.read('', true);
    expect(query).toHaveBeenCalledTimes(2);
    client.dispose();
  });
  it('retains quota and its actual timestamp after transient failures, backs off, and recovers without login', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockRejectedValueOnce(new Error('PRIVATE_NETWORK_DETAILS'))
      .mockResolvedValue(result());
    let clock = now;
    const client = createCodexAccountClient({ query, now: () => clock });
    const good = await client.read();
    clock += 121_000;
    const failed = await client.read();
    expect(failed.connection.status).toBe('retrying');
    expect(failed.quota).toEqual(good.quota);
    expect(failed.connection.fromCache).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_NETWORK_DETAILS');
    clock += 10_000;
    await client.read();
    expect(query).toHaveBeenCalledTimes(2);
    clock += 25_000;
    const recovered = await client.read();
    expect(recovered.connection.status).toBe('connected');
    expect(query).toHaveBeenCalledTimes(3);
    client.dispose();
  });
  it('does not present another home’s saved quota after a profile change or confirmed sign-out', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockRejectedValue(new AccountQueryError('signed-out'));
    const client = createCodexAccountClient({ query, now: () => now });
    await client.read(join(tmpdir(), 'profile-one'));
    const changed = await client.read(join(tmpdir(), 'profile-two'));
    expect(changed.quota).toBeUndefined();
    expect(changed.connection.status).toBe('signed-out');
    client.dispose();
  });
  it('keeps local token totals separate from fresh account quota', async () => {
    const root = await fixture();
    const provider = await readCodexUsage(root);
    const client = createCodexAccountClient({ query: async () => result(), now: () => now });
    applyAccountSnapshot(provider, await client.read());
    expect(provider.source).toBe('account');
    expect(provider.windows[0].usedPercent).toBe(12);
    expect(provider.today?.totalTokens).toBe(0);
    expect(provider.sessionCount).toBe(0);
    client.dispose();
  });
});

describe('read-only app-server protocol', () => {
  it('uses the existing session without reading credentials, requesting forced renewal, login, logout, or inference', async () => {
    const root = await fixture();
    const script = join(root, 'fake-codex.mjs');
    await writeFile(join(root, 'auth.json'), 'PRIVATE_AUTH_FILE_DO_NOT_TOUCH');
    await writeFile(
      script,
      `
      import {appendFileSync} from 'node:fs'; import {join} from 'node:path';
      let buffer=''; process.stdin.setEncoding('utf8');
      process.stdin.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))>=0){
        const request=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
        appendFileSync(join(process.env.CODEX_HOME,'rpc.jsonl'),JSON.stringify(request)+'\\n');
        let result;
        if(request.method==='initialize')result={userAgent:'fake'};
        else if(request.method==='account/read')result={account:{type:'chatgpt',email:'PRIVATE_EMAIL@example.test',planType:'pro'}};
        else if(request.method==='account/rateLimits/read')result=${JSON.stringify(quotaResponse)};
        if(request.id){const response=JSON.stringify({id:request.id,result})+'\\n';const mid=Math.floor(response.length/2);process.stdout.write(response.slice(0,mid));setTimeout(()=>process.stdout.write(response.slice(mid)),10)}
      }});
    `,
    );
    const response = await queryCodexAccount({
      home: root,
      executable: process.execPath,
      prefixArgs: [script],
      timeoutMs: 5000,
    });
    const messages = (await readFile(join(root, 'rpc.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(messages.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'account/rateLimits/read',
    ]);
    expect(messages[2].params).toEqual({ refreshToken: false });
    expect(await readFile(join(root, 'auth.json'), 'utf8')).toBe('PRIVATE_AUTH_FILE_DO_NOT_TOUCH');
    expect(JSON.stringify(response)).not.toContain('PRIVATE');
    expect(response.quota.windows[0].usedPercent).toBe(12);
  });
  it('times out and stops its own unresponsive child without trying to change authentication', async () => {
    const root = await fixture();
    const script = join(root, 'unresponsive.mjs');
    await writeFile(script, 'setInterval(()=>{},1000);');
    await expect(
      queryCodexAccount({
        home: root,
        executable: process.execPath,
        prefixArgs: [script],
        timeoutMs: 200,
      }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});
