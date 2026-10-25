# Codex Dashboard

A Windows desktop dashboard that puts AI usage in your system tray. Check current Codex account limits, local token activity, and manually tracked Cursor and Gemini limits.

An independent, original project inspired by [CodexBar](https://codexbar.app/?lang=en). No upstream code or assets are included. This project is not affiliated with CodexBar, OpenAI, Anthropic, Cursor, or Google.

## What it tracks

| Provider    | Source                              | Available information                                                                    |
| ----------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| Codex       | Existing Codex sign-in + local logs | Account rate-limit windows, reset credits when reported, and local token/model activity  |
| Claude Code | Local project JSONL files           | Recorded token activity and sessions; **not subscription quota or remaining plan usage** |
| Cursor      | Manual entry                        | A usage percentage, reset time, window name, and optional plan label                     |
| Gemini      | Manual entry                        | A usage percentage, reset time, window name, and optional plan label                     |

The app starts with real account and local activity data. The tray and desktop window share a compact, scrollable black-and-mint layout: provider tabs, remaining-usage cards, today's token chart, and model activity. Hourly activity uses your computer's local timezone; unavailable details stay unreported. Demo mode is an explicit, labeled option for exploring the interface.

It includes automatic refresh, optional low-remaining-usage notifications for fresh Codex quota, opt-in launch at login, theme settings, local folder selection, and JSON export.

| Remaining usage · sample data                                 | Token and model activity · sample data                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| ![Remaining usage panel with sample data](docs/dashboard.png) | ![Hourly token and model activity with sample data](docs/activity.png) |

## Run on Windows

The first release targets Windows x64. The installer is an **unsigned developer build**; Windows may display a publisher or SmartScreen warning. Verify that the download comes from this repository before running it.

**[Download the latest Windows x64 release](https://github.com/Haochihaochi/codex-dashboard/releases/latest)** — sign in to the private repository to download.

To build a fresh installer through GitHub:

1. Open [Build Windows desktop app](https://github.com/Haochihaochi/codex-dashboard/actions/workflows/build.yml) and choose **Run workflow**.
2. After a successful run, download the `Codex-Dashboard-windows-x64` artifact and extract it.
3. Run the `Codex-Dashboard-*-windows-x64.exe` installer and follow the prompts.

Workflow artifacts are retained for 14 days. You can also build the installer locally using the commands below. There is no automatic updater.

Install the official Codex app or native Codex CLI and sign in there with your ChatGPT account. The dashboard detects the installed CLI and uses its existing sign-in. **Account connected** means account quota was fetched successfully; **Local snapshot** means the quota came from local logs instead. Use **Retry connection** after restoring connectivity or signing in through Codex.

In **Settings**, select local data folders if needed. Defaults are `CODEX_HOME` or `%USERPROFILE%\.codex` for Codex, and `%USERPROFILE%\.claude` for Claude Code. A selected `sessions` folder also identifies its parent Codex home. Account quota and local token activity have independent timestamps and can differ across devices.

Version 0.1.0 only read recorded log snapshots and did not connect to an account. Version 0.2.0 adds the account connection. It does not create another OAuth session, copy credentials, force token refreshes, call logout, or delete Codex sign-in files. Codex manages normal renewal. Temporary failures preserve the last successful quota in memory and retry with backoff. Provider-side revocation or a sign-in that Codex cannot renew still requires normal sign-in through Codex.

Closing the dashboard leaves the app in the tray. Use the tray menu to reopen it or quit. Enable notifications and launch at login only if you want them.

## Develop

Use Node.js 24 and npm on Windows.

```powershell
git clone https://github.com/Haochihaochi/codex-dashboard.git
cd codex-dashboard
npm ci
npm run dev
```

```powershell
npm test
npm run build
npm run test:desktop
npm run dist:win
```

The installer is written under `release/`. `npm run dev:web` runs the renderer in a browser for UI development; native tray, filesystem, and account integration require Electron.

The manually triggered Windows workflow installs locked dependencies, runs tests, builds, smoke-tests Electron, packages the installer, and uploads it as an artifact. A workflow existing in the repository does not imply that a build has passed; inspect the run result before downloading.

## Validation

Version 0.2.0 passed 29 tests, TypeScript checking, the production build, and native smoke tests for development Electron and the packaged executable. The [Windows CI build](https://github.com/Haochihaochi/codex-dashboard/actions/runs/40204645046) passed the same pipeline. Tests cover read-only account RPCs, timeout recovery, cached readings and backoff, profile changes, log-cache invalidation, quota parsing, token accounting, and settings validation. The installed app was verified showing **Account connected**, and a real account check succeeded again after restarting the client. A repeated local scan measured 9 ms versus 94 ms for the initial scan on the validation machine; results depend on history size.

The [initial Windows CI run](https://github.com/Haochihaochi/codex-dashboard/actions/runs/37801264987) also passed the full pipeline, including a clean dependency install, tests, production build, installer packaging, and packaged-app smoke checks.

## Data and limitations

- Account quota is fetched by the official Codex subprocess using the user's existing sign-in. No paid inference call, external dashboard backend, or dashboard telemetry is included. The dashboard never reads, stores, or exports provider credentials.
- Local records are observations, not authoritative account billing. They may be missing, old, incomplete, or recorded under another device or profile. The app displays source and freshness information.
- When a recorded reset time passes, the app needs a fresh observation; it does not assume the provider has restored your allowance.
- Available usage-reset credits appear when Codex account services report them. Unknown counts remain unreported; reset credits cannot be consumed by the dashboard.
- Scans are bounded to keep refresh work manageable. Token totals cover 14 local calendar days from the records included in the scan and may omit activity. Today's hourly and model breakdowns are derived from those records. They are not billable cost estimates.
- Unchanged logs reuse a bounded cache of extracted usage fields. Raw conversation records are discarded before caching. Account polls are deduplicated and normally run every two minutes, or at the configured interval when it is longer; manual refresh and wake from sleep request a fresh check.
- Claude Code activity cannot establish a subscription percentage. Cursor and Gemini entries stay manual until you update them.
- Exports contain provider usage summaries, labels, and warnings, along with the app version, export time, and demo flag. Desktop exports omit settings, configured folder paths, and raw conversations. Review usage patterns and manually entered labels before sharing an export.

See [architecture](docs/architecture.md) for the process and data boundaries, and [security](SECURITY.md) for privacy and reporting information.
