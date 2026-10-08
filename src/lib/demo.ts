import { defaultSettings } from '../shared/defaults';
import type { DashboardState, ProviderSnapshot, Settings } from '../shared/types';

export function createDemoProviders(now = new Date()): ProviderSnapshot[] {
  const values = [16, 34, 28, 46, 21, 58, 38, 63, 29, 51, 77, 45, 68, 54];
  return (['codex', 'claude', 'cursor', 'gemini'] as const).map((id, index) => {
    const daily = values.map((value, day) => {
      const date = new Date(now);
      date.setDate(date.getDate() - 13 + day);
      const inputTokens = Math.round((value * 1820) / (index + 1));
      const outputTokens = Math.round(inputTokens * 0.27);
      const cachedTokens = Math.round(inputTokens * 0.43);
      return {
        date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
        inputTokens,
        outputTokens,
        cachedTokens,
        totalTokens: inputTokens + outputTokens,
      };
    });
    const today = daily[daily.length - 1];
    const weights = [
      0, 0, 0, 0, 0, 0, 0, 0, 0.01, 0.04, 0.31, 0.59, 0, 0, 0.01, 0.01, 0.01, 0.01, 0.01, 0, 0, 0,
      0, 0,
    ];
    return {
      id,
      name: ['Codex', 'Claude Code', 'Cursor', 'Gemini'][index],
      source: 'demo',
      status: 'connected',
      plan: ['Plus', 'Pro', 'Pro', 'AI Pro'][index],
      updatedAt: now.toISOString(),
      windows:
        id === 'claude'
          ? []
          : [
              {
                label: '7-day window',
                usedPercent: [25, 62, 34, 22][index],
                resetsAt: new Date(now.getTime() + (5 * 24 + 14) * 60 * 60_000).toISOString(),
                windowMinutes: 10080,
              },
            ],
      daily,
      totalTokens: daily.reduce((sum, day) => sum + day.totalTokens, 0),
      sessionCount: [24, 18, 12, 8][index],
      model: ['gpt-6.1-sol', 'claude-sonnet-4-6', 'Auto', 'gemini-2.5-pro'][index],
      today,
      sessionCountToday: [8, 4, 3, 2][index],
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hourly: weights.map((weight, hour) => ({
        hour,
        totalTokens: Math.round(today.totalTokens * weight),
      })),
      models:
        id === 'codex'
          ? [
              {
                model: 'gpt-5.6-sol',
                totalTokens: Math.round(today.totalTokens * 0.1),
                sessionCount: 2,
              },
              {
                model: 'gpt-6-astra',
                totalTokens: Math.round(today.totalTokens * 0.2),
                sessionCount: 1,
              },
              {
                model: 'gpt-6.1-sol',
                totalTokens: Math.round(today.totalTokens * 0.7),
                sessionCount: 5,
              },
            ]
          : [
              {
                model: ['gpt-6.1-sol', 'claude-sonnet-4-6', 'Auto', 'gemini-2.5-pro'][index],
                totalTokens: today.totalTokens,
                sessionCount: [8, 4, 3, 2][index],
              },
            ],
      resetCredits:
        id === 'codex'
          ? [14, 21, 29].map((days) => ({
              count: 1,
              expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
            }))
          : [],
      message: 'Illustrative sample data. Turn off demo mode to read local usage.',
      warnings: [],
    };
  });
}

export function createDemoState(settings: Settings = defaultSettings): DashboardState {
  return {
    providers: createDemoProviders(),
    settings,
    refreshedAt: new Date().toISOString(),
    version: '0.1.0',
  };
}
