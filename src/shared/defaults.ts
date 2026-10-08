import type { Settings } from './types';
export const defaultSettings: Settings = {
  demoMode: false,
  refreshSeconds: 60,
  launchAtLogin: false,
  notifications: false,
  alertThreshold: 20,
  theme: 'dark',
  codexPath: '',
  claudePath: '',
  selectedProvider: 'codex',
};
