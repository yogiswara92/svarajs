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
├── channels/      # Web, Telegram, WhatsApp
├── rag/           # Document loading, chunking, retrieval
├── memory/        # Conversation history
├── tools/         # Tool definition & registry
├── database/      # SQLite wrapper
├── cli/           # CLI commands
└── types.ts       # Public API types
```

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

Currently minimal test suite. Before submitting:

```bash
npm run typecheck
npm run build
```

If adding features:
- Test locally with `npm run dev`
- Consider adding tests in `src/__tests__/`

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
