import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { SkillRegistry } from '../skills/registry.js';
import { createSkillTools } from '../skills/tools.js';
import type { AgentContext } from '../types.js';

const ctx = {} as AgentContext;

describe('createSkillTools', () => {
  let skillsDir: string;
  let registry: SkillRegistry;
  let tools: ReturnType<typeof createSkillTools>;

  beforeEach(async () => {
    skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'svara-skill-tools-'));
    registry = new SkillRegistry({ skillsDir });
    tools = createSkillTools(registry);
  });

  afterEach(async () => {
    await fs.rm(skillsDir, { recursive: true, force: true });
  });

  it('skill_manage create + skills_list + skill_view round-trip', async () => {
    const [skillsList, skillView, skillManage] = tools;

    const created = await skillManage.run({
      action: 'create',
      id: 'onboarding',
      name: 'Onboarding',
      description: 'Steps to onboard a new user',
      instructions: 'Step 1. Step 2.',
    }, ctx) as { created: string };
    expect(created.created).toBe('onboarding');

    const list = await skillsList.run({}, ctx) as { skills: Array<{ id: string }> };
    expect(list.skills.map((s) => s.id)).toEqual(['onboarding']);

    const view = await skillView.run({ id: 'onboarding' }, ctx) as { instructions: string };
    expect(view.instructions).toBe('Step 1. Step 2.');
  });

  it('skill_view reports a clear error for an unknown id', async () => {
    const [, skillView] = tools;
    const result = await skillView.run({ id: 'nope' }, ctx) as { error: string };
    expect(result.error).toMatch(/not found/);
  });

  it('skill_manage create without required fields returns an error instead of throwing', async () => {
    const [, , skillManage] = tools;
    const result = await skillManage.run({ action: 'create', id: 'x' }, ctx) as { error: string };
    expect(result.error).toMatch(/requires/);
  });

  it('skill_manage delete removes the skill', async () => {
    const [skillsList, , skillManage] = tools;
    await skillManage.run({ action: 'create', id: 'temp', name: 'Temp', description: 'd', instructions: 'i' }, ctx);
    await skillManage.run({ action: 'delete', id: 'temp' }, ctx);
    const list = await skillsList.run({}, ctx) as { skills: unknown[] };
    expect(list.skills).toEqual([]);
  });

  it('skills_list truncates a long description to 60 chars but skill_view returns it in full', async () => {
    const [skillsList, skillView, skillManage] = tools;
    const longDescription = 'A'.repeat(80);
    await skillManage.run({ action: 'create', id: 'long', name: 'Long', description: longDescription, instructions: 'i' }, ctx);

    const list = await skillsList.run({}, ctx) as { skills: Array<{ description: string }> };
    expect(list.skills[0].description).toBe(`${'A'.repeat(60)}...`);

    const view = await skillView.run({ id: 'long' }, ctx) as { description: string };
    expect(view.description).toBe(longDescription);
  });

  it('skill_manage create stamps metadata.trust as agent-created', async () => {
    const [, skillView, skillManage] = tools;
    await skillManage.run({ action: 'create', id: 'auto', name: 'Auto', description: 'd', instructions: 'i' }, ctx);
    const view = await skillView.run({ id: 'auto' }, ctx) as { metadata?: { trust?: string } };
    expect(view.metadata?.trust).toBe('agent-created');
  });

  it('write_file + skill_view(resourceDir,filename) + remove_file round-trip', async () => {
    const [, skillView, skillManage] = tools;
    await skillManage.run({ action: 'create', id: 'deploy', name: 'Deploy', description: 'd', instructions: 'i' }, ctx);

    const written = await skillManage.run({
      action: 'write_file', id: 'deploy', resourceDir: 'references', filename: 'runbook.md', content: 'step 1',
    }, ctx) as { written: string };
    expect(written.written).toBe('deploy');

    const viewed = await skillView.run({ id: 'deploy', resourceDir: 'references', filename: 'runbook.md' }, ctx) as { content: string };
    expect(viewed.content).toBe('step 1');

    const removed = await skillManage.run({ action: 'remove_file', id: 'deploy', resourceDir: 'references', filename: 'runbook.md' }, ctx) as { removed: string };
    expect(removed.removed).toBe('deploy');
  });

  it('skill_view with resourceDir requires filename', async () => {
    const [, skillView, skillManage] = tools;
    await skillManage.run({ action: 'create', id: 'deploy', name: 'Deploy', description: 'd', instructions: 'i' }, ctx);
    const result = await skillView.run({ id: 'deploy', resourceDir: 'references' }, ctx) as { error: string };
    expect(result.error).toMatch(/filename/);
  });

  describe('guardAgentCreated', () => {
    it('blocks dangerous agent-created content when no onDangerousContent callback is given', async () => {
      const guardedRegistry = new SkillRegistry({ skillsDir });
      const [, , skillManage] = createSkillTools(guardedRegistry, { guardAgentCreated: true });

      const result = await skillManage.run({
        action: 'create', id: 'risky', name: 'Risky', description: 'd', instructions: 'Run rm -rf / to reset.',
      }, ctx) as { error: string };
      expect(result.error).toMatch(/dangerous/);
      expect(await guardedRegistry.get('risky')).toBeUndefined();
    });

    it('routes dangerous agent-created content through onDangerousContent and honors approval', async () => {
      const guardedRegistry = new SkillRegistry({ skillsDir });
      const [, , skillManage] = createSkillTools(guardedRegistry, {
        guardAgentCreated: true,
        onDangerousContent: async () => true,
      });

      const result = await skillManage.run({
        action: 'create', id: 'risky', name: 'Risky', description: 'd', instructions: 'Run rm -rf / to reset.',
      }, ctx) as { created: string };
      expect(result.created).toBe('risky');
    });

    it('routes dangerous agent-created content through onDangerousContent and honors rejection', async () => {
      const guardedRegistry = new SkillRegistry({ skillsDir });
      const [, , skillManage] = createSkillTools(guardedRegistry, {
        guardAgentCreated: true,
        onDangerousContent: async () => false,
      });

      const result = await skillManage.run({
        action: 'create', id: 'risky', name: 'Risky', description: 'd', instructions: 'Run rm -rf / to reset.',
      }, ctx) as { error: string };
      expect(result.error).toMatch(/not approved/);
      expect(await guardedRegistry.get('risky')).toBeUndefined();
    });

    it('leaves clean agent-created content unaffected by the guard', async () => {
      const guardedRegistry = new SkillRegistry({ skillsDir });
      const [, , skillManage] = createSkillTools(guardedRegistry, { guardAgentCreated: true });

      const result = await skillManage.run({
        action: 'create', id: 'safe', name: 'Safe', description: 'd', instructions: 'Always greet the user politely.',
      }, ctx) as { created: string };
      expect(result.created).toBe('safe');
    });
  });
});
