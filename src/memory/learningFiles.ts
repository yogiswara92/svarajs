/**
 * @module memory/learningFiles
 * SvaraJS - persistent "learning" memory: MEMORY.md (what the agent has
 * learned about its environment/conventions) and USER.md (what it has
 * learned about the person it's talking to).
 *
 * Three safeguards, since this content gets re-injected into every future
 * system prompt (a poisoned or silently-clobbered entry is durable and
 * cross-session):
 * - **Content scan** - new entries are scanned for destructive/exfiltration
 *   patterns before being written; flagged content is rejected, not
 *   silently persisted.
 * - **Drift detection** - if the file changed on disk since it was last
 *   loaded (a human edited it directly), the write is refused and the
 *   attempted content is saved to a `.bak.<timestamp>` file instead of
 *   silently clobbering their edit.
 * - **Atomic writes** - every write goes through a temp-file-then-rename,
 *   so a process crash mid-write can't leave a half-written file.
 *
 * Snapshot-cached: `load()` only hits disk once per cache generation.
 * Writes (`add`/`replace`/`remove`/`setRaw`) persist immediately and
 * invalidate the cache, so the *next* `load()` - i.e. the next turn -
 * picks up the change. This favors changes being visible sooner over
 * preserving a cross-provider prompt cache SvaraJS doesn't have.
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { scanForThreats, type ThreatMatch } from '../security/threatPatterns.js';

export type LearningFile = 'MEMORY.md' | 'USER.md';

export interface LearningMemoryOptions {
  /** Directory MEMORY.md/USER.md live in. @default './memory' */
  dir?: string;
}

export interface LearningSnapshot {
  agent: string;
  user: string;
}

const ENTRY_PREFIX = '§ ';
const DANGEROUS_CATEGORIES = new Set<ThreatMatch['category']>(['destructive', 'exfiltration']);

// A new entry that's at least this similar to an existing one supersedes it
// in place instead of piling on as a near-duplicate line - without this,
// a background-review pass that re-decides "this is worth saving" on every
// turn (it has no visibility into what's already saved - see
// backgroundReview.ts) silently grows the file with the same fact restated
// a dozen times, which then dominates every future system prompt.
const DUPLICATE_THRESHOLD = 0.6;

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Below this, the whole file is cheap enough to just inject as-is - no need
// to score/rank a handful of entries.
const RELEVANCE_FILTER_THRESHOLD_CHARS = 2000;

/**
 * Picks the entries most relevant to `query` (current user message) instead
 * of the whole file, once the file has grown past a size where dumping it
 * whole into every system prompt would drown out the actual current turn -
 * see agent.ts's run(). Ties (including "nothing matched at all") fall back
 * to the most recently-added entries, so a generic message still gets some
 * memory instead of none.
 */
export function selectRelevantNotes(notes: string, query: string, maxEntries = 12): string {
  if (!notes || notes.length <= RELEVANCE_FILTER_THRESHOLD_CHARS) return notes;

  const lines = notes.split('\n').filter(Boolean);
  const queryWords = wordSet(query);
  const scored = lines.map((line, index) => ({
    line,
    index,
    score: [...queryWords].filter((w) => wordSet(line).has(w)).length,
  }));

  scored.sort((a, b) => b.score - a.score || b.index - a.index);
  const picked = scored.slice(0, maxEntries);
  picked.sort((a, b) => a.index - b.index); // restore file order for readability
  return picked.map((p) => p.line).join('\n');
}

export class DangerousContentError extends Error {
  constructor(file: LearningFile, public readonly findings: ThreatMatch[]) {
    super(`[SvaraJS] Refusing to write to "${file}": ${findings.map((f) => f.description).join('; ')}`);
    this.name = 'DangerousContentError';
  }
}

export class DriftDetectedError extends Error {
  constructor(file: LearningFile, public readonly backupPath: string) {
    super(
      `[SvaraJS] "${file}" changed on disk since it was last read (edited outside LearningMemory) - ` +
      `refusing to overwrite it. Your attempted content was saved to "${backupPath}" instead.`
    );
    this.name = 'DriftDetectedError';
  }
}

export class LearningMemory {
  private dir: string;
  private cache: LearningSnapshot | null = null;
  private loadedHash: Map<LearningFile, string> = new Map();

  constructor(opts: LearningMemoryOptions = {}) {
    this.dir = opts.dir ?? './memory';
  }

  /** Cached after the first call - see the snapshot note above. */
  async load(): Promise<LearningSnapshot> {
    if (this.cache) return this.cache;

    const agentRaw = await this.readRaw('MEMORY.md');
    const userRaw = await this.readRaw('USER.md');
    this.loadedHash.set('MEMORY.md', hash(agentRaw));
    this.loadedHash.set('USER.md', hash(userRaw));
    this.cache = { agent: agentRaw.trim(), user: userRaw.trim() };
    return this.cache;
  }

  /** Force the next `load()` to re-read from disk. */
  reload(): void {
    this.cache = null;
    this.loadedHash.clear();
  }

  async add(file: LearningFile, entry: string): Promise<void> {
    assertSafe(file, entry);
    const snapshot = await this.load();
    const existing = file === 'MEMORY.md' ? snapshot.agent : snapshot.user;
    const lines = existing ? existing.split('\n').filter(Boolean) : [];
    const line = `${ENTRY_PREFIX}${entry.trim()}`;

    const newWords = wordSet(entry);
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < lines.length; i++) {
      const score = jaccard(newWords, wordSet(lines[i].slice(ENTRY_PREFIX.length)));
      if (score > bestScore) { bestScore = score; bestIndex = i; }
    }

    if (bestIndex !== -1 && bestScore >= DUPLICATE_THRESHOLD) {
      lines[bestIndex] = line; // near-duplicate - supersede it in place instead of piling on
    } else {
      lines.push(line);
    }
    await this.commit(file, lines.join('\n'));
  }

  /** Replace the first entry whose text includes `match` with `entry`. */
  async replace(file: LearningFile, match: string, entry: string): Promise<{ replaced: boolean }> {
    assertSafe(file, entry);
    const snapshot = await this.load();
    const lines = (file === 'MEMORY.md' ? snapshot.agent : snapshot.user).split('\n').filter(Boolean);
    const idx = lines.findIndex((l) => l.includes(match));
    if (idx === -1) return { replaced: false };
    lines[idx] = `${ENTRY_PREFIX}${entry.trim()}`;
    await this.commit(file, lines.join('\n'));
    return { replaced: true };
  }

  /** Remove the first entry whose text includes `match`. */
  async remove(file: LearningFile, match: string): Promise<{ removed: boolean }> {
    const snapshot = await this.load();
    const lines = (file === 'MEMORY.md' ? snapshot.agent : snapshot.user).split('\n').filter(Boolean);
    const idx = lines.findIndex((l) => l.includes(match));
    if (idx === -1) return { removed: false };
    lines.splice(idx, 1);
    await this.commit(file, lines.join('\n'));
    return { removed: true };
  }

  /** Overwrite a file's full contents (e.g. a dashboard textarea save) instead of appending one entry. */
  async setRaw(file: LearningFile, content: string): Promise<void> {
    assertSafe(file, content);
    await this.commit(file, content.trim());
  }

  /** Drift-checked, atomic write: temp file + rename, refuses to clobber an externally-modified file. */
  private async commit(file: LearningFile, content: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const filePath = path.join(this.dir, file);

    const onDisk = await this.readRaw(file);
    const expected = this.loadedHash.get(file);
    if (expected !== undefined && hash(onDisk) !== expected) {
      const backupPath = `${filePath}.bak.${Date.now()}`;
      await fs.writeFile(backupPath, `${content}\n`, 'utf-8');
      this.reload();
      throw new DriftDetectedError(file, backupPath);
    }

    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmpPath, `${content}\n`, 'utf-8');
    await fs.rename(tmpPath, filePath);
    this.reload();
  }

  private async readRaw(file: LearningFile): Promise<string> {
    try {
      return await fs.readFile(path.join(this.dir, file), 'utf-8');
    } catch {
      return '';
    }
  }
}

function assertSafe(file: LearningFile, text: string): void {
  const dangerous = scanForThreats(text).filter((f) => DANGEROUS_CATEGORIES.has(f.category));
  if (dangerous.length > 0) {
    throw new DangerousContentError(file, dangerous);
  }
}

function hash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
