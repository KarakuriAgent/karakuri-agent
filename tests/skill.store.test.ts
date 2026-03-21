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

async function writeSkill(dataDir: string, name: string, markdown: string): Promise<void> {
  const directory = join(dataDir, 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), markdown, 'utf8');
}

describe('FileSkillStore', () => {
  it('loads enabled skills from disk', async () => {
    const dataDir = await createDataDir();
    await writeSkill(dataDir, 'code-review', `---\nname: code-review\ndescription: Review code\n---\nCheck security.`);

    const store = await FileSkillStore.create({ dataDir });

    await expect(store.listSkills()).resolves.toEqual([
      {
        name: 'code-review',
        description: 'Review code',
        enabled: true,
        instructions: 'Check security.',
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

  it('eagerly reloads skill edits and keeps last-known-good on runtime parse failure', async () => {
    const dataDir = await createDataDir();
    await writeSkill(dataDir, 'code-review', `---\nname: code-review\ndescription: Review code\n---\nFirst version.`);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = await FileSkillStore.create({ dataDir });

    await writeSkill(dataDir, 'code-review', `---\nname: code-review\ndescription: Review code\n---\nSecond version.`);
    await vi.waitFor(async () => {
      await expect(store.getSkill('code-review')).resolves.toMatchObject({
        instructions: 'Second version.',
      });
    }, { timeout: 1_500 });

    await writeSkill(dataDir, 'code-review', `---\nname: code-review\ndescription: Review code\nowner: bad\n---\nBroken.`);
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
    await writeSkill(dataDir, 'skill-a', `---\nname: skill-a\ndescription: A\n---\nA instructions.`);
    await writeSkill(dataDir, 'skill-b', `---\nname: skill-b\ndescription: B\n---\nB instructions.`);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = await FileSkillStore.create({ dataDir });

    const initial = await store.listSkills();
    expect(initial).toHaveLength(2);

    // Break skill-b and delete skill-a simultaneously
    await writeSkill(dataDir, 'skill-b', `---\nname: skill-b\ndescription: B\nowner: bad\n---\nBroken.`);
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
    await writeSkill(dataDir, 'code-review', `---\nname: code-review\ndescription: Review code\nowner: bad\n---\nBroken.`);

    await expect(FileSkillStore.create({ dataDir })).rejects.toThrow(/Unknown frontmatter key/);
  });
});
