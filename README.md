<div align="center">
<img src="SvaraJS.png" alt="SvaraJS" width="400">

<!-- # @yesvara/svara -->

**Build AI agents in 15 lines. Ship to production.**

A batteries-included Node.js framework for building agentic AI backends.  
Multi-channel, RAG-ready, and designed for developers who value simplicity.

[![npm version](https://img.shields.io/npm/v/@yesvara/svara?color=0ea5e9&label=npm)](https://www.npmjs.com/package/@yesvara/svara)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://typescriptlang.org)

</div>

---

## Why SvaraJS?

Most AI frameworks make you think about infrastructure. SvaraJS makes you think about your agent.

```ts
import { SvaraApp, SvaraAgent } from '@yesvara/svara';

const app = new SvaraApp();

const agent = new SvaraAgent({
  name: 'Support Bot',
  model: 'gpt-4o-mini',       // provider auto-detected
  knowledge: './docs',         // PDF, MD, TXT, just point to a folder
});

app.route('/chat', agent.handler());
app.listen(3000);
// Done. Your agent handles 1000 conversations.
```

That's it. No pipeline setup. No embedding boilerplate. No webhook configuration.  
**Convention over configuration (like Express, but for AI).**

---

## Features

|||
|---|---|
| **Zero-config LLM** | Pass a model name, provider is auto-detected |
| **Instant RAG** | Point to a folder, documents are indexed automatically |
| **Multi-channel** | WhatsApp, Telegram, and Web from one agent |
| **Tool calling** | Declarative tools with full TypeScript types |
| **Conversation memory** | Automatic per-session history, configurable window |
| **Express-compatible** | `agent.handler()` drops into any existing app |
| **Built-in database** | Persistent SQLite for users, sessions, RAG chunks, and state |
| **RAG per agent** | Each agent has isolated knowledge base, no cross-contamination |
| **RAG persistence** | Vector embeddings stored in SQLite, auto-dedup |
| **User tracking** | Auto-tracks users and sessions with timestamps |
| **CLI included** | `svara new`, `svara dev`, `svara build` |

---

## Quick Start

### 1. Install

```bash
npm install @yesvara/svara
```

### 2. Set your API key

```bash
# .env
OPENAI_API_KEY=sk-...
```

### 3. Create your agent

```ts
// src/index.ts
import 'dotenv/config';
import { SvaraApp, SvaraAgent } from '@yesvara/svara';

const app = new SvaraApp({ cors: true });

const agent = new SvaraAgent({
  name: 'Aria',
  model: 'gpt-4o-mini',
  systemPrompt: 'You are Aria, a helpful and friendly AI assistant.',
});

app.route('/chat', agent.handler());
app.listen(3000);
```

### 4. Run

```bash
npx tsx src/index.ts
```

### 5. Chat

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello! What can you do?",
    "userId": "user-1",
    "sessionId": "user-1-session-1"
  }'
```

```json
{
  "response": "Hi! I'm Aria, your AI assistant...",
  "sessionId": "user-1-session-1",
  "usage": { "totalTokens": 142 }
}
```

The agent automatically tracks users and sessions in the SQLite database.

---

## Supported Models

SvaraJS auto-detects the LLM provider from the model name. No extra config needed.

| Model string | Provider | Env key |
|---|---|---|
| `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo` | OpenAI | `OPENAI_API_KEY` |
| `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-*` | Anthropic | `ANTHROPIC_API_KEY` |
| `llama3`, `mistral`, `gemma`, `phi3` | Ollama (local) | *(none)* |
| `llama-3.1-70b-versatile`, `mixtral-8x7b` | Groq | `GROQ_API_KEY` |

```ts
// Switch models in one line — no other changes needed
const agent = new SvaraAgent({ name: 'Aria', model: 'claude-opus-4-6' });
const agent = new SvaraAgent({ name: 'Aria', model: 'llama3' });         // local
const agent = new SvaraAgent({ name: 'Aria', model: 'gpt-4o-mini' });   // cheap & fast
```

---

## Core Concepts

### SvaraAgent

The central class. Configure once, use everywhere.

```ts
const agent = new SvaraAgent({
  name: 'Support Bot',         // Display name (used in logs & system prompt)
  model: 'gpt-4o-mini',        // LLM model - provider auto-detected
  systemPrompt: 'You are...', // Optional - sensible default based on name
  knowledge: './docs',         // Optional - folder/glob for RAG
  memory: { window: 20 },      // Optional - conversation history window
  tools: [myTool],             // Optional - functions the agent can call
  temperature: 0.7,            // Optional - creativity (0–2)
  verbose: true,               // Optional - detailed logs
});
```

### SvaraApp

A minimal HTTP server. Built on Express, zero config to start.

```ts
const app = new SvaraApp({
  cors: true,           // Allow all origins (or pass a specific origin)
  apiKey: 'secret-key', // Optional bearer token auth
});

app.route('/chat', agent.handler());   // Mount agent on a path
app.use(myMiddleware);                 // Add Express middleware
app.listen(3000);

// Access the raw Express app for advanced config
const expressApp = app.getExpressApp();
```

### Tools (`createTool`)

Give your agent superpowers. The LLM decides when to call each tool.

```ts
import { createTool } from '@yesvara/svara';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get current weather for a city. Use when the user asks about weather.',
  parameters: {
    city: { type: 'string', description: 'City name', required: true },
    units: { type: 'string', description: 'celsius or fahrenheit', enum: ['celsius', 'fahrenheit'] },
  },
  async run({ city, units = 'celsius' }) {
    const data = await fetchWeather(city as string);
    return { temp: data.temp, condition: data.description };
  },
});

agent.addTool(weatherTool);

// Chainable
agent
  .addTool(weatherTool)
  .addTool(emailTool)
  .addTool(databaseTool);
```

### RAG (Knowledge Base)

Point to your documents. The agent reads them automatically.

```ts
const agent = new SvaraAgent({
  name: 'Support Bot',
  model: 'gpt-4o-mini',
  knowledge: './docs',           // folder
  // knowledge: './faqs.pdf',   // single file
  // knowledge: ['./docs', './policies/*.md'], // multiple globs
});

// Or add documents at runtime (hot reload, no restart)
await agent.addKnowledge('./new-policy-2024.pdf');
```

Supported formats: **PDF, Markdown, TXT, DOCX, HTML, JSON**

**RAG Persistence & Per-Agent Isolation:**

Vector embeddings are automatically persisted to SQLite. Each agent has its own isolated knowledge base:

```ts
const supportBot = new SvaraAgent({
  name: 'SupportBot',
  model: 'gpt-4o-mini',
  knowledge: './docs/support',  // Knowledge base 1
});

const salesBot = new SvaraAgent({
  name: 'SalesBot',
  model: 'gpt-4o-mini',
  knowledge: './docs/sales',    // Knowledge base 2
});

await supportBot.start();
await salesBot.start();

// Both agents run simultaneously with isolated RAG:
// - SupportBot only searches in support docs
// - SalesBot only searches in sales docs
// - No cross-contamination, efficient storage
// - Embeddings persist across restarts
// - Duplicate content skipped per agent
```

**How it works:**
- Documents are embedded and stored in SQLite with agent name
- Each agent queries only its own chunks
- Deduplication happens per agent (same content in different agents is OK)
- Perfect for multi-agent systems with different domains

**Accessing Retrieved Documents:**

The `/chat` endpoint returns `retrievedDocuments` showing which knowledge was used:

```ts
const response = await fetch('http://localhost:3000/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: 'What is the pricing?',
    sessionId: 'user-123'
  })
});

const result = await response.json();
// {
//   response: "Our pricing starts at...",
//   retrievedDocuments: [
//     {
//       source: "./docs/pricing.md",
//       score: 0.89,        // relevance (0-1)
//       excerpt: "# Pricing\n\nOur plans start at..."
//     },
//     {
//       source: "./docs/faq.md",
//       score: 0.76,
//       excerpt: "## Is there a free trial?\n\nYes, 14 days..."
//     }
//   ]
// }
```

The `retrievedDocuments` field shows:
- **source**: File path of the matching document
- **score**: Cosine similarity (0-1, higher = more relevant)
- **excerpt**: First 150 characters of the matched chunk

### User & Session Tracking

Every message automatically tracks the user and their session.

```ts
// Send message with userId and sessionId
const result = await agent.process('Help me with my order', {
  userId: 'user-123',
  sessionId: 'user-123-conversation-1'
});

// Database tracks:
// - svara_users: user-123 (first_seen, last_seen, metadata)
// - svara_sessions: session details, linked to user-123
// - svara_messages: conversation history for this session
```

Query user data:

```ts
import { SvaraDB } from '@yesvara/svara';

const db = new SvaraDB('./data/svara.db');

// Get all users
const users = db.query('SELECT * FROM svara_users');

// Get sessions for a user
const sessions = db.query(
  'SELECT * FROM svara_sessions WHERE user_id = ?',
  ['user-123']
);

// Get chat history for a session
const messages = db.query(
  'SELECT * FROM svara_messages WHERE session_id = ? ORDER BY created_at',
  ['user-123-conversation-1']
);

// Check RAG chunks (with dedup tracking)
const chunks = db.query(
  'SELECT id, content, content_hash FROM svara_chunks LIMIT 10'
);
```

### Channels

One agent, multiple platforms.

```ts
agent
  .connectChannel('web', { port: 3000, cors: true })
  .connectChannel('telegram', { token: process.env.TG_TOKEN })
  .connectChannel('whatsapp', {
    token: process.env.WA_TOKEN,
    phoneId: process.env.WA_PHONE_ID,
    verifyToken: process.env.WA_VERIFY_TOKEN,
  });

await agent.start();
```

### Events

Hook into the agent lifecycle.

```ts
agent.on('message:received', ({ message, sessionId }) => { /* log it */ });
agent.on('tool:call',        ({ tools }) => { /* monitor usage */ });
agent.on('tool:result',      ({ name, result }) => { /* cache results */ });
agent.on('message:sent',     ({ response }) => { /* analytics */ });
agent.on('channel:ready',    ({ channel }) => { /* notify */ });
```

---

## Examples

### Basic agent

```ts
import { SvaraApp, SvaraAgent } from '@yesvara/svara';

const app = new SvaraApp({ cors: true });
const agent = new SvaraAgent({ name: 'Aria', model: 'gpt-4o-mini' });

app.route('/chat', agent.handler());
app.listen(3000);
```

### Agent with tools

```ts
import { SvaraAgent, createTool } from '@yesvara/svara';

const agent = new SvaraAgent({ name: 'Aria', model: 'gpt-4o' });

agent.addTool(createTool({
  name: 'get_time',
  description: 'Get the current date and time',
  parameters: {},
  async run() {
    return { time: new Date().toISOString() };
  },
}));

const reply = await agent.chat('What time is it?');
console.log(reply); // "It's currently 14:32 UTC..."
```

### RAG-powered support bot

```ts
const agent = new SvaraAgent({
  name: 'Support Bot',
  model: 'gpt-4o-mini',
  knowledge: './docs',
  systemPrompt: 'You are a customer support agent. Answer using the documentation.',
  memory: { window: 20 },
});

await agent.start(); // indexes documents
```

### Multi-channel (Web + Telegram + WhatsApp)

```ts
const agent = new SvaraAgent({
  name: 'Aria',
  model: 'gpt-4o-mini',
  knowledge: './policies',
});

agent
  .connectChannel('web',      { port: 3000 })
  .connectChannel('telegram', { token: process.env.TG_TOKEN })
  .connectChannel('whatsapp', {
    token:       process.env.WA_TOKEN,
    phoneId:     process.env.WA_PHONE_ID,
    verifyToken: process.env.WA_VERIFY_TOKEN,
  });

await agent.start();
```

### Drop into an existing Express app

```ts
import express from 'express';
import { SvaraAgent } from '@yesvara/svara';

const app = express();
app.use(express.json());

const agent = new SvaraAgent({ name: 'Aria', model: 'gpt-4o-mini' });

app.post('/api/chat', agent.handler()); // ← one line
app.listen(3000);
```

---

## CLI

### Create a new project

```bash
svara new my-app
```

Output:
```
✨ Creating SvaraJS project: my-app

  ✓ package.json
  ✓ tsconfig.json
  ✓ .env.example
  ✓ src/index.ts
  ✓ docs/README.md

📦 Installing dependencies...

✅ Project ready!

  cd my-app
  cp .env.example .env
  npm run dev
```

Options:
- `--template <name>` — Use a specific template (default: `basic`)
  - `basic` — Simple agent with HTTP endpoint
  - `rag` — RAG-powered agent with document loader
  - `multi-channel` — Web + Telegram + WhatsApp setup
  - `tools` — Agent with tool calling examples

### Start development server

```bash
svara dev
```

Features:
- Hot-reload on file changes
- Auto-restart agent on code updates
- Debug logging enabled
- Serves on `http://localhost:3000` (configurable)

Options:
- `--port <number>` — Custom port (default: `3000`)
- `--watch <glob>` — Watch additional paths (default: `src/**`)
- `--env <file>` — Load custom .env file

### Build for production

```bash
svara build
```

Outputs:
- `dist/` — Compiled JavaScript
- `dist/index.js` — Entry point (ready for Node or Docker)
- Source maps and type declarations included

Options:
- `--minify` — Minify output
- `--sourcemaps` — Include source maps (default: true)
- `--outdir <path>` — Custom output directory (default: `dist/`)

### Running built projects

```bash
# After building
node dist/index.js

# Or with env file
NODE_ENV=production OPENAI_API_KEY=sk-... node dist/index.js
```

### Database management

```bash
# Initialize database (auto-creates tables)
svara db init

# Show database schema
svara db schema

# Export users and conversation history
svara db export --format json
svara db export --format csv --table svara_messages

# Query database directly
svara db query "SELECT COUNT(*) FROM svara_users"

# Reset database (⚠️ deletes all data)
svara db reset

# Backup database
svara db backup --output backup-2026-01-15.db

# Restore from backup
svara db restore --input backup-2026-01-15.db
```

Options:
- `--db <path>` — Custom database path (default: `./data/svara.db`)
- `--format <type>` — Export format: `json`, `csv`, `sql` (default: `json`)
- `--table <name>` — Specific table to export
- `--output <path>` — Output file path
- `--force` — Skip confirmation prompts (use with `reset` carefully!)

---

## Built-in Database

Persistent SQLite for users, sessions, conversation history, and RAG vectors.

```ts
import { SvaraDB } from '@yesvara/svara';

const db = new SvaraDB('./data/svara.db');

// Built-in tables (auto-created):
// - svara_users: user registry with timestamps
// - svara_sessions: conversation sessions linked to users
// - svara_messages: conversation history
// - svara_chunks: RAG vectors with deduplication
// - svara_kv: key-value store for app state

// Query users
const activeUsers = db.query(
  'SELECT id, display_name, last_seen FROM svara_users WHERE last_seen > unixepoch() - 86400'
);

// Get conversation history
const history = db.query(
  'SELECT role, content FROM svara_messages WHERE session_id = ? ORDER BY created_at',
  ['session-id']
);

// Key-value store
db.kv.set('feature:rag', true);
const enabled = db.kv.get<boolean>('feature:rag');

// Transactions
db.transaction(() => {
  db.run('INSERT INTO orders ...', [...]);
  db.run('UPDATE inventory ...', [...]);
});
```

---

## Architecture

```
@yesvara/svara/
├── src/
│   ├── core/
│   │   ├── agent.ts        # SvaraAgent — the main class
│   │   ├── llm.ts          # LLM abstraction + provider auto-detection
│   │   └── types.ts        # Internal types
│   ├── app/
│   │   └── index.ts        # SvaraApp — HTTP framework wrapper
│   ├── channels/
│   │   ├── web.ts          # REST API + SSE streaming
│   │   ├── telegram.ts     # Telegram Bot API (polling + webhook)
│   │   └── whatsapp.ts     # Meta WhatsApp Cloud API
│   ├── rag/
│   │   ├── loader.ts       # Document loading (PDF, MD, DOCX, ...)
│   │   ├── chunker.ts      # Chunking strategies (sentence, paragraph, fixed)
│   │   └── retriever.ts    # Vector similarity search
│   ├── memory/
│   │   ├── conversation.ts # Per-session history with auto-trim
│   │   └── context.ts      # LLM message builder + RAG injection
│   ├── tools/
│   │   ├── index.ts        # createTool() helper
│   │   ├── registry.ts     # Tool store
│   │   └── executor.ts     # Concurrent execution with timeout protection
│   ├── database/
│   │   ├── sqlite.ts       # SvaraDB wrapper (query, kv, transaction)
│   │   └── schema.ts       # Internal SQLite schema
│   ├── cli/                # svara new / dev / build
│   ├── types.ts            # Public types (exported to users)
│   └── index.ts            # Public API surface
└── examples/
    ├── 01-basic/           # 10-line agent
    ├── 02-with-tools/      # createTool + events
    ├── 03-rag-knowledge/   # Document Q&A
    └── 04-multi-channel/   # Web + Telegram + WhatsApp
```

---

## Web API Reference

When using `app.route('/chat', agent.handler())`:

**`POST /chat`**

Request:
```json
{
  "message": "What is the refund policy?",
  "userId": "alice@example.com",
  "sessionId": "alice-session-1"
}
```

Response:
```json
{
  "response": "Our refund policy allows returns within 30 days...",
  "sessionId": "alice-session-1",
  "usage": {
    "promptTokens": 312,
    "completionTokens": 89,
    "totalTokens": 401
  },
  "toolsUsed": []
}
```

**Note:** `userId` and `sessionId` are automatically tracked in the SQLite database for user management and conversation history.

**`GET /health`** — always returns `{ "status": "ok" }`

---

## Database Schema

SvaraJS automatically creates and manages these SQLite tables:

| Table | Purpose | Auto-Managed |
|-------|---------|--------------|
| `svara_users` | User registry (first_seen, last_seen, metadata) | ✅ Yes |
| `svara_sessions` | Conversation sessions linked to users | ✅ Yes |
| `svara_messages` | Full conversation history per session | ✅ Yes |
| `svara_chunks` | RAG vectors **isolated per agent** with deduplication | ✅ Yes |
| `svara_documents` | Document registry and metadata | ✅ Yes |
| `svara_kv` | Key-value store for app state | ✅ Yes |
| `svara_meta` | Framework metadata and versions | ✅ Yes |

**RAG Isolation:**

Each agent's RAG data is stored separately using the `agent_name` column:

```ts
// Query RAG chunks for specific agent
const supportChunks = db.query(
  'SELECT COUNT(*) as count FROM svara_chunks WHERE agent_name = ?',
  ['SupportBot']
);

const salesChunks = db.query(
  'SELECT COUNT(*) as count FROM svara_chunks WHERE agent_name = ?',
  ['SalesBot']
);

// Export conversation analytics
db.query(`
  SELECT u.id, u.display_name, COUNT(m.id) as message_count
  FROM svara_users u
  LEFT JOIN svara_messages m ON u.id = (
    SELECT user_id FROM svara_sessions WHERE id = m.session_id
  )
  WHERE u.last_seen > unixepoch() - 86400
  GROUP BY u.id
  ORDER BY message_count DESC
`);
```

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) first.

```bash
git clone https://github.com/yogiswara92/svarajs
cd svara
npm install
npm run dev
```

---

## License

MIT © [Yesvara](https://github.com/yogiswara92)

---

<div align="center">

Built with ❤️ for developers who want to ship AI, not fight infrastructure.

**[Documentation](https://svarajs.yesvara.com)** · **[Examples](./examples)** · **[npm](https://npmjs.com/package/@yesvara/svara)**

</div>
