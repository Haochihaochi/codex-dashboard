export type ProviderId = 'codex' | 'claude' | 'cursor' | 'gemini';
export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
  observedAt?: string;
}
export interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
}
export interface ProviderSnapshot {
  id: ProviderId;
  name: string;
  source: 'account' | 'local' | 'manual' | 'demo' | 'unavailable';
  status: 'connected' | 'needs-setup' | 'error';
  plan: string | null;
  updatedAt: string | null;
  windows: UsageWindow[];
  daily: DailyUsage[];
  totalTokens: number;
  sessionCount: number;
  model: string | null;
  message: string;
  warnings: string[];
  today?: DailyUsage;
  sessionCountToday?: number;
  timeZone?: string;
  hourly?: { hour: number; totalTokens: number }[];
  models?: { model: string; totalTokens: number; sessionCount: number }[];
  resetCredits?: { count: number; expiresAt: string | null }[];
  resetCreditCount?: number;
  connection?: AccountConnection;
}
export interface AccountConnection {
  status: 'connected' | 'retrying' | 'signed-out' | 'unavailable';
  checkedAt: string;
  lastSuccessAt: string | null;
  fromCache: boolean;
  message: string;
}
export interface Settings {
  demoMode: boolean;
  refreshSeconds: number;
  launchAtLogin: boolean;
  notifications: boolean;
  alertThreshold: number;
  theme: 'dark' | 'light' | 'system';
  codexPath: string;
  claudePath: string;
  selectedProvider: ProviderId;
}
export interface ManualUsage {
  provider: ProviderId;
  usedPercent: number;
  resetsAt: string;
  windowLabel: string;
  plan: string;
}
export interface DashboardState {
  providers: ProviderSnapshot[];
  settings: Settings;
  refreshedAt: string;
  version: string;
}
export interface DashboardAPI {
  getState(): Promise<DashboardState>;
  refresh(): Promise<DashboardState>;
  updateSettings(patch: Partial<Settings>): Promise<DashboardState>;
  saveManualUsage(usage: ManualUsage): Promise<DashboardState>;
  chooseDirectory(provider: 'codex' | 'claude'): Promise<string | null>;
  exportData(): Promise<boolean>;
  openExternal(target: 'codex' | 'claude' | 'cursor' | 'gemini' | 'github'): Promise<void>;
  showDashboard(): Promise<void>;
  onState(callback: (state: DashboardState) => void): () => void;
}
declare global {
  interface Window {
    codexDashboard?: DashboardAPI;
  }
}
