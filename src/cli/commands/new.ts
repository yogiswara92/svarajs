/**
 * @module cli/commands/new
 * SvaraJS - `svara new <project-name>` command
 *
 * Scaffolds a new SvaraJS project with opinionated defaults.
 * Creates a ready-to-run project in seconds.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * Version of this very package, read once so scaffolded projects always pin the version they
 * were created with. Same resolution as cli/index.ts's own pkg.version read: everything under
 * src/cli/** gets bundled into the single dist/cli/index.js file, so __dirname at runtime is
 * always dist/cli - two levels up is the package root, regardless of this file's original path.
 */
const SVARA_VERSION: string = (() => {
  try {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    return (JSON.parse(fsSync.readFileSync(pkgPath, 'utf-8')) as { version: string }).version;
  } catch {
    return 'latest';
  }
})();

interface ScaffoldOptions {
  name: string;
  provider?: 'openai' | 'anthropic' | 'ollama';
  channels?: string[];
  installDeps?: boolean;
  /** Scaffold a standalone omnichannel-assistant project (svara.config.json + `svara start`) instead of a library-mode project. */
  standalone?: boolean;
}

export async function newProject(options: ScaffoldOptions): Promise<void> {
  const { name, provider = 'openai', channels = ['web'], standalone = false } = options;
  const targetDir = path.resolve(process.cwd(), name);

  console.log(`\n✨ Creating SvaraJS project: ${name}${standalone ? ' (standalone assistant)' : ''}\n`);

  // Check if directory already exists
  try {
    await fs.access(targetDir);
    console.error(`❌ Directory "${name}" already exists.`);
    process.exit(1);
  } catch {
    // Good - it doesn't exist
  }

  await fs.mkdir(targetDir, { recursive: true });
  await fs.mkdir(path.join(targetDir, 'data'), { recursive: true });

  const files: Record<string, string> = standalone
    ? {
      'package.json': generateStandalonePackageJson(name),
      'svara.config.json': generateRuntimeConfig(name, provider, channels),
      '.env.example': generateEnvExample(provider, channels),
      '.gitignore': generateGitignore(true),
      ...generateDefaultSkills(),
      'docs/README.md': `# ${name} Knowledge Base\n\nAdd your documents here for RAG.\n`,
    }
    : {
      'package.json': generatePackageJson(name),
      'tsconfig.json': generateTsConfig(),
      '.env.example': generateEnvExample(provider, channels),
      '.gitignore': generateGitignore(false),
      'src/index.ts': generateIndexFile(name, provider, channels),
      'docs/README.md': `# ${name} Knowledge Base\n\nAdd your documents here for RAG.\n`,
    };

  if (!standalone) {
    await fs.mkdir(path.join(targetDir, 'src'), { recursive: true });
  }
  await fs.mkdir(path.join(targetDir, 'docs'), { recursive: true });

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(targetDir, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    console.log(`  ✓ ${filePath}`);
  }

  if (options.installDeps !== false) {
    console.log('\n📦 Installing dependencies...\n');
    try {
      execSync('npm install', { cwd: targetDir, stdio: 'inherit' });
    } catch {
      console.warn('\n⚠️  Dependency install failed. Run "npm install" manually.\n');
    }
  }

  console.log(standalone
    ? `
✅ Standalone assistant ready!

  cd ${name}
  cp .env.example .env     # Add your API keys
  npm start                 # svara start - boots the agent + dashboard

📊 Dashboard: http://localhost:3000/dashboard
📚 Docs: https://svarajs.dev
`
    : `
✅ Project ready!

  cd ${name}
  cp .env.example .env     # Add your API keys
  npm run dev              # Start the agent

📚 Docs: https://svarajs.dev
`);
}

// ─── File Templates ────────────────────────────────────────────────────────────

function generatePackageJson(name: string): string {
  return JSON.stringify({
    name,
    version: '0.1.0',
    private: true,
    scripts: {
      dev: 'tsx watch src/index.ts',
      build: 'tsc',
      start: 'node dist/index.js',
    },
    dependencies: {
      '@yesvara/svara': `^${SVARA_VERSION}`,
      'better-sqlite3': '^12.8.0',
      chokidar: '^3.6.0',
      dotenv: '^16.4.5',
    },
    devDependencies: {
      '@types/node': '^20.14.2',
      tsx: '^4.15.7',
      typescript: '^5.4.5',
    },
  }, null, 2);
}

function generateTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'CommonJS',
      moduleResolution: 'bundler',
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'dist'],
  }, null, 2);
}

function generateEnvExample(
  provider: string,
  channels: string[]
): string {
  const lines = ['# SvaraJS Environment Variables', ''];

  if (provider === 'openai') {
    lines.push('# OpenAI', 'OPENAI_API_KEY=sk-...', '');
  } else if (provider === 'anthropic') {
    lines.push('# Anthropic', 'ANTHROPIC_API_KEY=sk-ant-...', '');
  }

  if (channels.includes('telegram')) {
    lines.push('# Telegram', 'TELEGRAM_BOT_TOKEN=...', '');
  }
  if (channels.includes('whatsapp')) {
    lines.push('# WhatsApp', 'WA_ACCESS_TOKEN=...', 'WA_PHONE_ID=...', 'WA_VERIFY_TOKEN=...', '');
  }
  if (channels.includes('slack')) {
    lines.push('# Slack', 'SLACK_BOT_TOKEN=xoxb-...', 'SLACK_SIGNING_SECRET=...', '');
  }
  if (channels.includes('discord')) {
    lines.push('# Discord', 'DISCORD_BOT_TOKEN=...', '');
  }

  return lines.join('\n');
}

function generateIndexFile(
  name: string,
  provider: string,
  channels: string[]
): string {
  const modelMap: Record<string, string> = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-opus-4-6',
    ollama: 'llama3',
  };

  const channelSetup = channels.includes('web')
    ? `const app = new SvaraApp({ cors: true });\napp.route('/chat', agent.handler());\napp.listen(3000);`
    : channels.length > 0
      ? `agent\n  ${channels
          .map((ch) => {
            if (ch === 'telegram') return `.connectChannel('telegram', { token: process.env.TELEGRAM_BOT_TOKEN! })`;
            if (ch === 'whatsapp')
              return `.connectChannel('whatsapp', {\n    token: process.env.WA_ACCESS_TOKEN!,\n    phoneId: process.env.WA_PHONE_ID!,\n    verifyToken: process.env.WA_VERIFY_TOKEN!,\n  })`;
            if (ch === 'slack')
              return `.connectChannel('slack', {\n    botToken: process.env.SLACK_BOT_TOKEN!,\n    signingSecret: process.env.SLACK_SIGNING_SECRET!,\n  })`;
            if (ch === 'discord')
              return `.connectChannel('discord', { botToken: process.env.DISCORD_BOT_TOKEN! })`;
            return '';
          })
          .filter(Boolean)
          .join('\n  ')};\nawait agent.start();`
      : '';

  return `import 'dotenv/config';
import { SvaraApp, SvaraAgent, createTool } from '@yesvara/svara';
import chokidar from 'chokidar';

/**
 * ${name} - powered by SvaraJS
 */

// Define tools
const timeTool = createTool({
  name: 'get_time',
  description: 'Get the current date and time',
  parameters: {},
  async run() {
    return {
      datetime: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  },
});

// Create agent
const agent = new SvaraAgent({
  name: '${name}',
  model: '${modelMap[provider] ?? 'gpt-4o-mini'}',
  systemPrompt: 'You are a helpful AI assistant. Be concise and friendly.',
  tools: [timeTool],
  knowledge: './docs/**/*', // Add your documents here for RAG
});

// Auto-reload knowledge when files change
const watcher = chokidar.watch('./docs', { ignored: /^\\./ });
watcher.on('add', async () => {
  console.log('📄 Document detected, reloading knowledge...');
  await agent.addKnowledge('./docs/**/*');
});
watcher.on('unlink', async () => {
  console.log('🗑️ Document removed, reloading knowledge...');
  await agent.addKnowledge('./docs/**/*');
});

// Setup channels
${channelSetup}

console.log('✨ ${name} is running!');
`;
}

function generateGitignore(standalone: boolean): string {
  const base = `node_modules/
dist/
.env
data/*.db
*.log
`;
  // MEMORY.md/USER.md accumulate whatever the agent learns about you at runtime -
  // ignored by default for privacy, same reasoning as .env.
  return standalone ? `${base}memory/\n.svara/\n` : base;
}

function generateStandalonePackageJson(name: string): string {
  return JSON.stringify({
    name,
    version: '0.1.0',
    private: true,
    scripts: {
      start: 'svara start',
    },
    dependencies: {
      '@yesvara/svara': `^${SVARA_VERSION}`,
    },
  }, null, 2);
}

function generateRuntimeConfig(
  name: string,
  provider: string,
  channels: string[]
): string {
  const modelMap: Record<string, string> = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-opus-4-6',
    ollama: 'llama3',
  };

  const channelsConfig: Record<string, unknown> = {};
  if (channels.includes('telegram')) channelsConfig.telegram = {};
  if (channels.includes('whatsapp')) channelsConfig.whatsapp = {};
  if (channels.includes('slack')) channelsConfig.slack = {};
  if (channels.includes('discord')) channelsConfig.discord = {};

  return JSON.stringify({
    name,
    model: modelMap[provider] ?? 'gpt-4o-mini',
    systemPrompt: 'You are a helpful personal assistant. Be concise and friendly.',
    tools: {
      // Off by default - see SECURITY.md before enabling terminal/browser.
      terminal: false,
      filesystem: false,
      web: false,
      browser: false,
    },
    skillsDir: './skills',
    learningMemory: true,
    backgroundReview: false,
    channels: channelsConfig,
    cron: [],
    mcpServers: [],
    port: 3000,
    dashboard: true,
  }, null, 2);
}

/**
 * A small starter library, not a demo to delete - each covers a common
 * assistant task and doubles as a template for writing your own (edit or
 * remove any of these freely). The agent can also write new skills for
 * itself via skill_manage once it finds an approach worth reusing - each
 * skill folder can also hold references, templates, scripts, and assets
 * subfolders for linked files instead of inlining everything into its body.
 */
function generateDefaultSkills(): Record<string, string> {
  return {
    'skills/web-research/SKILL.md': `---
name: Web Research
description: Research a topic online and produce a sourced summary
metadata:
  tags: [research]
---

1. Use web_search to find several relevant, recent sources - don't stop at the first result.
2. Use web_fetch on the most promising 2-4 results to read past the search snippet.
3. Cross-check any specific claim, number, or date against at least one other source before including it.
4. Write a concise summary (a few short paragraphs or a bullet list, whichever fits the question)
   followed by a "Sources" list of the URLs actually used.
5. If sources disagree, say so explicitly rather than picking one silently.
`,

    'skills/daily-briefing/SKILL.md': `---
name: Daily Briefing
description: Summarize recent activity into a short daily briefing
metadata:
  tags: [productivity, cron]
---

Intended to run on a schedule (see the Cron section of the README) but works
on demand too.

1. Gather what changed recently - use whatever tools are available (memory,
   filesystem, delegated sub-tasks) to find activity worth reporting.
2. Group findings into 2-4 short sections (e.g. "Done", "Needs attention",
   "Coming up") - skip a section entirely if it would be empty, don't pad it.
3. Keep the whole briefing skimmable in under 30 seconds - link out or offer
   to elaborate rather than dumping full detail inline.
4. If nothing notable happened, say that plainly instead of manufacturing content.
`,

    'skills/code-review/SKILL.md': `---
name: Code Review
description: Review a code change for correctness, not just style
metadata:
  tags: [dev]
  related_skills: [web-research]
---

1. Understand what the change is trying to do before judging how it does it -
   ask if the intent isn't clear from the diff/description alone.
2. Prioritize in this order: correctness bugs > security issues > missing edge
   cases > design/simplification > style. Don't lead with style nits if a
   correctness bug is also present.
3. For each issue, state the concrete failure scenario (what input/state
   triggers it), not just "this looks wrong."
4. Call out what's good, briefly - a review that's 100% criticism reads as
   less trustworthy than one that shows it actually weighed the tradeoffs.
5. Don't invent issues to seem thorough - an empty "no issues found" is a
   valid, useful review.
`,

    'skills/meeting-notes/SKILL.md': `---
name: Meeting Notes
description: Turn raw notes or a transcript into structured action items
metadata:
  tags: [productivity]
---

1. Read the full notes/transcript before summarizing - don't process it in a
   sliding window that loses earlier context.
2. Produce three sections: **Decisions** (what was actually agreed, not
   discussed), **Action Items** (owner + task, "someone should" doesn't
   count as an owner), **Open Questions** (unresolved, needs follow-up).
3. Attribute action items to a specific person or team when the source
   material makes that clear - leave it unassigned rather than guessing.
4. Omit a section entirely if it has nothing in it rather than writing "None."
`,

    'skills/task-triage/SKILL.md': `---
name: Task Triage
description: Prioritize a list of incoming tasks or requests
metadata:
  tags: [productivity]
---

1. Sort into three tiers: **Urgent** (time-sensitive or blocking someone
   else), **Important** (real impact, not time-sensitive), **Later**
   (fine to defer or batch).
2. Within a tier, order by effort-to-impact - quick wins first.
3. State the reasoning for anything placed in Urgent - "urgent" is
   over-claimed by default, justify it in one line.
4. If a task is ambiguous or missing information needed to act on it, flag
   that explicitly instead of silently guessing at scope.
`,

    'skills/pptx/SKILL.md': `---
name: PowerPoint Creation
description: Generate a .pptx PowerPoint file from content or an outline
metadata:
  tags: [documents]
---

Requires \`terminal_exec\` and \`file_write\` enabled (see svara.config.json).

1. Turn the requested content into a slide outline first - one heading + a
   few bullet points per slide. Don't put paragraphs of text on a slide.
2. Write a small Node.js script (via file_write) that uses the \`pptxgenjs\`
   npm package to build the deck: one \`pres.addSlide()\` call per slide,
   \`slide.addText()\` for the title and bullets.
3. Check the package is available before running the script - if
   \`node -e "require('pptxgenjs')"\` fails, run \`npm install pptxgenjs\`
   first (terminal_exec).
4. Run the script with \`node <script>.js\`, save output as \`<name>.pptx\`,
   then tell the user the file path - don't try to describe the deck instead
   of producing the file.
5. Keep to 6-10 slides unless asked for more; a wall of 40 slides is rarely
   what was actually wanted.
`,

    'skills/docx/SKILL.md': `---
name: Word Document Creation
description: Generate a .docx Word document from content
metadata:
  tags: [documents]
---

Requires \`terminal_exec\` and \`file_write\` enabled (see svara.config.json).

1. Write a small Node.js script (via file_write) that uses the \`docx\` npm
   package to build the document: a \`Document\` with \`Paragraph\`/\`TextRun\`
   for body text, \`HeadingLevel\` for section headings.
2. Check the package is available before running the script - if
   \`node -e "require('docx')"\` fails, run \`npm install docx\` first
   (terminal_exec).
3. Match structure to the source content - real headings for sections, not
   bold text pretending to be a heading.
4. Run the script, save output as \`<name>.docx\`, then give the user the
   file path.
`,

    'skills/xlsx/SKILL.md': `---
name: Excel Spreadsheet Creation
description: Generate a .xlsx Excel spreadsheet from tabular data
metadata:
  tags: [documents]
---

Requires \`terminal_exec\` and \`file_write\` enabled (see svara.config.json).

1. Write a small Node.js script (via file_write) that uses the \`exceljs\`
   npm package: \`workbook.addWorksheet()\`, a header row, then one row per
   data record via \`worksheet.addRow()\`.
2. Check the package is available before running the script - if
   \`node -e "require('exceljs')"\` fails, run \`npm install exceljs\` first
   (terminal_exec).
3. Give columns real headers and reasonable types (numbers as numbers, not
   strings) - don't dump everything into a single unlabeled column.
4. Run the script, save output as \`<name>.xlsx\`, then give the user the
   file path.
`,

    'skills/pdf/SKILL.md': `---
name: PDF Creation
description: Generate a .pdf file from content, or extract text from an existing PDF
metadata:
  tags: [documents]
---

Requires \`terminal_exec\` and \`file_write\` enabled (see svara.config.json).

**Creating a PDF:**
1. Write a small Node.js script (via file_write) that uses the \`pdf-lib\`
   npm package: \`PDFDocument.create()\`, \`doc.addPage()\`,
   \`page.drawText()\` for content.
2. Check the package is available before running the script - if
   \`node -e "require('pdf-lib')"\` fails, run \`npm install pdf-lib\` first
   (terminal_exec).
3. Run the script, save output as \`<name>.pdf\`, then give the user the file path.

**Reading an existing PDF:** use the same package's \`PDFDocument.load()\` to
open it, or fall back to a CLI tool like \`pdftotext\` if it's already on the
system - don't guess at content you haven't actually extracted.
`,
  };
}
