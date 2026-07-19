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
    const line = `${ENTRY_PREFIX}${entry.trim()}`;
    await this.commit(file, existing ? `${existing}\n${line}` : line);
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
