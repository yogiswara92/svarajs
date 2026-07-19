/**
 * @module skills/tools
 * `skills_list` / `skill_view` - progressive disclosure over the skill registry
 * (metadata tier -> full SKILL.md body -> one linked file from
 * references/templates/scripts/assets).
 * `skill_manage` - lets the agent create/edit/delete skills and manage their
 * linked files (write_file/remove_file), gated by skills/guard.ts when
 * `guardAgentCreated` is enabled.
 */

import { guardSkillContent } from './guard.js';
import type { Tool } from '../types.js';
import type { SkillRegistry } from './registry.js';
import type { SkillFrontmatter, SkillTrust } from './types.js';

const INDEX_DESCRIPTION_LIMIT = 60;
const RESOURCE_DIRS = ['references', 'templates', 'scripts', 'assets'] as const;

export interface SkillToolsOptions {
  /**
   * Scan agent-created skill content for dangerous patterns (destructive/
   * exfiltration) before writing, prompting `onDangerousContent` if given.
   * Off by default.
   */
  guardAgentCreated?: boolean;
  /** Called when guarded content needs a yes/no decision. No callback = dangerous content is blocked, not allowed through. */
  onDangerousContent?: (skillId: string, findings: Array<{ category: string; description: string }>) => Promise<boolean>;
}

export function createSkillTools(registry: SkillRegistry, opts: SkillToolsOptions = {}): Tool[] {
  const skillsList: Tool = {
    name: 'skills_list',
    description:
      'List available skills (id, name, short description, tags, and which reference/template/script/asset ' +
      'files each one has). Call skill_view with an id to load the full instructions before using a skill.',
    parameters: {},
    async run() {
      const metas = await registry.list();
      return {
        skills: metas.map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description.length > INDEX_DESCRIPTION_LIMIT
            ? `${m.description.slice(0, INDEX_DESCRIPTION_LIMIT)}...`
            : m.description,
          tags: m.metadata?.tags,
          resources: m.resources,
        })),
      };
    },
  };

  const skillView: Tool = {
    name: 'skill_view',
    description:
      'Load the full Markdown instructions for a skill by id (from skills_list). Pass "resourceDir" and ' +
      '"filename" instead to load one specific linked file from that skill\'s references/templates/scripts/assets folder.',
    parameters: {
      id: { type: 'string', description: 'Skill id', required: true },
      resourceDir: { type: 'string', description: 'One of: references, templates, scripts, assets - loads a linked file instead of the main body', enum: [...RESOURCE_DIRS] },
      filename: { type: 'string', description: 'Filename within resourceDir (required if resourceDir is set)' },
    },
    async run({ id, resourceDir, filename }) {
      const skillId = String(id);

      if (resourceDir) {
        if (!filename) return { error: '"filename" is required when "resourceDir" is set.' };
        try {
          const content = await registry.readResourceFile(skillId, resourceDir as (typeof RESOURCE_DIRS)[number], String(filename));
          return { id: skillId, resourceDir, filename, content };
        } catch (err) {
          return { error: (err as Error).message };
        }
      }

      const skill = await registry.get(skillId);
      if (!skill) return { error: `Skill "${id}" not found. Call skills_list to see available ids.` };
      const { body: _body, path: _path, ...meta } = skill;
      return { ...meta, instructions: skill.body };
    },
  };

  const skillManage: Tool = {
    name: 'skill_manage',
    description:
      'Create, edit, or delete a skill, or write/remove a file in its references/templates/scripts/assets ' +
      'folder. Use "create" to save a successful approach as a reusable playbook - write clear, general ' +
      'instructions, not a transcript of this conversation.',
    parameters: {
      action: { type: 'string', description: 'One of: create, edit, delete, write_file, remove_file', required: true, enum: ['create', 'edit', 'delete', 'write_file', 'remove_file'] },
      id: { type: 'string', description: 'Skill id - folder-safe: letters, numbers, underscores, hyphens', required: true },
      name: { type: 'string', description: 'Human-readable skill name, max 64 chars (required for create)' },
      description: { type: 'string', description: 'Description shown in skills_list, max 1024 chars (required for create)' },
      instructions: { type: 'string', description: 'Full skill body in Markdown (required for create)' },
      version: { type: 'string', description: 'Optional skill version' },
      license: { type: 'string', description: 'Optional license identifier' },
      platforms: { type: 'array', description: 'Optional: subset of ["macos", "linux", "windows"] this skill applies to' },
      tags: { type: 'array', description: 'Optional tags for organization' },
      relatedSkills: { type: 'array', description: 'Optional ids of related skills' },
      envVars: { type: 'array', description: 'Optional env var names this skill expects to be set' },
      resourceDir: { type: 'string', description: 'One of: references, templates, scripts, assets (required for write_file/remove_file)', enum: [...RESOURCE_DIRS] },
      filename: { type: 'string', description: 'Filename within resourceDir (required for write_file/remove_file)' },
      content: { type: 'string', description: 'File content (required for write_file)' },
    },
    async run(args) {
      const action = String(args.action);
      const id = String(args.id);

      try {
        switch (action) {
          case 'create': {
            if (!args.name || !args.description || !args.instructions) {
              return { error: 'create requires "name", "description", and "instructions".' };
            }
            const frontmatter = buildFrontmatter(args, 'agent-created');
            const body = String(args.instructions);

            const decision = await applyGuard(id, body, 'agent-created', opts);
            if (decision !== 'proceed') return decision;

            await registry.create(id, frontmatter, body);
            return { created: id };
          }
          case 'edit': {
            const body = args.instructions !== undefined ? String(args.instructions) : undefined;
            if (body !== undefined) {
              const existing = await registry.get(id);
              const decision = await applyGuard(id, body, existing?.metadata?.trust ?? 'agent-created', opts);
              if (decision !== 'proceed') return decision;
            }
            await registry.edit(id, {
              frontmatter: hasFrontmatterUpdates(args) ? buildFrontmatter(args, undefined) : undefined,
              body,
            });
            return { edited: id };
          }
          case 'delete': {
            await registry.delete(id);
            return { deleted: id };
          }
          case 'write_file': {
            if (!args.resourceDir || !args.filename || args.content === undefined) {
              return { error: 'write_file requires "resourceDir", "filename", and "content".' };
            }
            await registry.writeResourceFile(id, args.resourceDir as (typeof RESOURCE_DIRS)[number], String(args.filename), String(args.content));
            return { written: id, resourceDir: args.resourceDir, filename: args.filename };
          }
          case 'remove_file': {
            if (!args.resourceDir || !args.filename) {
              return { error: 'remove_file requires "resourceDir" and "filename".' };
            }
            await registry.removeResourceFile(id, args.resourceDir as (typeof RESOURCE_DIRS)[number], String(args.filename));
            return { removed: id, resourceDir: args.resourceDir, filename: args.filename };
          }
          default:
            return { error: `Unknown action "${action}". Use create, edit, delete, write_file, or remove_file.` };
        }
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  };

  return [skillsList, skillView, skillManage];
}

function hasFrontmatterUpdates(args: Record<string, unknown>): boolean {
  return ['name', 'description', 'version', 'license', 'platforms', 'tags', 'relatedSkills', 'envVars']
    .some((k) => args[k] !== undefined);
}

function buildFrontmatter(args: Record<string, unknown>, trust: SkillTrust | undefined): SkillFrontmatter {
  const hasMetadata = args.tags !== undefined || args.relatedSkills !== undefined || trust !== undefined;
  const hasPrerequisites = args.envVars !== undefined;

  return {
    name: args.name as string,
    description: args.description as string,
    version: args.version as string | undefined,
    license: args.license as string | undefined,
    platforms: args.platforms as SkillFrontmatter['platforms'],
    prerequisites: hasPrerequisites ? { env_vars: args.envVars as string[] } : undefined,
    metadata: hasMetadata ? { tags: args.tags as string[] | undefined, related_skills: args.relatedSkills as string[] | undefined, trust } : undefined,
  };
}

type GuardDecision = 'proceed' | { error: string };

async function applyGuard(
  skillId: string,
  body: string,
  trust: SkillTrust | undefined,
  opts: SkillToolsOptions
): Promise<GuardDecision> {
  if (!opts.guardAgentCreated || trust !== 'agent-created') return 'proceed';

  const { verdict, findings } = guardSkillContent(body, 'agent-created');
  if (verdict === 'allow') return 'proceed';

  if (verdict === 'ask' && opts.onDangerousContent) {
    const approved = await opts.onDangerousContent(skillId, findings);
    return approved ? 'proceed' : { error: `Skill "${skillId}" content was not approved: ${findings.map((f) => f.description).join('; ')}` };
  }

  return { error: `Skill "${skillId}" content flagged as dangerous and no approval callback is configured: ${findings.map((f) => f.description).join('; ')}` };
}
