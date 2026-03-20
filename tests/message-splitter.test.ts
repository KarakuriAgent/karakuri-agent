import { describe, expect, it } from 'vitest';

import { DISCORD_MESSAGE_LIMIT, splitMessageForDiscord } from '../src/utils/message-splitter.js';

describe('splitMessageForDiscord', () => {
  it('splits long plain text without dropping content', () => {
    const message = 'a'.repeat(DISCORD_MESSAGE_LIMIT + 120);

    const chunks = splitMessageForDiscord(message);

    expect(chunks).toHaveLength(2);
    expect(chunks.join('')).toBe(message);
    expect(chunks.every((chunk) => chunk.length <= DISCORD_MESSAGE_LIMIT)).toBe(true);
  });

  it('preserves content around code blocks without adding extra whitespace', () => {
    const message = 'Before\n\n```ts\nconst x = 1;\n```\nAfter';
    const chunks = splitMessageForDiscord(message);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(message);
  });

  it('re-wraps oversized code blocks so each chunk keeps balanced fences', () => {
    const message = `Before\n\n\`\`\`ts\n${'x'.repeat(DISCORD_MESSAGE_LIMIT + 200)}\n\`\`\``;

    const chunks = splitMessageForDiscord(message);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= DISCORD_MESSAGE_LIMIT)).toBe(true);
    expect(
      chunks
        .filter((chunk) => chunk.includes('```'))
        .every((chunk) => (chunk.match(/```/g) ?? []).length % 2 === 0),
    ).toBe(true);
  });
});
