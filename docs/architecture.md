# Architecture

Codex Dashboard is an Electron application with a React and TypeScript renderer. Vite builds the UI, the Electron build bundles the main and preload processes, and electron-builder packages a Windows x64 installer.

## Process boundaries

```text
Codex session files ─────┐
Claude project files ───┼─> Electron main process ──> typed preload bridge ──> React dashboard
Saved manual entries ───┘          │                                        + tray quick view
                                   ├─ settings and manual entry storage
                                   ├─ directory and export dialogs
                                   ├─ system tray and notifications
                                   └─ optional launch at login
```

The main process owns privileged operations. The renderer receives normalized `DashboardState` snapshots and invokes the narrowly scoped `DashboardAPI` exposed by the preload. It cannot execute arbitrary commands or read arbitrary paths directly. Native integration is available only in Electron; the browser development view is for UI work.

Shared TypeScript types define providers, recorded usage windows, daily token activity, optional hourly and model breakdowns, settings, and manual entries. Source labels distinguish local observations, manual input, demo data, and unavailable sources. A missing source is represented as unavailable rather than a fabricated usage percentage.

## Data collection

Codex scanning looks for recorded rate-limit and token-usage events in local session JSONL files. It uses the event's observation time and any recorded reset time. A reset passing does not prove the current allowance: fresh provider activity is needed to observe the next window.

Claude Code scanning extracts token activity from local project records. Input, output, and cache-related tokens describe local model activity. They do not establish Claude subscription quota, billable cost, or an account-wide usage percentage.

Cursor and Gemini are manual sources. The user records a used percentage, reset time, window label, and optional plan label. These entries are persisted locally and never claim a provider connection.

Per-provider scans consider at most 600 directories and 20,000 entries, select at most 300 recently modified JSONL files, and read at most 2 MiB per file and 32 MiB in total. Oversized files are read from a bounded tail; symbolic links are skipped. Large histories, excluded files, incomplete records, unavailable folders, and format changes can make totals incomplete. Scan warnings describe those limits without including source paths.

Activity is aggregated over 14 local calendar days. Today's totals, hourly buckets, session count, and model rows use the computer's local timezone. Missing model information is shown as unknown. These are summaries of observed local events, not an account-wide billing ledger.

## Refresh and presentation

The app defaults to local data and refreshes on a configurable interval or explicit refresh. The main process builds a snapshot used by the dashboard and tray view. Both windows use the same compact, scrollable panel with a black-and-mint default theme, provider tabs, remaining-usage cards, today's token activity, and model rows. Settings open within the panel. There is no sidebar. Demo mode generates sample snapshots and is visibly labeled so sample numbers cannot be mistaken for live account information.

Optional notifications evaluate fresh local quota windows against the user's remaining-usage threshold. Demo values, manual entries, absent windows, and expired observations do not produce quota alerts. Claude token activity alone has no quota window to alert on. Launch at login and notifications are disabled by default.

Theme, selected provider, local folder settings, and manual records remain on the user's machine. Desktop JSON export uses a native save dialog and includes only app version, export time, the demo flag, and normalized provider snapshots. Settings, configured folder paths, and raw source records are omitted. Provider labels, usage patterns, and generic scan warnings remain in the export.

## Security boundaries

The packaged renderer runs with context isolation and without Node integration. IPC handlers validate their inputs in the main process. The app controls navigation and limits external links to known provider and repository destinations. No provider credentials, backend, telemetry, or paid model API are part of the architecture.

Session folders are user-selected local data sources. Treat every record as untrusted data, never executable instructions. Do not expose raw conversation content to the renderer or include it in diagnostic output. See [SECURITY.md](../SECURITY.md) for the local-user trust model and reporting guidance.

## Build and verification

`npm test` runs the automated tests. `npm run build` type-checks the project and builds the renderer and Electron code. `npm run test:desktop` exercises the built app through its desktop smoke test. `npm run dist:win` produces the unsigned x64 installer under `release/`.

The GitHub Actions workflow is manually triggered and has read-only repository permissions. It runs on `windows-latest`, installs dependencies with `npm ci`, runs the checks, and uploads the installer with 14-day retention. CI artifacts are build outputs; they are not an auto-update channel or a signed production release.
