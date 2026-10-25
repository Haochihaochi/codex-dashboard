import type { DashboardState } from '../src/shared/types';
export interface UsageAlert {
  title: string;
  body: string;
}
export function collectAlerts(
  state: DashboardState,
  sent: Set<string>,
  now = Date.now(),
): UsageAlert[] {
  if (state.settings.demoMode || !state.settings.notifications) return [];
  const result: UsageAlert[] = [];
  const active = new Set<string>();
  for (const provider of state.providers) {
    if (
      !['local', 'account'].includes(provider.source) ||
      provider.status !== 'connected' ||
      provider.connection?.fromCache
    )
      continue;
    for (const window of provider.windows) {
      const observed = Date.parse(window.observedAt ?? '');
      if (!Number.isFinite(observed) || now - observed > 2 * 3600_000 || observed > now + 60_000)
        continue;
      if (!window.resetsAt || Date.parse(window.resetsAt) <= now) continue;
      const remaining = Math.max(0, 100 - window.usedPercent);
      const key = `${provider.id}:${window.label}:${window.resetsAt}`;
      if (remaining > state.settings.alertThreshold) continue;
      active.add(key);
      if (!sent.has(key)) {
        sent.add(key);
        result.push({
          title: `${provider.name}: ${Math.round(remaining)}% remaining`,
          body: `${window.label} is below your ${state.settings.alertThreshold}% alert threshold. Based on the latest ${provider.source === 'account' ? 'account check' : 'local record'}.`,
        });
      }
    }
  }
  for (const key of sent) if (!active.has(key)) sent.delete(key);
  return result;
}
