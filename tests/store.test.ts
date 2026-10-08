import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore, validateManualUsage, validateSettingsPatch } from '../electron/store';
import { defaultSettings } from '../src/shared/defaults';

const folders: string[] = [];
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'codex-dashboard-store-'));
  folders.push(path);
  return path;
}
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('preferences store', () => {
  it('persists validated preferences atomically and returns defensive copies', () => {
    const path = fixture();
    const store = createStore(path);
    store.updateSettings({ theme: 'system', refreshSeconds: 120, notifications: true });
    const copy = store.getSettings();
    copy.theme = 'light';
    expect(store.getSettings().theme).toBe('system');
    expect(createStore(path).getSettings()).toMatchObject({
      theme: 'system',
      refreshSeconds: 120,
      notifications: true,
    });
    expect(readdirSync(path)).toEqual(['settings.json']);
    expect(JSON.parse(readFileSync(join(path, 'settings.json'), 'utf8')).version).toBe(1);
  });

  it('rejects unknown IPC fields, wrong types, and out of range values without saving', () => {
    const store = createStore(fixture());
    for (const patch of [
      { shell: 'run.exe' },
      { refreshSeconds: 0 },
      { refreshSeconds: 60.5 },
      { refreshSeconds: 3601 },
      { notifications: 'yes' },
      { theme: 'sepia' },
      { selectedProvider: 'unknown' },
      { alertThreshold: NaN },
      { codexPath: 'bad\u0000path' },
      null,
      [],
    ]) {
      expect(() => store.updateSettings(patch)).toThrow();
    }
    expect(store.getSettings()).toEqual(defaultSettings);
    expect(() => validateSettingsPatch(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow();
  });

  it('retains one manual entry per supported provider and normalizes reset timezone', () => {
    const path = fixture();
    const store = createStore(path);
    const input = {
      provider: 'cursor',
      usedPercent: 15,
      resetsAt: '2026-10-09T08:00:00+08:00',
      windowLabel: ' Monthly ',
      plan: 'Pro',
    };
    store.saveManualUsage(input);
    store.saveManualUsage({ ...input, usedPercent: 22 });
    const values = store.getManualUsage();
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({
      usedPercent: 22,
      resetsAt: '2026-10-09T00:00:00.000Z',
      windowLabel: 'Monthly',
    });
    values[0].usedPercent = 99;
    expect(createStore(path).getManualUsage()[0].usedPercent).toBe(22);
    expect(store.getManualUsage()[0].usedPercent).toBe(22);
    expect(() => store.saveManualUsage({ ...input, provider: 'codex' })).toThrow(
      'Cursor and Gemini',
    );
    expect(() => store.saveManualUsage({ ...input, provider: 'claude' })).toThrow(
      'Cursor and Gemini',
    );
  });

  it('rejects ambiguous dates, non-finite percentages, markup control characters and unknown usage fields', () => {
    const usage = {
      provider: 'gemini',
      usedPercent: 20,
      resetsAt: '',
      windowLabel: 'Daily',
      plan: '',
    };
    expect(validateManualUsage(usage).resetsAt).toBe('');
    for (const patch of [
      { usedPercent: Infinity },
      { usedPercent: -1 },
      { usedPercent: 101 },
      { resetsAt: 'tomorrow' },
      { resetsAt: '2026-10-08T12:00:00' },
      { windowLabel: '' },
      { plan: 'bad\nvalue' },
      { apiKey: 'secret' },
    ]) {
      expect(() => validateManualUsage({ ...usage, ...patch })).toThrow();
    }
  });

  it('recovers from malformed or incompatible saved preferences', () => {
    const path = fixture();
    for (const content of [
      '{broken',
      JSON.stringify({ version: 999, settings: { theme: 'light' } }),
      JSON.stringify({ version: 1, settings: { refreshSeconds: 1 }, manualUsage: [] }),
    ]) {
      writeFileSync(join(path, 'settings.json'), content);
      expect(createStore(path).getSettings()).toEqual(defaultSettings);
    }
  });
});
