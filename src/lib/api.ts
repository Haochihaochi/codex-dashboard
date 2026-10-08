import { defaultSettings } from '../shared/defaults';
import type {
  DashboardAPI,
  DashboardState,
  ManualUsage,
  ProviderSnapshot,
  Settings,
} from '../shared/types';
import { createDemoState } from './demo';

export const isDesktop = Boolean(window.codexDashboard);
const settingsKey = 'codex-dashboard-preview-settings';
const manualKey = 'codex-dashboard-preview-manual';
let settings: Settings = { ...defaultSettings, demoMode: true };
let manual: Record<string, ManualUsage & { updatedAt?: string }> = {};
try {
  const saved = localStorage.getItem(settingsKey);
  if (saved) settings = { ...settings, ...JSON.parse(saved) };
  manual = JSON.parse(localStorage.getItem(manualKey) || '{}');
} catch {
  /* Storage is optional in private browser contexts. */
}
const listeners = new Set<(state: DashboardState) => void>();
function previewState(): DashboardState {
  const state = createDemoState(settings);
  if (!settings.demoMode)
    state.providers = state.providers.map((provider) => {
      const entry = manual[provider.id];
      return {
        ...provider,
        source: entry ? 'manual' : 'unavailable',
        status: entry ? 'connected' : 'needs-setup',
        plan: entry?.plan || null,
        updatedAt: entry?.updatedAt || null,
        windows: entry
          ? [
              {
                label: entry.windowLabel,
                usedPercent: entry.usedPercent,
                resetsAt: entry.resetsAt || null,
                windowMinutes: null,
              },
            ]
          : [],
        daily: [],
        totalTokens: 0,
        sessionCount: 0,
        model: null,
        today: undefined,
        hourly: [],
        models: [],
        resetCredits: [],
        sessionCountToday: undefined,
        message: entry
          ? 'Usage entered manually in this browser.'
          : 'Open the desktop app to read local session files.',
        warnings: [],
      } as ProviderSnapshot;
    });
  return state;
}
function publish() {
  const state = previewState();
  listeners.forEach((listener) => listener(state));
  return state;
}
function persist() {
  try {
    localStorage.setItem(settingsKey, JSON.stringify(settings));
    localStorage.setItem(manualKey, JSON.stringify(manual));
  } catch {
    /* Keep settings in memory when storage is unavailable. */
  }
}
const links = {
  codex: 'https://chatgpt.com/codex',
  claude: 'https://claude.ai/settings/usage',
  cursor: 'https://cursor.com/dashboard',
  gemini: 'https://aistudio.google.com/',
  github: 'https://github.com/Haochihaochi/codex-dashboard',
};
const previewAPI: DashboardAPI = {
  async getState() {
    return previewState();
  },
  async refresh() {
    return publish();
  },
  async updateSettings(patch) {
    settings = { ...settings, ...patch };
    persist();
    return publish();
  },
  async saveManualUsage(usage) {
    if (
      !['cursor', 'gemini'].includes(usage.provider) ||
      !Number.isFinite(usage.usedPercent) ||
      usage.usedPercent < 0 ||
      usage.usedPercent > 100
    )
      throw new Error('Enter a valid usage percentage between 0 and 100.');
    manual[usage.provider] = { ...usage, updatedAt: new Date().toISOString() };
    persist();
    return publish();
  },
  async chooseDirectory() {
    return null;
  },
  async exportData() {
    const state = previewState();
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { providers: state.providers, refreshedAt: state.refreshedAt, version: state.version },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      ),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `codex-dashboard-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  },
  async openExternal(target) {
    window.open(links[target], '_blank', 'noopener,noreferrer');
  },
  async showDashboard() {
    window.location.search = '';
  },
  onState(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};
export const api: DashboardAPI = window.codexDashboard ?? previewAPI;
