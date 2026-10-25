import { lstat, open, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { APP_VERSION } from '../src/shared/version';
import type {
  DailyUsage,
  DashboardState,
  ManualUsage,
  ProviderId,
  ProviderSnapshot,
  Settings,
  UsageWindow,
} from '../src/shared/types';

const DAY = 86_400_000;
const NAMES: Record<ProviderId, string> = {
  codex: 'Codex',
  claude: 'Claude',
  cursor: 'Cursor',
  gemini: 'Gemini',
};
export const SCAN_LIMITS = {
  files: 300,
  directories: 600,
  entries: 20_000,
  bytesPerFile: 2 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
};
type Limits = typeof SCAN_LIMITS;
type Json = Record<string, unknown>;
type Event = { data: Json; time: number; sequence: number };
type Counts = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
};
type LogFile = { path: string; mtime: number; size: number };
type Scan = { files: LogFile[]; warnings: Set<string>; exists: boolean; failed: boolean };
type CachedEvents = {
  key: string;
  events: Event[];
  truncated: boolean;
  bytes: number;
  warnings: string[];
  memory: number;
};
const eventCache = new Map<string, CachedEvents>();
let cacheMemory = 0;
let cacheHits = 0;
let cacheMisses = 0;
export function usageCacheStats() {
  return {
    entries: eventCache.size,
    memoryBytes: cacheMemory,
    hits: cacheHits,
    misses: cacheMisses,
  };
}
export function clearUsageCache() {
  eventCache.clear();
  cacheMemory = 0;
  cacheHits = 0;
  cacheMisses = 0;
}

function object(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
    : 0;
}
function safeLabel(value: unknown, max = 80): string | null {
  return typeof value === 'string' && /^[\w .:/()+-]+$/.test(value) ? value.slice(0, max) : null;
}
function iso(time: number): string | null {
  return Number.isFinite(time) && Math.abs(time) < 8.64e15 ? new Date(time).toISOString() : null;
}
function eventTime(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}
function dateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
function emptyDays(now: Date): DailyUsage[] {
  return Array.from({ length: 14 }, (_, index) => ({
    date: dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13 + index)),
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
  }));
}
function blank(id: ProviderId, now: Date): ProviderSnapshot {
  return {
    id,
    name: NAMES[id],
    source: 'unavailable',
    status: 'needs-setup',
    plan: null,
    updatedAt: null,
    windows: [],
    daily: emptyDays(now),
    totalTokens: 0,
    sessionCount: 0,
    model: null,
    message: '',
    warnings: [],
  };
}
function addDaily(days: DailyUsage[], timestamp: number, counts: Counts): boolean {
  const date = dateKey(new Date(timestamp));
  const day = days.find((item) => item.date === date);
  if (!day) return false;
  for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens'] as const) {
    day[key] = Math.min(Number.MAX_SAFE_INTEGER, day[key] + counts[key]);
  }
  return counts.totalTokens > 0;
}

function activityTracker(result: ProviderSnapshot, now: Date) {
  const today = dateKey(now);
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, totalTokens: 0 }));
  const sessions = new Set<string>();
  const models = new Map<string, { totalTokens: number; sessions: Set<string> }>();
  return {
    add(timestamp: number, counts: Counts, session: string, model: string | null): boolean {
      const active = addDaily(result.daily, timestamp, counts);
      const date = new Date(timestamp);
      if (active && dateKey(date) === today) {
        sessions.add(session);
        hourly[date.getHours()].totalTokens += counts.totalTokens;
        const name = model || 'Unknown model';
        const item = models.get(name) || { totalTokens: 0, sessions: new Set<string>() };
        item.totalTokens += counts.totalTokens;
        item.sessions.add(session);
        models.set(name, item);
      }
      return active;
    },
    finish() {
      result.today = { ...result.daily[result.daily.length - 1] };
      result.sessionCountToday = sessions.size;
      result.hourly = hourly;
      result.models = [...models]
        .map(([model, item]) => ({
          model,
          totalTokens: item.totalTokens,
          sessionCount: item.sessions.size,
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens);
      result.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    },
  };
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function providerRoots(path: string, id: 'codex' | 'claude'): Promise<string[]> {
  const resolved = resolve(
    path ||
      (id === 'codex' ? process.env.CODEX_HOME : '') ||
      join(homedir(), id === 'codex' ? '.codex' : '.claude'),
  );
  if (!(await isRealDirectory(resolved))) return [resolved];
  const children = id === 'codex' ? ['sessions', 'archived_sessions'] : ['projects'];
  const roots: string[] = [];
  for (const child of children)
    if (await isRealDirectory(join(resolved, child))) roots.push(join(resolved, child));
  if (roots.length) return roots;
  // A chosen sessions/projects directory is also accepted. Never scan the whole default data root.
  return basename(resolved) === (id === 'codex' ? '.codex' : '.claude') ? [] : [resolved];
}

async function discover(roots: string[], limits: Limits): Promise<Scan> {
  const result: Scan = { files: [], warnings: new Set(), exists: false, failed: false };
  const queue = [...roots];
  let directories = 0;
  let entries = 0;
  while (queue.length && directories < limits.directories && entries < limits.entries) {
    const directory = queue.shift()!;
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      result.exists = true;
      directories++;
      // Codex date folders sort newest first, helping keep bounded scans relevant.
      const children = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        b.name.localeCompare(a.name),
      );
      for (const child of children) {
        if (++entries > limits.entries) break;
        if (child.isSymbolicLink()) continue;
        const path = join(directory, child.name);
        if (child.isDirectory()) queue.push(path);
        else if (child.isFile() && child.name.endsWith('.jsonl')) {
          try {
            const file = await lstat(path);
            if (file.isFile() && !file.isSymbolicLink())
              result.files.push({ path, mtime: file.mtimeMs, size: file.size });
          } catch {
            result.warnings.add('Some log files could not be read.');
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        result.failed = true;
        result.warnings.add('Some log folders could not be read. Check folder permissions.');
      }
    }
  }
  if (queue.length || entries > limits.entries)
    result.warnings.add('Folder scan limit reached. Activity totals may be incomplete.');
  result.files.sort((a, b) => b.mtime - a.mtime);
  if (result.files.length > limits.files)
    result.warnings.add(
      `Only the ${limits.files} most recently modified log files were scanned. Activity totals may be incomplete.`,
    );
  result.files = result.files.slice(0, limits.files);
  return result;
}

async function readEvents(
  file: LogFile,
  allowance: number,
  warnings: Set<string>,
): Promise<{ events: Event[]; truncated: boolean; bytes: number }> {
  const key = `${file.mtime}:${file.size}:${allowance}`;
  const cached = eventCache.get(file.path);
  if (cached?.key === key) {
    cacheHits++;
    for (const message of cached.warnings) warnings.add(message);
    eventCache.delete(file.path);
    eventCache.set(file.path, cached);
    return cached;
  }
  cacheMisses++;
  const fileWarnings = new Set<string>();
  let handle;
  try {
    // Recheck before opening because an active CLI can rotate a file after discovery.
    const before = await lstat(file.path);
    if (!before.isFile() || before.isSymbolicLink())
      return { events: [], truncated: false, bytes: 0 };
    handle = await open(file.path, 'r');
    const stat = await handle.stat();
    const length = Math.min(stat.size, allowance);
    const start = stat.size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const truncated = start > 0;
    if (truncated)
      fileWarnings.add(
        'Large logs were read from a bounded tail. Activity totals are a lower bound.',
      );
    let content = buffer.subarray(0, bytesRead).toString('utf8');
    if (truncated) {
      const firstBreak = content.indexOf('\n');
      content = firstBreak < 0 ? '' : content.slice(firstBreak + 1);
    }
    const lines = content.split('\n');
    const events: Event[] = [];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      try {
        const data = object(JSON.parse(lines[index]));
        if (!data) continue;
        const time = eventTime(data.timestamp);
        const extracted = extractUsageEvent(data);
        if (Number.isFinite(time) && extracted)
          events.push({ data: extracted, time, sequence: index });
      } catch {
        // An unfinished last line is normal while the CLI is writing; older bad lines are disclosed.
        if (index !== lines.length - 1)
          fileWarnings.add(
            'Malformed log entries were skipped. Activity totals may be incomplete.',
          );
      }
    }
    events.sort((a, b) => a.time - b.time || a.sequence - b.sequence);
    const memory = Buffer.byteLength(JSON.stringify(events)) * 2 + events.length * 128;
    const previous = eventCache.get(file.path);
    if (previous) {
      eventCache.delete(file.path);
      cacheMemory -= previous.memory;
    }
    while (eventCache.size && (cacheMemory + memory > 16 * 1024 * 1024 || eventCache.size >= 600)) {
      const oldest = eventCache.keys().next().value!;
      cacheMemory -= eventCache.get(oldest)!.memory;
      eventCache.delete(oldest);
    }
    if (memory <= 16 * 1024 * 1024) {
      eventCache.set(file.path, {
        key,
        events,
        truncated,
        bytes: bytesRead,
        warnings: [...fileWarnings],
        memory,
      });
      cacheMemory += memory;
    }
    for (const message of fileWarnings) warnings.add(message);
    return { events, truncated, bytes: bytesRead };
  } catch {
    warnings.add('Some log files could not be read.');
    return { events: [], truncated: false, bytes: 0 };
  } finally {
    await handle?.close();
  }
}

/** Cache only usage fields. Conversation text, commands, paths, and auth records are discarded. */
function extractUsageEvent(data: Json): Json | null {
  const payload = object(data.payload);
  const shortId = (value: unknown) => (typeof value === 'string' ? value.slice(0, 256) : undefined);
  if (data.type === 'session_meta')
    return { type: data.type, payload: { id: shortId(payload?.id) } };
  if (data.type === 'turn_context')
    return { type: data.type, payload: { model: safeLabel(payload?.model) } };
  if (data.type === 'event_msg' && payload?.type === 'token_count') {
    const info = object(payload.info);
    const rawCounts = (value: unknown) => {
      const counts = codexCounts(value);
      return counts
        ? {
            input_tokens: counts.inputTokens,
            output_tokens: counts.outputTokens,
            cached_input_tokens: counts.cachedTokens,
            total_tokens: counts.totalTokens,
          }
        : null;
    };
    const rate_limits = parseLimits(payload.rate_limits).map((limit) => {
      const window = (index: number) => {
        const item = limit.windows[index];
        return item
          ? {
              used_percent: item.usedPercent,
              window_minutes: item.windowMinutes,
              resets_at: item.resetsAt ? Date.parse(item.resetsAt) / 1000 : null,
            }
          : null;
      };
      const firstLabel = limit.windows[0]?.label ?? '';
      const secondaryOnly = limit.windows.length === 1 && /(?:^| · )Secondary$/.test(firstLabel);
      return {
        limit_id: limit.key,
        plan_type: limit.plan,
        limit_name: firstLabel.includes(' · ') ? firstLabel.split(' · ')[0] : null,
        primary: secondaryOnly ? null : window(0),
        secondary: secondaryOnly ? window(0) : window(1),
      };
    });
    return {
      type: data.type,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: rawCounts(info?.total_token_usage),
          last_token_usage: rawCounts(info?.last_token_usage),
        },
        rate_limits,
      },
    };
  }
  if (data.type === 'assistant') {
    const message = object(data.message),
      usage = object(message?.usage);
    if (!usage) return null;
    return {
      type: data.type,
      sessionId: shortId(data.sessionId),
      uuid: shortId(data.uuid),
      message: {
        id: shortId(message?.id),
        model: safeLabel(message?.model),
        usage: Object.fromEntries(
          [
            'input_tokens',
            'output_tokens',
            'cache_read_input_tokens',
            'cache_creation_input_tokens',
          ].map((key) => [key, count(usage[key])]),
        ),
      },
    };
  }
  return null;
}

function codexCounts(value: unknown): Counts | null {
  const usage = object(value);
  if (
    !usage ||
    !['input_tokens', 'output_tokens', 'total_tokens'].some((key) => typeof usage[key] === 'number')
  )
    return null;
  for (const key of ['input_tokens', 'output_tokens', 'cached_input_tokens', 'total_tokens']) {
    const entry = usage[key];
    if (entry !== undefined && (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0))
      return null;
  }
  const inputTokens = count(usage.input_tokens);
  const outputTokens = count(usage.output_tokens);
  return {
    inputTokens,
    outputTokens,
    cachedTokens: Math.min(inputTokens, count(usage.cached_input_tokens)),
    totalTokens:
      typeof usage.total_tokens === 'number'
        ? count(usage.total_tokens)
        : inputTokens + outputTokens,
  };
}

function difference(current: Counts, previous: Counts): Counts {
  if (current.totalTokens === previous.totalTokens)
    return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 };
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    cachedTokens: Math.max(0, current.cachedTokens - previous.cachedTokens),
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
  };
}
function windowName(minutes: number | null, fallback: string): string {
  if (minutes === 10_080) return 'Weekly';
  if (minutes === 1440) return 'Daily';
  if (minutes && minutes % 60 === 0) return `${minutes / 60} hour`;
  return minutes ? `${minutes} minute` : fallback;
}
function parseLimits(
  value: unknown,
  depth = 0,
): { key: string; plan: string | null; windows: UsageWindow[] }[] {
  if (depth > 3) return [];
  if (Array.isArray(value))
    return value.slice(0, 16).flatMap((item) => parseLimits(item, depth + 1));
  const entry = object(value);
  if (!entry) return [];
  if (!('primary' in entry) && !('secondary' in entry))
    return Object.values(entry)
      .slice(0, 16)
      .filter((item) => object(item))
      .flatMap((item) => parseLimits(item, depth + 1));
  const key = safeLabel(entry.limit_id) || 'codex';
  const scope = safeLabel(entry.limit_name) || (key === 'codex' ? '' : key);
  const windows: UsageWindow[] = [];
  for (const name of ['primary', 'secondary']) {
    const raw = object(entry[name]);
    if (!raw || typeof raw.used_percent !== 'number' || !Number.isFinite(raw.used_percent))
      continue;
    const minutes =
      typeof raw.window_minutes === 'number' && raw.window_minutes > 0 ? raw.window_minutes : null;
    const label = windowName(minutes, name === 'primary' ? 'Primary' : 'Secondary');
    windows.push({
      label: scope ? `${scope} · ${label}` : label,
      usedPercent: Math.max(0, Math.min(100, raw.used_percent)),
      windowMinutes: minutes,
      resetsAt: typeof raw.resets_at === 'number' ? iso(raw.resets_at * 1000) : null,
    });
  }
  return [{ key, plan: safeLabel(entry.plan_type), windows }];
}

export async function readCodexUsage(
  path: string,
  now = new Date(),
  override: Partial<Limits> = {},
): Promise<ProviderSnapshot> {
  const limits = { ...SCAN_LIMITS, ...override };
  const scan = await discover(await providerRoots(path, 'codex'), limits);
  const result = blank('codex', now);
  const activity = activityTracker(result, now);
  const quota = new Map<string, { time: number; plan: string | null; windows: UsageWindow[] }>();
  type AccountingEvent = {
    time: number;
    model: string | null;
    token: boolean;
    cumulative: Counts | null;
    last: Counts | null;
    limits: ReturnType<typeof parseLimits>;
  };
  const sessions = new Map<string, { events: AccountingEvent[]; hasCompleteLog: boolean }>();
  let remaining = limits.totalBytes;
  let latest = 0;
  let modelTime = 0;
  let found = false;
  for (const file of scan.files) {
    if (remaining <= 0) {
      scan.warnings.add('Total scan size limit reached. Activity totals may be incomplete.');
      break;
    }
    const read = await readEvents(file, Math.min(limits.bytesPerFile, remaining), scan.warnings);
    remaining -= read.bytes;
    const metadata = read.events.find((event) => event.data.type === 'session_meta');
    const sessionId = object(metadata?.data.payload)?.id;
    // Merge copied sessions by ID; filesystem mtime cannot tell which copy contains newer events.
    // Retain only extracted accounting fields, never transcript text or project paths.
    const key = typeof sessionId === 'string' ? sessionId : basename(file.path);
    const session = sessions.get(key) || { events: [], hasCompleteLog: false };
    session.hasCompleteLog ||= !read.truncated;
    for (const { data, time } of read.events) {
      if (time > now.getTime() + 5 * 60_000) continue;
      const payload = object(data.payload);
      if (data.type === 'turn_context' && payload) {
        session.events.push({
          time,
          model: safeLabel(payload.model),
          token: false,
          cumulative: null,
          last: null,
          limits: [],
        });
      } else if (data.type === 'event_msg' && payload?.type === 'token_count') {
        const info = object(payload.info);
        session.events.push({
          time,
          model: null,
          token: true,
          cumulative: codexCounts(info?.total_token_usage),
          last: codexCounts(info?.last_token_usage),
          limits: parseLimits(payload.rate_limits),
        });
      }
    }
    sessions.set(key, session);
  }
  for (const [key, session] of sessions) {
    session.events.sort((a, b) => a.time - b.time || Number(a.token) - Number(b.token));
    let previous: Counts | null = null;
    let active = false;
    let activeModel: string | null = null;
    for (const event of session.events) {
      const { time, model, cumulative, last } = event;
      if (model) {
        activeModel = model;
        if (time >= modelTime) {
          result.model = model;
          modelTime = time;
        }
      }
      if (!event.token) continue;
      found = true;
      latest = Math.max(latest, time);
      for (const limit of event.limits) {
        if (time >= (quota.get(limit.key)?.time ?? 0) && limit.windows.length) {
          quota.set(limit.key, {
            time,
            plan: limit.plan,
            windows: limit.windows.map((window) => ({
              ...window,
              observedAt: new Date(time).toISOString(),
            })),
          });
        }
      }
      let contribution: Counts | null = null;
      if (cumulative) {
        if (previous && cumulative.totalTokens >= previous.totalTokens)
          contribution = difference(cumulative, previous);
        else if (previous || !session.hasCompleteLog) contribution = last;
        else contribution = cumulative;
        previous = cumulative;
      } else if (last) {
        // Without a cumulative counter repeated limit events are indistinguishable; do not invent totals.
        scan.warnings.add(
          'Some token events lack cumulative counters and were excluded from activity totals.',
        );
      }
      if (contribution && activity.add(time, contribution, key, activeModel)) active = true;
    }
    if (active) result.sessionCount++;
  }
  const windows = [...quota.values()].sort((a, b) => b.time - a.time);
  result.windows = windows.flatMap((item) => item.windows).slice(0, 8);
  result.plan = windows.find((item) => item.plan)?.plan ?? null;
  if (windows.some((window) => now.getTime() - window.time > DAY))
    scan.warnings.add(
      'Some quota windows are over 24 hours old. Run Codex to record a fresh snapshot.',
    );
  if (result.windows.some((item) => item.resetsAt && Date.parse(item.resetsAt) <= now.getTime()))
    scan.warnings.add(
      'A recorded reset time has passed. Quota remains last observed until Codex records an update.',
    );
  result.updatedAt = latest ? iso(latest) : null;
  result.totalTokens = result.daily.reduce((sum, day) => sum + day.totalTokens, 0);
  result.source = found ? 'local' : 'unavailable';
  result.status = found ? 'connected' : scan.failed ? 'error' : 'needs-setup';
  result.message = found
    ? 'Last observed Codex CLI quota. Token activity covers 14 local calendar days and may differ from billed usage.'
    : scan.exists
      ? 'No supported Codex usage events found. Run Codex, then refresh.'
      : 'Run Codex locally or select its data folder in Settings.';
  result.warnings = [...scan.warnings];
  activity.finish();
  return result;
}

export async function readClaudeUsage(
  path: string,
  now = new Date(),
  override: Partial<Limits> = {},
): Promise<ProviderSnapshot> {
  const limits = { ...SCAN_LIMITS, ...override };
  const scan = await discover(await providerRoots(path, 'claude'), limits);
  const result = blank('claude', now);
  const activity = activityTracker(result, now);
  const messages = new Map<
    string,
    { counts: Counts; time: number; session: string; model: string | null }
  >();
  let remaining = limits.totalBytes;
  let latest = 0;
  for (const file of scan.files) {
    if (remaining <= 0) {
      scan.warnings.add('Total scan size limit reached. Activity totals may be incomplete.');
      break;
    }
    const read = await readEvents(file, Math.min(limits.bytesPerFile, remaining), scan.warnings);
    remaining -= read.bytes;
    for (const { data, time, sequence } of read.events) {
      if (data.type !== 'assistant' || time > now.getTime() + 5 * 60_000) continue;
      const message = object(data.message);
      const usage = object(message?.usage);
      if (!usage) continue;
      const inputTokens =
        count(usage.input_tokens) +
        count(usage.cache_read_input_tokens) +
        count(usage.cache_creation_input_tokens);
      const outputTokens = count(usage.output_tokens);
      const counts: Counts = {
        inputTokens,
        outputTokens,
        cachedTokens: count(usage.cache_read_input_tokens),
        totalTokens: inputTokens + outputTokens,
      };
      const session = typeof data.sessionId === 'string' ? data.sessionId : basename(file.path);
      const key =
        typeof message?.id === 'string'
          ? message.id
          : typeof data.uuid === 'string'
            ? data.uuid
            : `${session}:${sequence}`;
      const existing = messages.get(key);
      if (existing) {
        // Assistant chunks can repeat or refine the same message's cumulative usage.
        existing.counts.inputTokens = Math.max(existing.counts.inputTokens, counts.inputTokens);
        existing.counts.outputTokens = Math.max(existing.counts.outputTokens, counts.outputTokens);
        existing.counts.cachedTokens = Math.max(existing.counts.cachedTokens, counts.cachedTokens);
        existing.counts.totalTokens = existing.counts.inputTokens + existing.counts.outputTokens;
      } else messages.set(key, { counts, time, session, model: safeLabel(message?.model) });
      if (time >= latest) {
        latest = time;
        result.model = safeLabel(message?.model) ?? result.model;
      }
    }
  }
  const sessions = new Set<string>();
  for (const entry of messages.values())
    if (activity.add(entry.time, entry.counts, entry.session, entry.model))
      sessions.add(entry.session);
  result.sessionCount = sessions.size;
  result.totalTokens = result.daily.reduce((sum, day) => sum + day.totalTokens, 0);
  result.updatedAt = latest ? iso(latest) : null;
  result.source = messages.size ? 'local' : 'unavailable';
  result.status = messages.size ? 'connected' : scan.failed ? 'error' : 'needs-setup';
  result.message = messages.size
    ? 'Local Claude Code token activity for 14 local calendar days. Logs do not expose account quota.'
    : scan.exists
      ? 'No supported Claude Code usage found. Run Claude Code, then refresh.'
      : 'Run Claude Code locally or select its data folder in Settings.';
  result.warnings = [...scan.warnings];
  activity.finish();
  return result;
}

export async function buildState(
  settings: Settings,
  manualUsage: ManualUsage[],
): Promise<DashboardState> {
  const now = new Date();
  const [codex, claude] = await Promise.all([
    readCodexUsage(settings.codexPath, now),
    readClaudeUsage(settings.claudePath, now),
  ]);
  const providers = [codex, claude, blank('cursor', now), blank('gemini', now)];
  for (const provider of providers) {
    const manual = manualUsage.find((item) => item.provider === provider.id);
    if (manual) {
      provider.source = 'manual';
      provider.status = 'connected';
      provider.plan = manual.plan || provider.plan;
      provider.windows = [
        {
          label: manual.windowLabel,
          usedPercent: manual.usedPercent,
          resetsAt: manual.resetsAt || null,
          windowMinutes: null,
        },
      ];
      provider.message =
        'Manually entered quota. Update this value when your provider usage changes.';
      if (manual.resetsAt && Date.parse(manual.resetsAt) <= now.getTime())
        provider.warnings.push(
          'The manual reset time has passed. Update this entry; it has not been reset automatically.',
        );
    } else if (provider.id === 'cursor' || provider.id === 'gemini') {
      provider.message = `Add a manual ${provider.name} quota window. Automatic account sync is not connected.`;
    }
  }
  return {
    providers,
    settings: { ...settings },
    refreshedAt: now.toISOString(),
    version: APP_VERSION,
  };
}
