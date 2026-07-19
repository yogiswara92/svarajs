# Security Model

SvaraJS ships opt-in tools that give an agent real capabilities on your
machine: running shell commands (`terminal_exec`), reading/writing files
(`file_read`/`file_write`), fetching arbitrary URLs (`web_fetch`), and
controlling a headless browser (`browser_*`). None of these are registered
by default - you enable them explicitly, per agent.

## The honest boundary

**Nothing inside the SvaraJS process is a real security sandbox.** The
`ApprovalGate` (`src/security/approval.ts`) and the filesystem's
`validateWithinDir` (`src/security/pathGuard.ts`) are heuristics:

- `ApprovalGate` pattern-matches command strings against a known-dangerous
  list (`rm -rf`, `sudo`, `mkfs`, fork bombs, `curl | sh`, ...), after
  unfolding common obfuscation tricks (`${IFS}` used in place of a space).
  It can still be bypassed by a sufficiently obfuscated or novel command an
  LLM might construct - it is a speed bump for accidental damage, not a
  defense against an adversarial or compromised model.
- `validateWithinDir` stops simple `../` path traversal. It does not stop a
  command run via `terminal_exec` from reading or writing anywhere the
  underlying OS user can - filesystem confinement only applies to the
  dedicated `file_read`/`file_write`/`list_files` tools, not to arbitrary
  shell commands.
- `skills/guard.ts` and `memory/learningFiles.ts` scan content (agent-created
  skills, MEMORY.md/USER.md entries) for destructive/exfiltration patterns
  before persisting it - the same class of heuristic, with the same limits.
  Content is only as safe as the pattern list is comprehensive.

If an agent with `terminal_exec` enabled is given untrusted instructions
(e.g. content from a webpage fetched by `web_fetch`, or a message from an
untrusted user), treat it as if that content could run arbitrary commands
as your OS user - because, heuristics aside, it can.

## Real isolation

The only real boundary is the operating system. Two ways to get one:

1. **`backend: 'docker'`** on `createTerminalTool()` - commands run via
   `docker exec` inside an already-running container instead of the host
   process. Give that container only the filesystem/network access you're
   comfortable an agent having.
   ```ts
   agent.addTool(createTerminalTool({ backend: 'docker', dockerContainer: 'svara-sandbox' }));
   ```
2. **Run the whole SvaraJS process itself inside a container** (or VM) with
   restricted mounts and network egress, so even a fully compromised
   process can't reach anything sensitive on the host.

For the standalone runtime (`svara start`), we recommend running it inside
a container whenever any of `terminal_exec`, `file_write`, or `browser_*`
is enabled - see the deployment notes in the README.

## Credential scoping

Environment variables (API keys, tokens) are passed to `terminal_exec`'s
child process as-is (`process.env`) - a shell command can read them. If an
agent has both `terminal_exec` and access to secrets it shouldn't be able
to exfiltrate, run it under a process/container whose environment has been
trimmed to only what that agent actually needs.

## Secrets at rest (svara.config.json)

Channel tokens, signing secrets, and the dashboard bearer token are
encrypted (AES-256-GCM) before being written to `svara.config.json` by the
dashboard's Settings page or `saveRuntimeConfig()` - values are prefixed
`enc:v1:` on disk. The key lives in `.svara/secrets.key` next to the config
(auto-generated on first save, mode `0600`, gitignored by the standalone
scaffold).

State the boundary honestly: the key sits on the same disk as the file it
protects, so this does **not** defend against an attacker with full
filesystem access on the machine running the assistant. What it does defend
against is the config file leaking *on its own* - an accidental
`git add -f`, a support screenshot, a backup tool that only grabs
`svara.config.json`. If you move a config to a new machine, copy
`.svara/secrets.key` along with it, or the affected secrets will fail to
decrypt (`loadRuntimeConfig` throws with a clear pointer at the key file
rather than silently connecting a channel with an empty token). Configs
written before this feature existed keep loading as plaintext until the
next save re-encrypts them - no migration step needed.

## MCP servers

Connecting an MCP (Model Context Protocol) server, especially a `stdio`-type
one, spawns an arbitrary local process (`command` + `args` you choose) and
gives its tools direct access to the agent's tool-calling loop - the same
blast radius as `terminal_exec`. **This is an operator action, not an
agent-callable tool**: there is no `mcp_connect`-style tool exposed to the
LLM, on purpose - only a human via the dashboard or `svara.config.json` can
add a server. Only connect servers you trust (the official MCP Registry
lists servers from various publishers - vet the `packages`/`remotes` source
before connecting, the same way you'd vet any dependency you `npm install`).
Every value inside an MCP server's `transport.headers` (remote) or
`transport.env` (stdio) is treated as a secret regardless of its key name
(header/variable names are arbitrary - `Authorization`, `X-Api-Key`,
`GITHUB_TOKEN`, ...) - redacted to `[set]` in the dashboard API and
encrypted at rest, the same as channel tokens (see "Secrets at rest" above).

## Reporting a vulnerability

Please open a private security advisory on GitHub
(https://github.com/yogiswara92/svarajs/security/advisories/new) rather
than a public issue. In scope: a way to escape the approval gate's *stated*
guarantees (e.g. a documented-as-blocked pattern that actually runs), a
path-traversal bypass in `validateWithinDir`, or credential exposure beyond
what's documented above. Out of scope: "an LLM can be prompted to call
`terminal_exec` with a dangerous command" - that's the documented trust
model, not a vulnerability in it.
