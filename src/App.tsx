import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCheck,
  CircleHelp,
  Clock3,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  Monitor,
  Moon,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Terminal,
  X,
} from 'lucide-react';
import { api, isDesktop } from './lib/api';
import type {
  DashboardState,
  ManualUsage,
  ProviderId,
  ProviderSnapshot,
  Settings,
  UsageWindow,
} from './shared/types';

const providerNames = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor', gemini: 'Gemini' };
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const percent = (value: number) => Math.max(0, Math.min(100, value));
const remaining = (window: UsageWindow) => Math.round(100 - percent(window.usedPercent));
function timeUntil(date: string | null) {
  if (!date) return 'Reset not reported';
  const minutes = Math.ceil((new Date(date).getTime() - Date.now()) / 60_000);
  if (!Number.isFinite(minutes)) return 'Reset not reported';
  if (minutes <= 0) return 'Refresh to check reset';
  if (minutes >= 1440)
    return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function age(date: string | null) {
  if (!date) return 'No data yet';
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60_000));
  return minutes < 1
    ? 'Just now'
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
function ProviderIcon({
  id,
  size = 'normal',
}: {
  id: ProviderId;
  size?: 'normal' | 'small' | 'large';
}) {
  return (
    <span className={`provider-icon ${id} ${size}`} aria-hidden="true">
      {id === 'codex' ? (
        <Terminal />
      ) : id === 'claude' ? (
        <span className="claude-mark">✳</span>
      ) : id === 'cursor' ? (
        <span className="cursor-mark">⌘</span>
      ) : (
        <Sparkles />
      )}
    </span>
  );
}
function Brand({ compact: small = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-symbol">
        <Terminal size={21} />
      </span>
      <span>
        codex<span className="brand-subtitle">dashboard</span>
      </span>
      {!small && <span className="brand-beta">BETA</span>}
    </div>
  );
}
function Status({ provider }: { provider: ProviderSnapshot }) {
  const text =
    provider.source === 'demo'
      ? 'Demo data'
      : provider.source === 'manual'
        ? 'Manual entry'
        : provider.status === 'connected'
          ? 'Local data'
          : provider.status === 'error'
            ? 'Read error'
            : 'Not connected';
  return (
    <span
      className={`status ${provider.status === 'connected' ? 'good' : provider.status === 'error' ? 'error' : ''}`}
    >
      <span />
      {text}
    </span>
  );
}
function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Activity size={25} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function ManualEditor({
  provider,
  onClose,
  onSave,
}: {
  provider: ProviderSnapshot;
  onClose: () => void;
  onSave: (usage: ManualUsage) => Promise<void>;
}) {
  const modalRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const [used, setUsed] = useState(provider.windows[0]?.usedPercent ?? 0);
  const [label, setLabel] = useState(provider.windows[0]?.label ?? 'Monthly');
  const [plan, setPlan] = useState(provider.plan ?? '');
  const [reset, setReset] = useState(() => {
    const value = provider.windows[0]?.resetsAt;
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const element = previousFocus.current;
    modalRef.current?.querySelector('input')?.focus();
    return () => element?.focus();
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
      if (event.key !== 'Tab') return;
      const focusable = modalRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
      );
      if (!focusable?.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || !modalRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      }
      if (
        !event.shiftKey &&
        (document.activeElement === last || !modalRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [busy, onClose]);
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-heading"
      >
        <button
          className="icon-button modal-close"
          onClick={onClose}
          disabled={busy}
          aria-label="Close manual usage editor"
        >
          <X size={18} />
        </button>
        <ProviderIcon id={provider.id} size="large" />
        <h2 id="manual-heading">Update {provider.name} usage</h2>
        <p>Enter the usage shown in your provider account. This is saved as a manual entry.</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            try {
              await onSave({
                provider: provider.id,
                usedPercent: used,
                resetsAt: reset ? new Date(reset).toISOString() : '',
                windowLabel: label.trim() || 'Usage',
                plan: plan.trim(),
              });
              onClose();
            } catch (err) {
              setError(String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Usage consumed{' '}
            <span className="input-suffix">
              <input
                autoFocus
                type="number"
                min="0"
                max="100"
                step="1"
                required
                value={used}
                onChange={(event) => setUsed(Number(event.target.value))}
              />
              <span>%</span>
            </span>
          </label>
          <div className="form-columns">
            <label>
              Usage window
              <input
                value={label}
                maxLength={40}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Monthly"
              />
            </label>
            <label>
              Plan
              <input
                value={plan}
                maxLength={60}
                onChange={(event) => setPlan(event.target.value)}
                placeholder="e.g. Pro"
              />
            </label>
          </div>
          <label>
            Next reset <span className="optional">optional</span>
            <input
              type="datetime-local"
              value={reset}
              onChange={(event) => setReset(event.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy} className="button primary">
            {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Save usage
          </button>
        </form>
      </section>
    </div>
  );
}

function SettingsPage({
  state,
  update,
  action,
}: {
  state: DashboardState;
  update: (patch: Partial<Settings>) => Promise<void>;
  action: (operation: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const settings = state.settings;
  return (
    <div className="settings-content">
      <section className="panel settings-panel">
        <div className="panel-heading">
          <div>
            <h2>Make it yours</h2>
            <p>A quiet home for your AI usage.</p>
          </div>
          <Settings2 size={20} />
        </div>
        <div className="setting-row">
          <div>
            <strong>Appearance</strong>
            <p>Choose how your dashboard looks.</p>
          </div>
          <div className="theme-picker">
            {(['dark', 'light', 'system'] as const).map((theme) => (
              <button
                key={theme}
                aria-label={`${theme} theme`}
                aria-pressed={settings.theme === theme}
                className={settings.theme === theme ? 'active' : ''}
                onClick={() => void update({ theme })}
              >
                {theme === 'dark' ? (
                  <Moon size={16} />
                ) : theme === 'light' ? (
                  <Sun size={16} />
                ) : (
                  <Monitor size={16} />
                )}
                <span>{theme}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>Refresh interval</strong>
            <p>Check your local data automatically.</p>
          </div>
          <select
            aria-label="Refresh interval"
            value={settings.refreshSeconds}
            onChange={(event) => void update({ refreshSeconds: Number(event.target.value) })}
          >
            <option value={30}>Every 30 seconds</option>
            <option value={60}>Every minute</option>
            <option value={300}>Every 5 minutes</option>
            <option value={900}>Every 15 minutes</option>
          </select>
        </div>
        <Toggle
          title="Launch at login"
          description={
            isDesktop
              ? 'Keep your usage one click away in the system tray.'
              : 'Available in the Windows desktop app.'
          }
          checked={settings.launchAtLogin}
          disabled={!isDesktop}
          onChange={(value) => void update({ launchAtLogin: value })}
        />
        <Toggle
          title="Low-usage notifications"
          description={
            isDesktop
              ? 'Get a heads-up when a usage window is running low.'
              : 'Available in the Windows desktop app.'
          }
          checked={settings.notifications}
          disabled={!isDesktop}
          onChange={(value) => void update({ notifications: value })}
        />
        {settings.notifications && (
          <div className="setting-row">
            <div>
              <strong>Notify me when remaining usage reaches</strong>
            </div>
            <select
              aria-label="Notification threshold"
              value={settings.alertThreshold}
              onChange={(event) => void update({ alertThreshold: Number(event.target.value) })}
            >
              {[10, 20, 30, 50].map((value) => (
                <option key={value} value={value}>
                  {value}% remaining
                </option>
              ))}
            </select>
          </div>
        )}
      </section>
      <section className="panel settings-panel">
        <div className="panel-heading">
          <div>
            <h2>Local data sources</h2>
            <p>Session files stay on your computer.</p>
          </div>
          <ShieldCheck size={21} />
        </div>
        {(['codex', 'claude'] as const).map((id) => (
          <div className="path-setting" key={id}>
            <label htmlFor={`${id}-path`}>
              <ProviderIcon id={id} size="small" />
              {providerNames[id]} directory
            </label>
            <div className="path-field">
              <input
                key={settings[`${id}Path`]}
                id={`${id}-path`}
                placeholder={id === 'codex' ? 'Automatic · ~/.codex' : 'Automatic · ~/.claude'}
                defaultValue={settings[`${id}Path`]}
                onBlur={(event) => {
                  if (event.target.value !== settings[`${id}Path`])
                    void update({ [`${id}Path`]: event.target.value });
                }}
                disabled={!isDesktop}
              />
              <button
                className="button secondary"
                disabled={!isDesktop}
                onClick={() =>
                  void action(async () => {
                    const path = await api.chooseDirectory(id);
                    if (path) await update({ [`${id}Path`]: path });
                  })
                }
              >
                <FolderOpen size={16} />
                Browse
              </button>
            </div>
          </div>
        ))}
        <div className="source-note">
          <ShieldCheck size={16} />
          <span>
            No API keys or account passwords needed. Codex and Claude Code activity comes from local
            session files. Cursor and Gemini usage is entered manually.
          </span>
        </div>
      </section>
      <section className="panel settings-panel">
        <div className="panel-heading">
          <div>
            <h2>Data & preview</h2>
            <p>You are always in control of what appears here.</p>
          </div>
        </div>
        <Toggle
          title="Demo mode"
          description="Explore the dashboard with clearly labeled sample data."
          checked={settings.demoMode}
          onChange={(value) => void update({ demoMode: value })}
        />
        <div className="setting-row">
          <div>
            <strong>Export usage data</strong>
            <p>Save the current dashboard snapshot as a JSON file.</p>
          </div>
          <button
            className="button secondary"
            onClick={() => void action(() => api.exportData(), 'Export complete')}
          >
            <ArrowDownToLine size={16} />
            Export JSON
          </button>
        </div>
      </section>
      <p className="settings-version">
        Codex Dashboard {state.version} <span>·</span> Independent desktop app
      </p>
    </div>
  );
}
function Toggle({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <button
        type="button"
        className={`toggle ${checked ? 'on' : ''}`}
        role="switch"
        aria-checked={checked}
        aria-label={title}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

function resetDate(value: string | null) {
  return value && Number.isFinite(new Date(value).getTime())
    ? new Date(value).toLocaleString(undefined, {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      })
    : 'Not reported';
}
function LimitCard({ usage, provider }: { usage: UsageWindow; provider: ProviderSnapshot }) {
  const left = remaining(usage);
  const expired = usage.resetsAt !== null && new Date(usage.resetsAt).getTime() <= Date.now();
  return (
    <article className={`usage-card card ${left <= 20 ? 'low' : ''}`}>
      <div className="usage-card-top">
        <h3>
          {provider.name} <span>·</span> {usage.label}
        </h3>
        <div className="large-percent">
          <strong>{left}</strong>
          <span>% left</span>
        </div>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={`${usage.label} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={left}
      >
        <div style={{ width: `${left}%` }} />
      </div>
      <div className="usage-card-reset">
        <span>
          <Clock3 size={14} />
          {timeUntil(usage.resetsAt).replace('Resets in ', '')}
        </span>
        <span>{resetDate(usage.resetsAt)}</span>
      </div>
      {usage.observedAt && <div className="quota-age">Last reported {age(usage.observedAt)}</div>}
      {expired && (
        <div className="expired-note">
          {provider.source === 'manual'
            ? 'Reset time passed. Update your manual entry to confirm current usage.'
            : 'Reset time passed. These are the last reported limits.'}
        </div>
      )}
    </article>
  );
}
function TodayCard({ provider }: { provider: ProviderSnapshot }) {
  const date = new Date();
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const today = provider.today ?? provider.daily.find((day) => day.date === key);
  const hourly = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    totalTokens: provider.hourly?.find((item) => item.hour === hour)?.totalTokens ?? 0,
  }));
  const max = Math.max(...hourly.map((item) => item.totalTokens), 1);
  return (
    <section className="tokens-card card">
      <div className="token-head">
        <div className="token-total">
          <strong>{today ? compact.format(today.totalTokens) : '—'}</strong>
          <span>tokens</span>
        </div>
        <div className="token-sessions">
          <strong>
            {provider.sessionCountToday === undefined
              ? 'Not reported'
              : `${provider.sessionCountToday} session${provider.sessionCountToday === 1 ? '' : 's'}`}
          </strong>
          <span>{date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
        </div>
      </div>
      <div
        className="hour-chart"
        role="img"
        aria-label={
          provider.hourly?.length
            ? `Hourly tokens today: ${hourly.map((hour) => `${hour.hour}:00 ${hour.totalTokens}`).join(', ')}`
            : 'No hourly activity reported'
        }
      >
        {hourly.map((hour) => (
          <div
            key={hour.hour}
            className={`hour-bar ${hour.totalTokens > 0 ? 'has-usage' : ''}`}
            style={{
              height: `${Math.max(hour.totalTokens > 0 ? 8 : 4, (hour.totalTokens / max) * 88)}px`,
              opacity: hour.totalTokens > 0 ? 0.42 + (hour.totalTokens / max) * 0.58 : 1,
            }}
          >
            <span className="hour-tooltip">
              {String(hour.hour).padStart(2, '0')}:00 · {compact.format(hour.totalTokens)}
            </span>
          </div>
        ))}
      </div>
      <div className="hour-axis">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
      <div className="token-breakdown">
        {[
          { label: 'INPUT', value: today?.inputTokens },
          { label: 'CACHED¹', value: today?.cachedTokens },
          { label: 'OUTPUT', value: today?.outputTokens },
        ].map((item) => (
          <div key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value === undefined ? '—' : compact.format(item.value)}</strong>
          </div>
        ))}
      </div>
      <div className="token-note">
        <p>
          {provider.source === 'demo' ? 'Sample records' : 'Local records'} ·{' '}
          {provider.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone}
        </p>
        <p>
          {today
            ? '¹ Cached tokens are included in input. Reasoning is included in output when reported.'
            : 'No token activity reported for today. Local sessions appear after a refresh.'}
        </p>
        {today && !provider.hourly?.length && <p>Hourly breakdown not reported.</p>}
      </div>
    </section>
  );
}
function AgentCard({ provider }: { provider: ProviderSnapshot }) {
  const models = provider.models || [];
  return (
    <section className="agent-card card">
      <header>
        <span>
          <Terminal size={18} />
          <strong>{provider.id === 'codex' ? 'OpenAI Codex' : provider.name}</strong>
        </span>
        <span>{models.length} observed</span>
      </header>
      {models.length ? (
        models.map((model) => (
          <div className="model-row" key={model.model}>
            <div>
              <strong>{model.model}</strong>
              <span>Local sessions</span>
            </div>
            <div>
              <strong>{compact.format(model.totalTokens)} tokens</strong>
              <span>
                {model.sessionCount} session{model.sessionCount === 1 ? '' : 's'}
              </span>
            </div>
          </div>
        ))
      ) : (
        <div className="agent-empty">
          {provider.model ? (
            <>
              <strong>{provider.model}</strong>
              <p>Model token breakdown not reported.</p>
            </>
          ) : (
            <>
              <p>No models observed yet.</p>
              <span>Start a local session to see activity here.</span>
            </>
          )}
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [page, setPage] = useState<'dashboard' | 'settings'>('dashboard');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<ProviderSnapshot | null>(null);
  const [, tick] = useState(0);
  const tray = new URLSearchParams(window.location.search).get('tray') === '1';
  useEffect(() => {
    let mounted = true;
    api
      .getState()
      .then((value) => {
        if (mounted) setState(value);
      })
      .catch((err) => {
        if (mounted) setError(String(err));
      });
    const unsubscribe = api.onState((value) => {
      if (mounted) setState(value);
    });
    const interval = setInterval(() => tick((value) => value + 1), 30_000);
    return () => {
      mounted = false;
      unsubscribe();
      clearInterval(interval);
    };
  }, []);
  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme =
        state?.settings.theme === 'system'
          ? query.matches
            ? 'dark'
            : 'light'
          : (state?.settings.theme ?? 'dark');
    };
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [state?.settings.theme]);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    if (isDesktop || !state) return;
    const interval = setInterval(() => {
      api
        .refresh()
        .then(setState)
        .catch((err) => setError(String(err)));
    }, state.settings.refreshSeconds * 1000);
    return () => clearInterval(interval);
  }, [state?.settings.refreshSeconds]);
  async function action(operation: () => Promise<unknown>, success?: string) {
    setError('');
    try {
      const result = await operation();
      if (success && result !== false) setNotice(success);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  async function update(patch: Partial<Settings>) {
    await action(async () => setState(await api.updateSettings(patch)));
  }
  async function refresh() {
    if (busy) return;
    setBusy(true);
    await action(async () => setState(await api.refresh()), 'Usage refreshed');
    setBusy(false);
  }
  if (!state)
    return (
      <main className="loading-screen">
        <Brand />
        <LoaderCircle className="spin" size={26} />
        <p>{error || 'Reading your local usage…'}</p>
        {error && (
          <button
            className="button primary"
            onClick={() => void action(async () => setState(await api.getState()))}
          >
            Try again
          </button>
        )}
      </main>
    );
  const selected =
    state.providers.find((provider) => provider.id === state.settings.selectedProvider) ||
    state.providers[0];
  if (!selected)
    return (
      <main className="loading-screen">
        <Brand />
        <p>No providers were returned.</p>
        <button className="button primary" onClick={() => void refresh()}>
          Refresh
        </button>
      </main>
    );
  const isManual = selected.id === 'cursor' || selected.id === 'gemini';
  return (
    <main className={`dashboard ${tray ? 'tray' : ''}`}>
      <header className="app-header">
        <div className="app-logo" aria-hidden="true">
          <Activity size={28} strokeWidth={2.5} />
        </div>
        <div className="app-title">
          <h1>Codex Dashboard</h1>
          <Status provider={selected} />
        </div>
        {selected.plan && <span className="plan-pill">{selected.plan}</span>}
        <button
          className={`icon-button settings-button ${page === 'settings' ? 'active' : ''}`}
          aria-label={page === 'settings' ? 'Back to dashboard' : 'Open settings'}
          title={page === 'settings' ? 'Back to dashboard' : 'Settings'}
          onClick={() => setPage(page === 'settings' ? 'dashboard' : 'settings')}
        >
          {page === 'settings' ? <X size={21} /> : <Settings2 size={21} />}
        </button>
      </header>
      {state.settings.demoMode && (
        <div className="demo-banner">
          <Sparkles size={14} />
          <span>
            <strong>{isDesktop ? 'Demo mode' : 'Browser preview'}</strong> · Sample data
          </span>
          <button onClick={() => void update({ demoMode: false })}>Exit demo</button>
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>
            <X size={15} />
          </button>
        </div>
      )}
      {page === 'settings' ? (
        <>
          <div className="section-heading">
            <h2>PREFERENCES</h2>
            <button className="text-button" onClick={() => setPage('dashboard')}>
              Back to usage <ArrowRight size={13} />
            </button>
          </div>
          <SettingsPage state={state} update={update} action={action} />
        </>
      ) : (
        <>
          <nav className="provider-tabs" aria-label="Provider">
            {state.providers.map((provider) => (
              <button
                key={provider.id}
                aria-pressed={selected.id === provider.id}
                className={selected.id === provider.id ? 'active' : ''}
                onClick={() => void update({ selectedProvider: provider.id })}
              >
                <ProviderIcon id={provider.id} size="small" />
                <span>{provider.id === 'claude' ? 'Claude' : provider.name}</span>
              </button>
            ))}
          </nav>
          <section className="remaining-section">
            <div className="section-heading">
              <h2>REMAINING USAGE</h2>
              <span>
                {selected.source === 'demo'
                  ? 'SAMPLE ACCOUNT'
                  : selected.source === 'manual'
                    ? 'MANUAL ENTRY'
                    : 'LOCAL SNAPSHOT'}
              </span>
            </div>
            {selected.windows.length ? (
              selected.windows.map((usage, index) => (
                <LimitCard key={`${usage.label}-${index}`} usage={usage} provider={selected} />
              ))
            ) : (
              <div className="card setup-card">
                <Empty
                  title={
                    selected.status === 'connected'
                      ? 'Limits not reported'
                      : `Connect ${selected.name}`
                  }
                >
                  <>{selected.message}</>
                </Empty>
                <button
                  className="button secondary"
                  onClick={() => (isManual ? setEditor(selected) : setPage('settings'))}
                >
                  {isManual ? 'Enter usage manually' : 'Configure local source'}
                  <ArrowRight size={14} />
                </button>
              </div>
            )}
            {selected.resetCredits?.length ? (
              <article className="card reset-card">
                <div className="reset-card-heading">
                  <span>
                    <RefreshCw size={17} />
                    <strong>Available usage resets</strong>
                  </span>
                  <span>
                    <strong>
                      {selected.resetCredits.reduce((sum, credit) => sum + credit.count, 0)}
                    </strong>{' '}
                    available
                  </span>
                </div>
                {selected.resetCredits.map((credit, index) => (
                  <div className="reset-credit" key={index}>
                    <div>
                      <strong>
                        {credit.count} reset{credit.count === 1 ? '' : 's'}
                      </strong>
                      <span>
                        {credit.expiresAt
                          ? timeUntil(credit.expiresAt).replace('Resets in ', 'Expires in ')
                          : 'Expiry not reported'}
                      </span>
                    </div>
                    <span>
                      {credit.expiresAt
                        ? new Date(credit.expiresAt).toLocaleDateString(undefined, {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })
                        : '—'}
                    </span>
                  </div>
                ))}
              </article>
            ) : (
              <div className="reset-unavailable">
                <RefreshCw size={12} />
                <span>Usage reset credits are not reported by this source.</span>
              </div>
            )}
            {isManual && selected.windows.length > 0 && (
              <button className="text-button manual-update" onClick={() => setEditor(selected)}>
                Update manual usage <ArrowRight size={13} />
              </button>
            )}
            {selected.warnings.length > 0 && (
              <div className="source-warnings">
                {selected.warnings.map((warning, index) => (
                  <p key={index}>
                    <CircleHelp size={13} />
                    {warning}
                  </p>
                ))}
              </div>
            )}
          </section>
          <section>
            <div className="section-heading tokens-heading">
              <h2>
                Today’s tokens <span>(Estimated)</span>
              </h2>
            </div>
            <TodayCard provider={selected} />
          </section>
          <section>
            <div className="section-heading">
              <h2>AI AGENT</h2>
              <span>{selected.source === 'demo' ? 'SAMPLE ACTIVITY' : 'LOCAL ACTIVITY'}</span>
            </div>
            <AgentCard provider={selected} />
          </section>
        </>
      )}
      <footer className="app-footer">
        <div>
          <span>
            Synced{' '}
            {new Date(state.refreshedAt).toLocaleTimeString(undefined, {
              hour12: false,
              timeZoneName: 'short',
            })}
          </span>
          <small>
            Auto-refresh · local{' '}
            {state.settings.refreshSeconds < 60
              ? `${state.settings.refreshSeconds}s`
              : `${state.settings.refreshSeconds / 60}m`}
          </small>
        </div>
        <div className="footer-actions">
          {tray && (
            <button
              className="icon-button"
              aria-label="Open full dashboard"
              title="Open dashboard"
              onClick={() => void action(() => api.showDashboard())}
            >
              <Monitor size={18} />
            </button>
          )}
          <button
            className="icon-button"
            aria-label={`Open ${selected.name} account`}
            title="Open provider account"
            onClick={() => void action(() => api.openExternal(selected.id))}
          >
            <ExternalLink size={17} />
          </button>
          <button
            className="icon-button refresh-button"
            disabled={busy}
            aria-label="Refresh usage"
            title="Refresh usage"
            onClick={() => void refresh()}
          >
            <RefreshCw size={21} className={busy ? 'spin' : ''} />
          </button>
        </div>
      </footer>
      {notice && (
        <div className="toast" role="status">
          <CheckCheck size={17} />
          {notice}
        </div>
      )}
      {editor && (
        <ManualEditor
          provider={editor}
          onClose={() => setEditor(null)}
          onSave={async (usage) => {
            setState(await api.saveManualUsage(usage));
            setNotice(
              state.settings.demoMode
                ? 'Saved. Exit demo mode to see your entry.'
                : 'Manual usage updated',
            );
          }}
        />
      )}
    </main>
  );
}
