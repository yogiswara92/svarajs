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

- **Photos and documents over Telegram.** The bot used to drop every message without text (photos, files) in silence.
  It now downloads them (up to Telegram's 20 MB bot limit) into `uploads/telegram/<chat>/`, uses the caption as the
  message, and tells the agent where the file is so its tools can read it. Images are also shown to the model directly
  when it can see them (`llm.vision`, automatic for GPT-4o, Claude, Gemini and other known vision models; override in
  Settings > AI Provider). Voice, video, stickers and other media get a short "I can't read that yet" reply instead of silence.
- `dbPath` agent option (default `./data/<name>.db`; `':memory:'` for throwaway agents and tests).
- **Main agent as orchestrator.** `list_agents` and `ask_agent` let the main agent delegate to its sibling agents and
  combine their replies. Per-agent on/off switch, timeouts, rate and concurrency limits, replies treated as data, a
  "Team activity" list on the Agents page, and no calls from siblings or delegated sub-agents (no chaining).
- **Node.js 20 from the dashboard.** Settings > Capabilities can install a private Node.js 20 for the agent (downloaded from
  nodejs.org and checked against its published SHA-256, kept in `.svara/node`, no root, nothing else on the server changes),
  rebuild the native modules for it (with a database smoke test and automatic rollback), and `svara start` then runs on it
  after a restart. If the private Node cannot run the installed native modules it is not used and the agent stays up.
- "Restart runtime" now exits with a restart code when something already supervises the process (systemd, pm2, the Node
  wrapper, or the parent of a sibling agent) instead of spawning a competing copy.

### Fixed
- `crypto is not defined` on Node 18 (chat, web channel, approvals, delegation, cron). A test now fails if a source file
  uses `crypto.*` without importing it.
- **Server crash on Node 18 when opening Settings > Capabilities.** The page checked for Playwright by importing it, and on Node < 20 Playwright calls `process.exit(1)`, taking the whole runtime down (a 502, then a crash loop). Playwright is now never imported on an unsupported Node: the browser tool reports a clear "needs Node.js 20" message, and Capabilities shows it instead of an install button.
- The dashboard works behind a path prefix (relative asset base, API calls resolve against the page path).

### Security
- `GET /api/config` no longer returns dashboard password hashes; the shared token is shown as `[set]`.
- Saving the API settings form can no longer drop or expose dashboard accounts.
