# Security and privacy

Codex Dashboard is a local Windows application. It reads usage metadata from selected local Codex and Claude Code JSONL folders and stores app preferences and manual usage entries in Electron's per-user application data directory.

## Data boundaries

- Provider authentication stays with the provider's own application or CLI. The dashboard does not request API keys, passwords, session cookies, or OAuth tokens.
- Local session files can contain sensitive conversation content. The scanner must read records to identify usage events, but only extracted usage metadata is sent to the renderer. Raw conversations are not displayed, copied into app settings, or included in usage exports.
- The app has no external backend or telemetry. Opening a provider or repository link launches the user's browser and is subject to that website's own privacy policy.
- Desktop JSON exports are written only after the user chooses a destination. They include normalized provider summaries, warnings, manual labels, the app version, export time, and demo flag. They omit settings and configured folder paths. Review usage patterns and user-entered labels before sharing them.
- Preferences and usage summaries are not encrypted by the app. They inherit the permissions of the Windows user profile. This app does not protect data from other software running as the same user.

## Desktop security model

The renderer runs in a sandbox with context isolation and no Node integration. A preload bridge exposes specific dashboard operations rather than arbitrary filesystem, shell, or network access. The main process owns local scanning, persistence, native dialogs, notifications, and launch-at-login integration. It validates IPC inputs and verifies requests came from the app's own main frames. Navigation, new windows, downloads, and browser permission requests are blocked; external links are limited to known destinations and open in the user's browser.

Local files are untrusted input. Scans are bounded, and malformed or unsupported records should be ignored or surfaced as a warning without preventing the rest of the dashboard from opening. File formats may change independently of this project; unusual values should not be treated as proof of a live account limit.

## Distribution

The initial Windows installer is unsigned. The app does not install updates automatically. Only run builds produced from source you trust, and inspect the associated workflow result when downloading a CI artifact.

## Reporting a problem

Report security issues privately to the repository owner, **Haochihaochi**, through an established private contact or GitHub's private vulnerability reporting feature if it is enabled. Do not put credentials, raw session logs, personal paths, or conversation content in a public issue. A useful report includes the affected version, a minimal reproduction using synthetic records, and the expected security boundary.
