import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { SkillRegistry } from '../skills/registry.js';

describe('SkillRegistry', () => {
  let skillsDir: string;
  let registry: SkillRegistry;

  beforeEach(async () => {
    skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'svara-skills-'));
    registry = new SkillRegistry({ skillsDir });
  });

  afterEach(async () => {
    await fs.rm(skillsDir, { recursive: true, force: true });
  });

  it('returns an empty list when skillsDir does not exist yet', async () => {
    const emptyRegistry = new SkillRegistry({ skillsDir: path.join(skillsDir, 'does-not-exist') });
    expect(await emptyRegistry.list()).toEqual([]);
  });

  it('creates a skill and lists its metadata', async () => {
    await registry.create('greet', { name: 'Greeting', description: 'Say hello politely' }, 'Always greet the user by name.');
    const list = await registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'greet', name: 'Greeting', description: 'Say hello politely' });
  });

  it('get() returns the full body', async () => {
    await registry.create('greet', { name: 'Greeting', description: 'Say hello' }, 'Body text here.');
    const skill = await registry.get('greet');
    expect(skill?.body).toBe('Body text here.');
  });

  it('rejects creating a duplicate id', async () => {
    await registry.create('greet', { name: 'Greeting', description: 'Say hello' }, 'body');
    await expect(registry.create('greet', { name: 'x', description: 'y' }, 'z')).rejects.toThrow(/already exists/);
  });

  it('rejects an id with unsafe characters', async () => {
    await expect(registry.create('../escape', { name: 'x', description: 'y' }, 'z')).rejects.toThrow(/Invalid skill id/);
  });

  it('edit() updates description and body', async () => {
    await registry.create('greet', { name: 'Greeting', description: 'v1' }, 'body v1');
    await registry.edit('greet', { frontmatter: { description: 'v2' }, body: 'body v2' });
    const skill = await registry.get('greet');
    expect(skill?.description).toBe('v2');
    expect(skill?.body).toBe('body v2');
  });

  it('edit() on a missing skill throws', async () => {
    await expect(registry.edit('missing', { body: 'x' })).rejects.toThrow(/not found/);
  });

  it('delete() removes the skill directory', async () => {
    await registry.create('greet', { name: 'Greeting', description: 'v1' }, 'body');
    await registry.delete('greet');
    expect(await registry.get('greet')).toBeUndefined();
    expect(await registry.list()).toEqual([]);
  });

  it('skips directories without a valid SKILL.md instead of throwing', async () => {
    await fs.mkdir(path.join(skillsDir, 'not-a-skill'));
    await fs.writeFile(path.join(skillsDir, 'not-a-skill', 'README.md'), 'not a skill file');
    const list = await registry.list();
    expect(list).toEqual([]);
  });

  it('rejects a name over 64 characters at create time', async () => {
    await expect(
      registry.create('greet', { name: 'x'.repeat(65), description: 'd' }, 'body')
    ).rejects.toThrow(/64 characters or fewer/);
  });

  it('skips a skill with an over-length name found on disk, instead of throwing during scan', async () => {
    await fs.mkdir(path.join(skillsDir, 'longname'));
    await fs.writeFile(
      path.join(skillsDir, 'longname', 'SKILL.md'),
      `---\nname: ${'x'.repeat(65)}\ndescription: d\n---\nbody\n`
    );
    const list = await registry.list();
    expect(list.find((s) => s.id === 'longname')).toBeUndefined();
  });

  it('persists version, license, platforms, and metadata.tags/related_skills', async () => {
    await registry.create('deploy', {
      name: 'Deploy',
      description: 'How to deploy',
      version: '1.0.0',
      license: 'MIT',
      platforms: ['linux', 'macos'],
      prerequisites: { env_vars: ['DEPLOY_TOKEN'] },
      metadata: { tags: ['ops'], related_skills: ['rollback'] },
    }, 'Run the deploy script.');

    const skill = await registry.get('deploy');
    expect(skill?.version).toBe('1.0.0');
    expect(skill?.license).toBe('MIT');
    expect(skill?.platforms).toEqual(['linux', 'macos']);
    expect(skill?.prerequisites?.env_vars).toEqual(['DEPLOY_TOKEN']);
    expect(skill?.metadata?.tags).toEqual(['ops']);
    expect(skill?.metadata?.related_skills).toEqual(['rollback']);
  });

  it('lists filenames under references/templates/scripts/assets without loading their content', async () => {
    await registry.create('deploy', { name: 'Deploy', description: 'd' }, 'body');
    await fs.mkdir(path.join(skillsDir, 'deploy', 'references'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'deploy', 'references', 'runbook.md'), 'detailed runbook');
    await fs.mkdir(path.join(skillsDir, 'deploy', 'scripts'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'deploy', 'scripts', 'deploy.sh'), '#!/bin/sh');

    await registry.scan(); // registry doesn't watch the filesystem - force a re-scan after manual fs writes
    const skill = await registry.get('deploy');
    expect(skill?.resources.references).toEqual(['runbook.md']);
    expect(skill?.resources.scripts).toEqual(['deploy.sh']);
    expect(skill?.resources.templates).toEqual([]);
    expect(skill?.resources.assets).toEqual([]);
  });

  it('readResourceFile loads a linked file, writeResourceFile creates one, removeResourceFile deletes it', async () => {
    await registry.create('deploy', { name: 'Deploy', description: 'd' }, 'body');
    await registry.writeResourceFile('deploy', 'references', 'runbook.md', 'step 1\nstep 2');

    const content = await registry.readResourceFile('deploy', 'references', 'runbook.md');
    expect(content).toBe('step 1\nstep 2');

    const skill = await registry.get('deploy');
    expect(skill?.resources.references).toEqual(['runbook.md']);

    await registry.removeResourceFile('deploy', 'references', 'runbook.md');
    const after = await registry.get('deploy');
    expect(after?.resources.references).toEqual([]);
  });

  it('readResourceFile blocks path traversal outside the skill directory', async () => {
    await registry.create('deploy', { name: 'Deploy', description: 'd' }, 'body');
    await expect(registry.readResourceFile('deploy', 'references', '../../../etc/passwd')).rejects.toThrow();
  });
});
