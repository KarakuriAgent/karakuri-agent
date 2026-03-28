import { describe, expect, it } from 'vitest';

import {
  buildKarakuriWorldModeInstructions,
  KARAKURI_WORLD_TOOL_PREFIX,
  KW_MODE_MAX_STEPS,
} from '../src/karakuri-world/builtin-instructions.js';

describe('karakuri-world builtin instructions', () => {
  it('exports stable mode constants', () => {
    expect(KARAKURI_WORLD_TOOL_PREFIX).toBe('karakuri_world_');
    expect(KW_MODE_MAX_STEPS).toBe(1);
  });

  it('describes single-step world-action behavior and required comments', () => {
    const instructions = buildKarakuriWorldModeInstructions();
    const normalized = instructions.toLowerCase();

    expect(instructions).toContain('KarakuriWorld mode is active.');
    expect(normalized).toContain('you must call exactly one karakuri-world tool');
    expect(instructions).toContain('`comment` field');
    expect(instructions).toContain('`karakuri_world_get_map`');
    expect(instructions).toContain('`karakuri_world_move`');
    expect(instructions).toContain('`karakuri_world_end_conversation`');
    expect(instructions).toContain('"target_node_id": "4-1"');
    expect(instructions).not.toContain('get_available_actions');
    expect(instructions).not.toContain('duration_ms');
  });
});
