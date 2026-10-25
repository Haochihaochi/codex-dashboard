import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearUsageCache,
  usageCacheStats,
  readClaudeUsage,
  readCodexUsage,
} from '../electron/usage';

const folders: string[] = [];
const now = new Date(2026, 9, 8, 20, 0);
const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).toISOString();
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'codex-dashboard-test-'));
  folders.push(path);
  return path;
}
async function log(path: string, name: string, events: unknown[]) {
  await writeFile(join(path, name), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
}
function usage(timestamp: string, total: number, extra: Record<string, unknown> = {}) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: total * 0.8,
          output_tokens: total * 0.2,
          cached_input_tokens: total * 0.4,
          total_tokens: total,
        },
        last_token_usage: {
          input_tokens: 8,
          output_tokens: 2,
          cached_input_tokens: 4,
          total_tokens: 10,
        },
      },
      ...extra,
    },
  };
}
function limits(percent: number, reset = now.getTime() / 1000 + 3600) {
  return {
    limit_id: 'codex',
    plan_type: 'pro',
    primary: { used_percent: percent, window_minutes: 300, resets_at: reset },
    secondary: { used_percent: 20, window_minutes: 10080, resets_at: reset + 86400 },
  };
}
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Codex local usage', () => {
  it('reuses sanitized unchanged logs, invalidates growing files, and never uses a deleted log', async () => {
    clearUsageCache();
    const root = await fixture();
    await log(root, 'cached.jsonl', [
      usage(at(8), 100),
      { timestamp: at(8), type: 'response_item', payload: { content: 'PRIVATE_TRANSCRIPT' } },
    ]);
    expect((await readCodexUsage(root, now)).totalTokens).toBe(100);
    expect(usageCacheStats().misses).toBe(1);
    expect((await readCodexUsage(root, now)).totalTokens).toBe(100);
    expect(usageCacheStats().hits).toBe(1);
    await log(root, 'cached.jsonl', [usage(at(8), 100), usage(at(8, 13), 200)]);
    expect((await readCodexUsage(root, now)).totalTokens).toBe(200);
    expect(usageCacheStats().misses).toBe(2);
    await rm(join(root, 'cached.jsonl'));
    expect((await readCodexUsage(root, now)).totalTokens).toBe(0);
    expect(usageCacheStats().memoryBytes).toBeLessThan(16 * 1024 * 1024);
  });
  it('sorts timestamps, applies cumulative deltas, and buckets today by local hour and actual model', async () => {
    const root = await fixture();
    await log(root, 'session.jsonl', [
      usage(at(8, 15), 300, { rate_limits: limits(30) }),
      usage(at(8, 13), 220),
      { timestamp: at(7, 10), type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
      usage(at(7), 160),
      usage(new Date(2026, 8, 20, 12).toISOString(), 100),
      usage(at(8, 14), 220),
    ]);
    const snapshot = await readCodexUsage(root, now);
    expect(snapshot.status).toBe('connected');
    expect(snapshot.totalTokens).toBe(200);
    expect(snapshot.today?.totalTokens).toBe(140);
    expect(snapshot.daily.find((day) => day.date === '2026-10-07')?.totalTokens).toBe(60);
    expect(snapshot.hourly?.find((hour) => hour.hour === 13)?.totalTokens).toBe(60);
    expect(snapshot.hourly?.find((hour) => hour.hour === 15)?.totalTokens).toBe(80);
    expect(snapshot.hourly?.find((hour) => hour.hour === 14)?.totalTokens).toBe(0);
    expect(snapshot.sessionCount).toBe(1);
    expect(snapshot.sessionCountToday).toBe(1);
    expect(snapshot.models).toEqual([{ model: 'gpt-6.1-sol', totalTokens: 140, sessionCount: 1 }]);
    expect(snapshot.windows.map((window) => window.label)).toEqual(['5 hour', 'Weekly']);
    expect(snapshot.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('uses latest observed quota timestamps, keeps expired values, and accepts multiple limit IDs', async () => {
    const root = await fixture();
    await log(root, 'new.jsonl', [
      usage(at(8, 16), 100, {
        rate_limits: [
          limits(82, now.getTime() / 1000 - 3600),
          { limit_id: 'codex-review', primary: { used_percent: 10, window_minutes: 1440 } },
        ],
      }),
    ]);
    await log(root, 'old.jsonl', [usage(at(7, 16), 100, { rate_limits: limits(40) })]);
    await utimes(join(root, 'new.jsonl'), now, now);
    await utimes(join(root, 'old.jsonl'), now, new Date(now.getTime() + 10_000));
    const snapshot = await readCodexUsage(root, now);
    expect(snapshot.windows[0].usedPercent).toBe(82);
    expect(snapshot.windows.some((window) => window.label === 'codex-review · Daily')).toBe(true);
    expect(snapshot.warnings.join(' ')).toContain('reset time has passed');
    expect(snapshot.resetCredits).toBeUndefined();
  });

  it('does not count copied session IDs twice and never exposes transcript text', async () => {
    const root = await fixture();
    const events = [
      { timestamp: at(8, 10), type: 'session_meta', payload: { id: 'same-session' } },
      usage(at(8), 100),
      { timestamp: at(8), type: 'response_item', payload: { secret: 'PRIVATE_PROMPT_MARKER' } },
    ];
    await log(root, 'one.jsonl', events);
    await log(root, 'two.jsonl', events);
    await writeFile(join(root, 'auth.json'), '{"access_token":"PRIVATE_CREDENTIAL_MARKER"}');
    const snapshot = await readCodexUsage(root, now);
    expect(snapshot.totalTokens).toBe(100);
    expect(snapshot.sessionCount).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
    expect(snapshot.models?.[0].model).toBe('Unknown model');
  });

  it('does not make an old quota fresh when newer token-only activity arrives', async () => {
    const root = await fixture();
    await log(root, 'session.jsonl', [
      usage(at(6), 100, { rate_limits: limits(80) }),
      usage(at(8), 200),
    ]);
    const snapshot = await readCodexUsage(root, now);
    expect(snapshot.updatedAt).toBe(at(8));
    expect(snapshot.windows[0].observedAt).toBe(at(6));
    expect(snapshot.warnings.join(' ')).toContain('over 24 hours old');
  });

  it('merges an older copied session even when the copy has the newest filesystem timestamp', async () => {
    const root = await fixture();
    const header = { timestamp: at(8, 9), type: 'session_meta', payload: { id: 'same-session' } };
    await log(root, 'active.jsonl', [
      header,
      usage(at(8, 10), 100, { rate_limits: limits(20) }),
      usage(at(8, 12), 200, { rate_limits: limits(90) }),
    ]);
    await log(root, 'copied.jsonl', [header, usage(at(8, 10), 100, { rate_limits: limits(20) })]);
    await utimes(join(root, 'active.jsonl'), now, now);
    await utimes(join(root, 'copied.jsonl'), now, new Date(now.getTime() + 10_000));
    const snapshot = await readCodexUsage(root, now);
    expect(snapshot.totalTokens).toBe(200);
    expect(snapshot.windows[0].usedPercent).toBe(90);
    expect(snapshot.sessionCount).toBe(1);
  });

  it('uses only the first visible last_token_usage for a truncated baseline and discloses bounds', async () => {
    const root = await fixture();
    const tail =
      [usage(at(8, 11), 110), usage(at(8, 12), 120)]
        .map((item) => JSON.stringify(item))
        .join('\n') + '\n';
    await writeFile(
      join(root, 'large.jsonl'),
      JSON.stringify({ timestamp: at(8, 10), type: 'ignored', padding: 'x'.repeat(5000) }) +
        '\n' +
        tail,
    );
    const snapshot = await readCodexUsage(root, now, {
      bytesPerFile: Buffer.byteLength(tail) + 10,
    });
    expect(snapshot.totalTokens).toBe(20);
    expect(snapshot.warnings.join(' ')).toContain('lower bound');
  });

  it('handles counter resets, malformed lines, and an unfinished final write', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'session.jsonl'),
      JSON.stringify(usage(at(8, 10), 100)) +
        '\ninvalid json\n' +
        JSON.stringify(usage(at(8, 10), -50)) +
        '\n' +
        JSON.stringify(usage(at(8, 11), 20)) +
        '\n{"unfinished":',
    );
    const snapshot = await readCodexUsage(root, now);
    expect(snapshot.totalTokens).toBe(110);
    expect(snapshot.warnings.join(' ')).toContain('Malformed');
  });

  it('skips symlinked folders and bounds the newest-file scan', async () => {
    const root = await fixture();
    const outside = await fixture();
    await log(outside, 'outside.jsonl', [usage(at(8), 9000)]);
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await log(root, 'one.jsonl', [usage(at(8), 100)]);
    await log(root, 'two.jsonl', [usage(at(8), 200)]);
    await utimes(join(root, 'one.jsonl'), now, now);
    await utimes(join(root, 'two.jsonl'), now, new Date(now.getTime() + 10_000));
    const snapshot = await readCodexUsage(root, now, { files: 1 });
    expect(snapshot.totalTokens).toBe(200);
    expect(snapshot.warnings.join(' ')).toContain('1 most recently modified');
    expect((await readCodexUsage(join(root, 'linked'), now)).totalTokens).toBe(0);
  });

  it('supports the Codex data root and reports an empty folder honestly', async () => {
    const root = await fixture();
    await mkdir(join(root, 'sessions'));
    await mkdir(join(root, 'archived_sessions'));
    await log(join(root, 'sessions'), 'active.jsonl', [usage(at(8), 100)]);
    await log(join(root, 'archived_sessions'), 'archive.jsonl', [usage(at(7), 200)]);
    expect((await readCodexUsage(root, now)).totalTokens).toBe(300);
    const missing = await readCodexUsage(join(root, 'missing'), now);
    expect(missing.source).toBe('unavailable');
    expect(missing.status).toBe('needs-setup');
    expect(missing.windows).toEqual([]);
    expect(missing.today?.totalTokens).toBe(0);
  });
});

describe('Claude Code local activity', () => {
  it('deduplicates assistant chunks and includes cache input without inventing quota', async () => {
    const root = await fixture();
    const message = (output: number) => ({
      timestamp: at(8, 13),
      type: 'assistant',
      sessionId: 'session-one',
      message: {
        id: 'message-one',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 20,
          output_tokens: output,
        },
        content: [{ text: 'PRIVATE_CLAUDE_PROMPT' }],
      },
    });
    await log(root, 'session.jsonl', [message(10), message(30), message(20)]);
    const snapshot = await readClaudeUsage(root, now);
    expect(snapshot.today).toMatchObject({
      totalTokens: 200,
      inputTokens: 170,
      outputTokens: 30,
      cachedTokens: 50,
    });
    expect(snapshot.models).toEqual([
      { model: 'claude-sonnet-4-6', totalTokens: 200, sessionCount: 1 },
    ]);
    expect(snapshot.sessionCountToday).toBe(1);
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.plan).toBeNull();
    expect(snapshot.message).toContain('do not expose account quota');
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
  });
});
