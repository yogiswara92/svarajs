/**
 * @module skills/parser
 * Read/write SKILL.md files (YAML frontmatter + Markdown body), and list
 * the filenames under a skill's references/templates/scripts/assets
 * subfolders (metadata tier only - contents are loaded on demand via
 * skill_view's `file` argument, not eagerly).
 */

import matter from 'gray-matter';
import fs from 'fs/promises';
import path from 'path';
import type { Skill, SkillFrontmatter, SkillResources } from './types.js';

const RESOURCE_DIRS = ['references', 'templates', 'scripts', 'assets'] as const;

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * Validate required-field presence and length limits, shared by the read
 * path (parseSkillFile) and the write path (SkillRegistry.create/edit) so a
 * bad skill fails fast on write rather than only being discovered later
 * when something tries to read it back.
 */
export function validateFrontmatter(fm: Partial<SkillFrontmatter>, context: string): asserts fm is SkillFrontmatter {
  if (!fm.name || !fm.description) {
    throw new Error(`[SvaraJS] Skill "${context}" is missing required frontmatter "name" and/or "description".`);
  }
  if (fm.name.length > MAX_NAME_LENGTH) {
    throw new Error(`[SvaraJS] Skill "${context}": "name" must be ${MAX_NAME_LENGTH} characters or fewer (got ${fm.name.length}).`);
  }
  if (fm.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`[SvaraJS] Skill "${context}": "description" must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${fm.description.length}).`);
  }
}

export async function parseSkillFile(skillMdPath: string): Promise<Skill> {
  const raw = await fs.readFile(skillMdPath, 'utf-8');
  const { data, content } = matter(raw);
  const fm = data as Partial<SkillFrontmatter>;

  validateFrontmatter(fm, skillMdPath);

  const skillDir = path.dirname(skillMdPath);
  return {
    id: path.basename(skillDir),
    name: fm.name,
    description: fm.description,
    version: fm.version,
    license: fm.license,
    platforms: fm.platforms,
    prerequisites: fm.prerequisites,
    metadata: fm.metadata,
    path: skillDir,
    resources: await listResources(skillDir),
    body: content.trim(),
  };
}

async function listResources(skillDir: string): Promise<SkillResources> {
  const result: SkillResources = { references: [], templates: [], scripts: [], assets: [] };

  await Promise.all(RESOURCE_DIRS.map(async (dir) => {
    try {
      const entries = await fs.readdir(path.join(skillDir, dir), { withFileTypes: true });
      result[dir] = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
    } catch {
      // Subfolder doesn't exist for this skill - stays empty, not an error.
    }
  }));

  return result;
}

export function serializeSkill(frontmatter: SkillFrontmatter, body: string): string {
  return matter.stringify(`${body}\n`, stripUndefinedDeep(frontmatter) as Record<string, unknown>);
}

/** js-yaml can't dump `undefined` - recursively drop unset optional fields before serializing. */
function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefinedDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, stripUndefinedDeep(v)])
    );
  }
  return value;
}
