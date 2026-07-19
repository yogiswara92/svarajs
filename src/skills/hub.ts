/**
 * @module skills/hub
 * SvaraJS - install a skill from an arbitrary public GitHub repo.
 *
 * Lean by design: fetches just the SKILL.md file (via raw.githubusercontent.com,
 * no auth needed for public repos) and installs it through the normal
 * registry.create() path. Does not crawl/mirror a skill's
 * references/templates/scripts/assets subfolders - a hub-installed skill
 * that needs those can have them added afterward via skill_manage's
 * write_file action. Every install goes through the 'hub' trust tier (see
 * skills/guard.ts) - the least-trusted tier, since anyone can host a repo.
 */

import matter from 'gray-matter';
import { validateFrontmatter } from './parser.js';
import { guardSkillContent } from './guard.js';
import type { SkillRegistry } from './registry.js';
import type { SkillFrontmatter } from './types.js';
import type { ThreatMatch } from '../security/threatPatterns.js';
import type { Tool } from '../types.js';

export interface SkillHubOptions {
  /** Called when installed content needs a yes/no decision. No callback = declined, not allowed. */
  onApprovalNeeded?: (skillId: string, verdict: 'ask' | 'block', findings: ThreatMatch[]) => Promise<boolean>;
  /** Abort the fetch after this long. @default 15000 */
  timeout?: number;
}

/**
 * Accepts a full raw-file URL, or the shorthand `owner/repo[@ref][/path/to/skill]`
 * (defaults to branch `main`, SKILL.md at the repo root or at `path/to/skill/SKILL.md`).
 */
export function resolveSkillSourceUrl(source: string): string {
  if (/^https?:\/\//i.test(source)) return source;

  const match = source.match(/^([^/\s]+)\/([^/@\s]+)(?:@([^/\s]+))?(?:\/(.+))?$/);
  if (!match) {
    throw new Error(
      `[SvaraJS] Could not parse skill source "${source}". ` +
      'Use a raw SKILL.md URL, or "owner/repo[@ref][/path/to/skill]".'
    );
  }
  const [, owner, repo, ref = 'main', subpath] = match;
  const skillPath = subpath ? `${subpath.replace(/\/$/, '')}/SKILL.md` : 'SKILL.md';
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${skillPath}`;
}

function deriveIdFromSource(source: string): string {
  const withoutProtocol = source.replace(/^https?:\/\//i, '');
  const lastSegment = withoutProtocol.split('/').filter(Boolean).pop() ?? 'skill';
  const cleaned = lastSegment.replace(/\.md$/i, '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  return cleaned || 'skill';
}

export async function installSkillFromHub(
  source: string,
  registry: SkillRegistry,
  opts: SkillHubOptions = {},
  id?: string
): Promise<{ id: string; name: string }> {
  const url = resolveSkillSourceUrl(source);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout ?? 15_000);
  let raw: string;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`[SvaraJS] Could not fetch "${url}": ${res.status} ${res.statusText}`);
    }
    raw = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const { data, content } = matter(raw);
  const fm = data as Partial<SkillFrontmatter>;
  validateFrontmatter(fm, source); // throws + narrows fm to SkillFrontmatter if valid

  const skillId = id ?? deriveIdFromSource(source);

  const { verdict, findings } = guardSkillContent(content, 'hub');
  if (verdict !== 'allow') {
    const approved = opts.onApprovalNeeded ? await opts.onApprovalNeeded(skillId, verdict, findings) : false;
    if (!approved) {
      throw new Error(
        `[SvaraJS] Skill from "${source}" was not installed (${verdict}): ` +
        findings.map((f) => f.description).join('; ')
      );
    }
  }

  await registry.create(skillId, {
    ...fm,
    metadata: { ...fm.metadata, trust: 'hub' },
  }, content);

  return { id: skillId, name: fm.name };
}

export function createSkillHubTool(registry: SkillRegistry, opts: SkillHubOptions = {}): Tool {
  return {
    name: 'skill_install',
    description:
      'Install a skill from a public GitHub repo. Accepts "owner/repo", "owner/repo@branch/path/to/skill", ' +
      'or a full raw SKILL.md URL. Installed skills go through the strictest trust tier and may need approval.',
    parameters: {
      source: { type: 'string', description: 'owner/repo[@ref][/path], or a raw SKILL.md URL', required: true },
      id: { type: 'string', description: 'Local skill id to install as (default: derived from the source)' },
    },
    async run({ source, id }) {
      try {
        const result = await installSkillFromHub(String(source), registry, opts, id ? String(id) : undefined);
        return { installed: result.id, name: result.name };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  };
}
