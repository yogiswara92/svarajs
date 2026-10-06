# Changelog

## 1.3.0

### Added
- **Dashboard login.** Email + password sign-in (scrypt hashes, signed HttpOnly session cookie, rate limiting, CSRF origin
  check). The legacy `dashboard.token` keeps working.
- **First-time setup from the browser.** Create the first account in the dashboard: directly during a 60 minute window after
  boot, or with a one-time code sent to the linked Telegram owner / written to the server log. No SSH needed.
- **Account page** (change password, add and remove people) and the **`svara user add|passwd|remove|list`** CLI.
- **Managed sibling agents.** The Agents page now creates agents that run as supervised child processes of the main
  runtime: started on creation, restored after restarts, restarted on crash, opened under `/a/<name>/` behind the same
  login, loopback-only with a per-start token. Start / Stop / Restart / Log / Delete, up to 5 per runtime
  (`SVARA_MAX_SIBLINGS`).
- New agents can reuse the main agent's AI connection or take their own provider, base URL and API key (encrypted).
- Agent-first sidebar (avatar, name, status).
- `SVARA_HOST` environment variable to bind the server to a specific interface.

### Fixed
- `crypto is not defined` on Node 18 (chat, web channel, approvals, delegation, cron). A test now fails if a source file
  uses `crypto.*` without importing it.
- The dashboard works behind a path prefix (relative asset base, API calls resolve against the page path).

### Security
- `GET /api/config` no longer returns dashboard password hashes; the shared token is shown as `[set]`.
- Saving the API settings form can no longer drop or expose dashboard accounts.
