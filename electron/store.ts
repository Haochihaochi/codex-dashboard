import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultSettings } from '../src/shared/defaults';
import type { ManualUsage, ProviderId, Settings } from '../src/shared/types';

const providers: ProviderId[] = ['codex', 'claude', 'cursor', 'gemini'];
const settingKeys = new Set(Object.keys(defaultSettings));
const manualKeys = new Set(['provider', 'usedPercent', 'resetsAt', 'windowLabel', 'plan']);
type SavedData = { version: 1; settings: Settings; manualUsage: ManualUsage[] };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}

function textValue(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value.trim();
}

export function validateSettingsPatch(value: unknown): Partial<Settings> {
  const patch = record(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(patch)) {
    if (!settingKeys.has(key)) throw new Error(`Unknown setting: ${key}.`);
    if (['demoMode', 'launchAtLogin', 'notifications'].includes(key)) {
      if (typeof entry !== 'boolean') throw new Error(`Invalid ${key}.`);
      result[key] = entry;
    } else if (key === 'refreshSeconds') {
      if (!Number.isInteger(entry) || (entry as number) < 15 || (entry as number) > 3600) {
        throw new Error('Refresh interval must be 15–3600 seconds.');
      }
      result[key] = entry;
    } else if (key === 'alertThreshold') {
      if (!Number.isInteger(entry) || (entry as number) < 1 || (entry as number) > 100) {
        throw new Error('Alert threshold must be 1–100 percent.');
      }
      result[key] = entry;
    } else if (key === 'theme') {
      if (!['dark', 'light', 'system'].includes(entry as string)) throw new Error('Invalid theme.');
      result[key] = entry;
    } else if (key === 'selectedProvider') {
      if (!providers.includes(entry as ProviderId)) throw new Error('Invalid provider.');
      result[key] = entry;
    } else {
      result[key] = textValue(entry, 2048, 'data folder');
    }
  }
  return result as Partial<Settings>;
}

export function validateManualUsage(value: unknown): ManualUsage {
  const input = record(value);
  for (const key of Object.keys(input))
    if (!manualKeys.has(key)) throw new Error(`Unknown usage field: ${key}.`);
  if (!['cursor', 'gemini'].includes(input.provider as string))
    throw new Error('Manual quota is supported for Cursor and Gemini only.');
  if (
    typeof input.usedPercent !== 'number' ||
    !Number.isFinite(input.usedPercent) ||
    input.usedPercent < 0 ||
    input.usedPercent > 100
  )
    throw new Error('Usage must be between 0 and 100 percent.');
  const resetsAt = textValue(input.resetsAt, 40, 'reset time');
  // Empty means the provider does not expose a reset time. Require an unambiguous timezone otherwise.
  if (
    resetsAt &&
    (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(resetsAt) ||
      !Number.isFinite(Date.parse(resetsAt)))
  )
    throw new Error('Invalid reset time.');
  const windowLabel = textValue(input.windowLabel, 40, 'window label');
  if (!windowLabel) throw new Error('Enter a window label.');
  return {
    provider: input.provider as ProviderId,
    usedPercent: input.usedPercent,
    resetsAt: resetsAt ? new Date(resetsAt).toISOString() : '',
    windowLabel,
    plan: textValue(input.plan, 60, 'plan'),
  };
}

/** Only preferences and user-entered quota values are persisted; transcripts and credentials never are. */
export function createStore(userDataDir: string) {
  mkdirSync(userDataDir, { recursive: true });
  const filename = join(userDataDir, 'settings.json');
  let data: SavedData = { version: 1, settings: { ...defaultSettings }, manualUsage: [] };
  try {
    if (statSync(filename).size <= 128 * 1024) {
      const parsed = record(JSON.parse(readFileSync(filename, 'utf8')));
      if (parsed.version === 1) {
        const settings = { ...defaultSettings, ...validateSettingsPatch(parsed.settings) };
        const manualUsage = Array.isArray(parsed.manualUsage)
          ? parsed.manualUsage.slice(0, 4).map(validateManualUsage)
          : [];
        // A corrupt or untrusted file cannot introduce duplicate provider records.
        data = {
          version: 1,
          settings,
          manualUsage: [...new Map(manualUsage.map((item) => [item.provider, item])).values()],
        };
      }
    }
  } catch {
    // Missing, malformed, or obsolete preferences use safe defaults; preserve the original until a save.
  }

  function persist(next: SavedData) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temporary, filename);
      data = next;
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        /* A successful rename already removes the temporary path. */
      }
    }
  }

  return {
    getSettings(): Settings {
      return { ...data.settings };
    },
    getManualUsage(): ManualUsage[] {
      return data.manualUsage.map((item) => ({ ...item }));
    },
    updateSettings(patch: unknown): Settings {
      const settings = { ...data.settings, ...validateSettingsPatch(patch) };
      persist({ ...data, settings });
      return { ...settings };
    },
    saveManualUsage(value: unknown): ManualUsage {
      const usage = validateManualUsage(value);
      persist({
        ...data,
        manualUsage: [
          ...data.manualUsage.filter((item) => item.provider !== usage.provider),
          usage,
        ],
      });
      return { ...usage };
    },
  };
}
