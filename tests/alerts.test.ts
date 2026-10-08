import { describe, it, expect } from 'vitest';
import { collectAlerts } from '../electron/alerts';
import { defaultSettings } from '../src/shared/defaults';
import type { DashboardState } from '../src/shared/types';
const now = Date.parse('2026-10-08T08:00:00Z');
function snapshot(): DashboardState {
  return {
    version: '0.1.0',
    refreshedAt: new Date(now).toISOString(),
    settings: { ...defaultSettings, notifications: true },
    providers: [
      {
        id: 'codex',
        name: 'Codex',
        source: 'local',
        status: 'connected',
        plan: 'Pro',
        updatedAt: new Date(now).toISOString(),
        windows: [
          {
            label: 'Weekly',
            observedAt: new Date(now).toISOString(),
            usedPercent: 85,
            resetsAt: new Date(now + 86400000).toISOString(),
            windowMinutes: 10080,
          },
        ],
        daily: [],
        totalTokens: 0,
        sessionCount: 0,
        model: null,
        message: '',
        warnings: [],
      },
    ],
  };
}
describe('native usage alerts', () => {
  it('notifies once per window and rearms after recovery', () => {
    const s = snapshot(),
      seen = new Set<string>();
    expect(collectAlerts(s, seen, now)).toHaveLength(1);
    expect(collectAlerts(s, seen, now)).toHaveLength(0);
    s.providers[0].windows[0].usedPercent = 40;
    collectAlerts(s, seen, now);
    s.providers[0].windows[0].usedPercent = 90;
    expect(collectAlerts(s, seen, now)).toHaveLength(1);
  });
  it('never alerts for demo, manual, expired or stale observations', () => {
    const s = snapshot();
    s.settings.demoMode = true;
    expect(collectAlerts(s, new Set(), now)).toHaveLength(0);
    s.settings.demoMode = false;
    s.providers[0].source = 'manual';
    expect(collectAlerts(s, new Set(), now)).toHaveLength(0);
    s.providers[0].source = 'local';
    expect(collectAlerts(s, new Set(), now + 3 * 3600000)).toHaveLength(0);
    s.providers[0].updatedAt = new Date(now + 2 * 86400000).toISOString();
    expect(collectAlerts(s, new Set(), now + 2 * 86400000)).toHaveLength(0);
  });
  it('does not mistake fresh token activity for fresh quota', () => {
    const s = snapshot();
    s.providers[0].windows[0].observedAt = new Date(now - 3 * 3600000).toISOString();
    expect(collectAlerts(s, new Set(), now)).toHaveLength(0);
    delete s.providers[0].windows[0].observedAt;
    expect(collectAlerts(s, new Set(), now)).toHaveLength(0);
  });
});
