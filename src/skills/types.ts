/**
 * @module skills/types
 * A "skill" is a directory containing SKILL.md (YAML frontmatter + Markdown
 * body) plus optional `references/`, `templates/`, `scripts/`, `assets/`
 * subfolders - a reusable playbook the agent can discover, read on demand,
 * and (via skill_manage) write for itself. Frontmatter shape follows the
 * open agentskills.io convention (progressive disclosure: metadata tier ->
 * full body tier -> linked-file tier).
 */

export type SkillPlatform = 'macos' | 'linux' | 'windows';

/** How this skill came to exist - drives the guard policy in skills/guard.ts. */
export type SkillTrust = 'human' | 'agent-created' | 'hub';

export interface SkillPrerequisites {
  /** Env vars this skill expects to be set (informational - not enforced). */
  env_vars?: string[];
}

export interface SkillMetadata {
  tags?: string[];
  related_skills?: string[];
  /** Set automatically by skill_manage when the agent authors a skill for itself. */
  trust?: SkillTrust;
}

export interface SkillFrontmatter {
  /** Max 64 chars - keeps the skills_list index compact. */
  name: string;
  /**
   * Max 1024 chars, but only the first ~60 chars are guaranteed to render in
   * the compact skills_list index - keep the lead-in short and put detail
   * after it if you need more.
   */
  description: string;
  version?: string;
  license?: string;
  platforms?: SkillPlatform[];
  prerequisites?: SkillPrerequisites;
  metadata?: SkillMetadata;
}

/** Filenames found under a skill's references/templates/scripts/assets subfolders (metadata tier - not loaded). */
export interface SkillResources {
  references: string[];
  templates: string[];
  scripts: string[];
  assets: string[];
}

/** Lightweight metadata - what `skills_list` returns. Cheap: no body content. */
export interface SkillMeta extends SkillFrontmatter {
  /** Folder name under skillsDir; the id used by skill_view/skill_manage. */
  id: string;
  /** Absolute path to the skill's directory. */
  path: string;
  resources: SkillResources;
}

/** Full skill - what `skill_view` returns. */
export interface Skill extends SkillMeta {
  /** The Markdown body (instructions) below the frontmatter. */
  body: string;
}
