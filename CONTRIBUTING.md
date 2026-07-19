# Contributing to SvaraJS

Thanks for your interest in contributing! We welcome all contributions such as bug reports, feature requests, documentation improvements, and pull requests.

## Code of Conduct

Be respectful and constructive. We're building a framework for developers, so let's keep the community welcoming.

---

## Getting Started

### 1. Clone & Setup

```bash
git clone https://github.com/yogiswara92/svarajs.git
cd svara
nvm use 20  # or 22
npm install
```

### 2. Development

```bash
npm run dev       # Watch mode for TypeScript
npm run build     # Build for production
npm run typecheck # Type checking
npm test          # Run tests
```

### 3. Project Structure

```
src/
├── core/          # Agent, LLM, types
├── app/           # SvaraApp HTTP wrapper
├── channels/      # Web (+ streaming), Telegram, WhatsApp, Slack, Discord, progress reporter
├── rag/           # Document loading, chunking, retrieval, embedding providers
├── memory/        # Conversation history, context compaction, learning memory (MEMORY.md/USER.md)
├── tools/         # Tool definition & registry
│   └── builtin/   # terminal, filesystem, web, browser, send_file tools (all opt-in)
├── security/      # ApprovalGate, approval queue, path-traversal guard, secrets encryption
├── skills/        # Skill registry + skills_list/skill_view/skill_manage
├── delegation/    # Sub-agent delegation (delegate_task)
├── cron/          # CronScheduler + the cronjob tool (optional deliver-to-channel)
├── mcp/           # McpManager (client, parameter defaults) + official MCP Registry search
├── integrations/  # Svaramind: guided MCP connect + workspace picker on top of mcp/
├── runtime/       # Standalone runtime (svara.config.json → svara start)
├── dashboard/     # Mounts the dashboard SPA + its API routes
├── database/      # SQLite wrapper
├── cli/           # CLI commands
└── types.ts       # Public API types

dashboard/         # Dashboard SPA (Svelte + Vite) - separate npm project, see below
```

**The dashboard is a separate npm project.** It's not part of the main
`tsup` build - run `npm install && npm run build` inside `dashboard/`
directly, or `npm run build:dashboard` from the repo root. `svara start`
serves whatever is in `dashboard/dist/`; if you haven't built it, `/dashboard`
just shows a message telling you to build it - the rest of the runtime
(agent, tools, `/chat`, `/api/*`) works fine either way.

---

## Reporting Issues

**Before opening an issue:**
- Check [existing issues](https://github.com/yogiswara92/svarajs/issues)
- Try the latest dev version: `npm run dev`

**When reporting, include:**
- Clear title + description
- Steps to reproduce
- Expected vs actual behavior
- Node version, OS, environment
- Code snippet (if applicable)

---

## Submitting PRs

### Before You Start

1. **Check existing PRs** to avoid duplicates
2. **Open an issue first** for major changes (discuss approach)
3. **Fork & create a branch:**
   ```bash
   git checkout -b feature/your-feature-name
   ```

### While Developing

- Follow **existing code style** (no strict linter, but be consistent)
- Keep changes **focused & minimal**
- Write clear commit messages (see below)
- Test locally: `npm run build && npm run typecheck`

### Before Submitting PR

1. **Run tests:**
   ```bash
   npm test
   npm run typecheck
   ```

2. **Update docs** if adding/changing public APIs

3. **Commit with clear messages:**
   ```bash
   git commit -m "feat: add support for custom embeddings provider"
   git commit -m "fix: resolve memory leak in vector store"
   git commit -m "docs: improve RAG examples in README"
   ```

4. **Push & open PR:**
   ```bash
   git push origin feature/your-feature-name
   ```

### PR Guidelines

- **Title:** Start with `feat:`, `fix:`, `docs:`, `refactor:`, etc.
- **Description:** What changed and why
- **Link issues:** "Closes #123" in description
- **Keep it focused:** One feature/fix per PR
- **Minimal dependencies:** Discuss before adding packages

---

## Code Style

We follow these patterns (not strict, but consistent):

```ts
// Imports
import { SvaraAgent } from '../core/agent.js';
import type { Tool } from '../types.js';

// Exports
export class MyClass { }
export type { MyType };

// Naming
const myVariable = 'value';     // camelCase
const MY_CONSTANT = 'VALUE';    // UPPER_SNAKE_CASE (rarely used)
class MyClass { }               // PascalCase

// Comments
// Single line for brief explanation
/**
 * Multi-line for public API documentation.
 * Explain what it does, not how.
 */

// Error handling
throw new Error('[@yesvara/svara] Clear error message');

// Async/await
async function load() {
  try {
    return await operation();
  } catch (error) {
    console.error('[SvaraJS] Error message:', error);
    throw error;
  }
}
```

---

## Testing

`vitest` covers the core loop, tools (including all built-in tools), memory
persistence, skills, delegation, cron, and the runtime config loader - see
`src/__tests__/`. Before submitting:

```bash
npm test
npm run typecheck
npm run build
```

If adding a feature, add tests alongside the existing ones in
`src/__tests__/` rather than relying on manual testing with `npm run dev`.
Prefer fakes/stubs over real network calls (see how the LLM adapter, cron
scheduler, and delegate tool tests fake `SvaraAgent`/`LLMAdapter` - no test
in this repo requires a real API key or a running LLM to pass).

---

## Commit Message Format

```
<type>: <subject>

<body (optional)>

<footer (optional)>
```

**Types:**
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation
- `refactor:` - Code restructuring (no behavior change)
- `perf:` - Performance improvement
- `test:` - Test-related
- `chore:` - Dependency updates, build config, etc.

**Examples:**
```
feat: add support for Groq API provider

- Auto-detect model from "groq-" prefix
- Support streaming responses
- Add tests for Groq integration

Closes #45
```

```
fix: resolve memory leak in vector store

The InMemoryVectorStore was not clearing old entries.
Now properly clears when adding > 10k entries.

Fixes #123
```

---

## Release Process

Maintainers only:

```bash
npm version minor  # or patch, major
npm publish
git push origin main --tags
```

---

## Questions?

- **Issues:** [GitHub Issues](https://github.com/yogiswara92/svarajs/issues)
- **Discussions:** [GitHub Discussions](https://github.com/yogiswara92/svarajs/discussions)
- **Email:** yogiswaragheartha@gmail.com / admin@yesvara.com
- **Website:** https://yesvara.com
- **Whatsapp:** [+6285171010456](https://wa.me/6285171010456)
- **LinkedIn:** [Yogiswara Gheartha](https://www.linkedin.com/in/igb-yogiswara-gheartha-st-mmt-969b6b117/)

---

Thanks for contributing to SvaraJS! 
