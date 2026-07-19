/**
 * @module skills/registry
 * Scans `skillsDir` for `<id>/SKILL.md` directories and provides progressive
 * disclosure over them: `list()` is metadata-only (cheap, includes which
 * reference/template/script/asset files exist but not their content),
 * `get()` loads the full SKILL.md body, and `readResourceFile()` loads one
 * specific linked file on demand (the "linked-file tier" in the
 * three-tier progressive-disclosure model). `create`/`edit`/`delete` (plus
 * `writeResourceFile`/`removeResourceFile`) let the agent manage skills
 * itself via the skill_manage tool.
 *
 * Lean by design - no marketplace/hub, no AST security audit (see
 * skills/guard.ts for the lighter content-pattern check that replaces it),
 * no automatic stale/archive lifecycle.
 */

import fs from 'fs/promises';
import path from 'path';
import { parseSkillFile, serializeSkill, validateFrontmatter } from './parser.js';
import { validateWithinDir } from '../security/pathGuard.js';
import type { Skill, SkillMeta, SkillFrontmatter } from './types.js';

export interface SkillRegistryOptions {
  skillsDir: string;
}

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const RESOURCE_DIRS = ['references', 'templates', 'scripts', 'assets'] as const;
type ResourceDir = (typeof RESOURCE_DIRS)[number];

export class SkillRegistry {
  private skillsDir: string;
  private cache: Map<string, Skill> = new Map();
  private scanned = false;

  constructor(opts: SkillRegistryOptions) {
    this.skillsDir = opts.skillsDir;
  }

  /** Re-scan skillsDir from disk, rebuilding the in-memory cache. */
  async scan(): Promise<SkillMeta[]> {
    this.cache.clear();
    this.scanned = true;

    let entries;
    try {
      entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
    } catch {
      return []; // skillsDir doesn't exist yet - no skills, not an error
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = path.join(this.skillsDir, entry.name, 'SKILL.md');
      try {
        const skill = await parseSkillFile(skillMdPath);
        this.cache.set(skill.id, skill);
      } catch {
        // Not a valid skill directory - skip silently, same as RAG's loadMany().
      }
    }

    return this.toMetaList();
  }

  /** Metadata for every skill (name + description + resource filenames - cheap). */
  async list(): Promise<SkillMeta[]> {
    if (!this.scanned) await this.scan();
    return this.toMetaList();
  }

  /** Full skill (including body) by id. */
  async get(id: string): Promise<Skill | undefined> {
    if (!this.scanned) await this.scan();
    return this.cache.get(id);
  }

  /** Load one file's content from a skill's references/templates/scripts/assets subfolder. */
  async readResourceFile(id: string, dir: ResourceDir, filename: string): Promise<string> {
    const skill = await this.get(id);
    if (!skill) throw new Error(`[SvaraJS] Skill "${id}" not found.`);
    if (!RESOURCE_DIRS.includes(dir)) {
      throw new Error(`[SvaraJS] Invalid resource folder "${dir}". Use one of: ${RESOURCE_DIRS.join(', ')}.`);
    }
    const resolved = validateWithinDir(path.join(dir, filename), skill.path);
    return fs.readFile(resolved, 'utf-8');
  }

  /** Write (create or overwrite) a file inside a skill's references/templates/scripts/assets subfolder. */
  async writeResourceFile(id: string, dir: ResourceDir, filename: string, content: string): Promise<void> {
    const skill = await this.get(id);
    if (!skill) throw new Error(`[SvaraJS] Skill "${id}" not found.`);
    if (!RESOURCE_DIRS.includes(dir)) {
      throw new Error(`[SvaraJS] Invalid resource folder "${dir}". Use one of: ${RESOURCE_DIRS.join(', ')}.`);
    }
    const resolved = validateWithinDir(path.join(dir, filename), skill.path);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf-8');
    await this.scan();
  }

  /** Remove a file from a skill's references/templates/scripts/assets subfolder. */
  async removeResourceFile(id: string, dir: ResourceDir, filename: string): Promise<void> {
    const skill = await this.get(id);
    if (!skill) throw new Error(`[SvaraJS] Skill "${id}" not found.`);
    const resolved = validateWithinDir(path.join(dir, filename), skill.path);
    await fs.rm(resolved, { force: true });
    await this.scan();
  }

  async create(id: string, frontmatter: SkillFrontmatter, body: string): Promise<void> {
    this.assertValidId(id);
    validateFrontmatter(frontmatter, id);
    if (this.cache.has(id) || (await this.get(id))) {
      throw new Error(`[SvaraJS] Skill "${id}" already exists. Use action "edit" instead.`);
    }
    const dir = validateWithinDir(id, this.skillsDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), serializeSkill(frontmatter, body), 'utf-8');
    await this.scan();
  }

  async edit(id: string, updates: { frontmatter?: Partial<SkillFrontmatter>; body?: string }): Promise<void> {
    this.assertValidId(id);
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`[SvaraJS] Skill "${id}" not found. Use action "create" instead.`);
    }
    const frontmatter: SkillFrontmatter = {
      name: updates.frontmatter?.name ?? existing.name,
      description: updates.frontmatter?.description ?? existing.description,
      version: updates.frontmatter?.version ?? existing.version,
      license: updates.frontmatter?.license ?? existing.license,
      platforms: updates.frontmatter?.platforms ?? existing.platforms,
      prerequisites: updates.frontmatter?.prerequisites ?? existing.prerequisites,
      metadata: updates.frontmatter?.metadata ?? existing.metadata,
    };
    validateFrontmatter(frontmatter, id);
    const body = updates.body ?? existing.body;
    await fs.writeFile(path.join(existing.path, 'SKILL.md'), serializeSkill(frontmatter, body), 'utf-8');
    await this.scan();
  }

  async delete(id: string): Promise<void> {
    this.assertValidId(id);
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`[SvaraJS] Skill "${id}" not found.`);
    }
    await fs.rm(existing.path, { recursive: true, force: true });
    await this.scan();
  }

  private assertValidId(id: string): void {
    if (!ID_PATTERN.test(id)) {
      throw new Error(`[SvaraJS] Invalid skill id "${id}". Use only letters, numbers, underscores, or hyphens.`);
    }
  }

  private toMetaList(): SkillMeta[] {
    return [...this.cache.values()].map(({ body: _body, ...meta }) => meta);
  }
}
