import { mkdir, mkdtemp, rm, writeFile, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileSkillStore } from '../src/skill/store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createDataDir() {
  const directory = await mkdtemp(join(tmpdir(), 'karakuri-skill-store-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeSkill(
  dataDir: string,
  name: string,
  markdown: string,
  source: 'skills' | 'system-skills' = 'skills',
): Promise<void> {
  const directory = join(dataDir, source, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), markdown, 'utf8');
}

describe('FileSkillStore', () => {
  it('loads skills from disk', async () => {
    const dataDir = await createDataDir();
    await writeSkill(dataDir, 'code-review', `---
name: code-review
description: Review code
---
Check security.`);

    const store = await FileSkillStore.create({ dataDir });

    await expect(store.listSkills()).resolves.toEqual([
      {
        name: 'code-review',
        description: 'Review code',
        instructions: 'Check security.',
        systemOnly: false,
      },
    ]);

    await store.close();
  });

  it('ignores missing skills directories', async () => {
    const dataDir = await createDataDir();
    const store = await FileSkillStore.create({ dataDir });

    await expect(store.listSkills()).resolves.toEqual([]);
    await store.close();
  });

  it('round-trips allowed-tools metadata from SKILL.md', async () => {
    const dataDir = await createDataDir();
    await writeSkill(dataDir, 'karakuri-world', `---
name: karakuri-world
description: Explore the world
allowed-tools: karakuri_world_get_map, karakuri_world_move
---
Observe first.`);

    const store = await FileSkillStore.create({ dataDir });

    await expect(store.listSkills()).resolves.toEqual([
      {
        name: 'karakuri-world',
        description: 'Explore the world',
        allowedTools: ['karakuri_world_get_map', 'karakuri_world_move'],
        instructions: 'Observe first.',
        systemOnly: false,
      },
    ]);

    await store.close();
  });

  it('hides system skills by default and includes them on request', async () => {
    const dataDir = await createDataDir();
    await writeSkill(dataDir, 'shared-skill', `---
name: shared-skill
description: Shared
---
Shared instructions.`);
    await writeSkill(dataDir, 'system-skill', `---
name: system-skill
description: System
---
System instructions.`, 'system-skills');

    const store = await FileSkillStore.create({ dataDir });

    await expect(store.listSkills()).resolves.toEqual([
      {
        name: 'shared-skill',
        description: 'Shared',
        instructions: 'Shared instructions.',
        systemOnly: false,
      },
    ]);
    await expect(store.listSkills({ includeSystemOnly: true })).resolves.toEqual([
      {
        name: 'shared-skill',
        description: 'Shared',
        instructions: 'Shared instructions.',
        systemOnly: false,
      },
      {
        name: 'system-skill',
        description: 'System',
        instructions: 'System instructions.',
        systemOnly: true,
      },
    ]);
    await expect(store.getSkill('system-skill')).resolves.toBeNull();
    await expect(store.getSkill('system-skill', { includeSystemOnly: true })).resolves.toEqual({
      name: 'system-skill',
      description: 'System',
      instructions: 'System instructions.',
      systemOnly: true,
    });

    await store.close();
  });

  it('detects duplicate skill names across shared and system sources', async () => {
    const dataDir = await createDataDir();
    await writeSkill(dataDir, 'shared', `---
name: duplicate
description: Shared
---
Shared instructions.`);
    await writeSkill(dataDir, 'system', `---
name: duplicate
description: System
---
System instructions.`, 'system-skills');

    await expect(FileSkillStore.create({ dataDir })).rejects.toThrow(/Duplicate skill name/);
  });

  it('eagerly reloads skill edits and keeps last-known-good on runtime parse failure', async () => {
    const dataDir = await createDataDir();
    await writeSkill(dataDir, 'code-review', `---
name: code-review
description: Review code
---
First version.`);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = await FileSkillStore.create({ dataDir });

    await writeSkill(dataDir, 'code-review', `---
name: code-review
description: Review code
---
Second version.`);
    await vi.waitFor(async () => {
      await expect(store.getSkill('code-review')).resolves.toMatchObject({
        instructions: 'Second version.',
      });
    }, { timeout: 1_500 });

    await writeSkill(dataDir, 'code-review', `---
name: code-review
description: Review code
owner: bad
---
Broken.`);
    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalled();
    }, { timeout: 1_500 });
    await expect(store.getSkill('code-review')).resolves.toMatchObject({
      instructions: 'Second version.',
    });

    warnSpy.mockRestore();
    await store.close();
  });

  it('removes a deleted skill while keeping last-known-good for a broken sibling', async () => {
    const dataDir = await createDataDir();
    await writeSkill(dataDir, 'skill-a', `---
name: skill-a
description: A
---
A instructions.`);
    await writeSkill(dataDir, 'skill-b', `---
name: skill-b
description: B
---
B instructions.`);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = await FileSkillStore.create({ dataDir });

    const initial = await store.listSkills();
    expect(initial).toHaveLength(2);

    await writeSkill(dataDir, 'skill-b', `---
name: skill-b
description: B
owner: bad
---
Broken.`);
    await unlink(join(dataDir, 'skills', 'skill-a', 'SKILL.md'));
    await rmdir(join(dataDir, 'skills', 'skill-a'));

    await vi.waitFor(async () => {
      expect(warnSpy).toHaveBeenCalled();
      await expect(store.getSkill('skill-a')).resolves.toBeNull();
      const skills = await store.listSkills();
      expect(skills.map((s) => s.name)).toEqual(['skill-b']);
      await expect(store.getSkill('skill-b')).resolves.toMatchObject({
        instructions: 'B instructions.',
      });
    }, { timeout: 2_000 });

    warnSpy.mockRestore();
    await store.close();
  });

  it('fails fast on invalid startup skill files', async () => {
    const dataDir = await createDataDir();
    await writeSkill(dataDir, 'code-review', `---
name: code-review
description: Review code
owner: bad
---
Broken.`);

    await expect(FileSkillStore.create({ dataDir })).rejects.toThrow(/Unknown frontmatter key/);
  });
});
