import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FilePromptContextStore } from '../src/agent/prompt-context.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createDataDir() {
  const directory = await mkdtemp(join(tmpdir(), 'karakuri-prompt-context-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('FilePromptContextStore', () => {
  it('loads AGENT.md and RULES.md when present', async () => {
    const dataDir = await createDataDir();
    await writeFile(join(dataDir, 'AGENT.md'), 'Custom agent', 'utf8');
    await writeFile(join(dataDir, 'RULES.md'), 'Be careful', 'utf8');

    const store = await FilePromptContextStore.create({ dataDir });

    await expect(store.read()).resolves.toEqual({
      agentInstructions: 'Custom agent',
      rules: 'Be careful',
    });

    await store.close();
  });

  it('eagerly reloads prompt context updates', async () => {
    const dataDir = await createDataDir();
    const store = await FilePromptContextStore.create({ dataDir });

    await writeFile(join(dataDir, 'AGENT.md'), 'Updated agent', 'utf8');
    await writeFile(join(dataDir, 'RULES.md'), 'Ask before guessing', 'utf8');

    await vi.waitFor(async () => {
      await expect(store.read()).resolves.toEqual({
        agentInstructions: 'Updated agent',
        rules: 'Ask before guessing',
      });
    }, { timeout: 1_500 });

    await store.close();
  });
});
