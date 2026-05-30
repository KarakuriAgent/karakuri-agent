import { describe, expect, it } from 'vitest';

import {
  buildKarakuriWorldModeInstructions,
  KARAKURI_WORLD_COMMAND_TOOL_NAME,
  KARAKURI_WORLD_TOOL_PREFIX,
  KW_MODE_MAX_STEPS,
} from '../src/karakuri-world/builtin-instructions.js';

describe('karakuri-world builtin instructions', () => {
  it('exports stable mode constants', () => {
    expect(KARAKURI_WORLD_TOOL_PREFIX).toBe('karakuri_world_');
    expect(KARAKURI_WORLD_COMMAND_TOOL_NAME).toBe('karakuri_world_command');
    expect(KW_MODE_MAX_STEPS).toBe(1);
  });

  it('describes fetched-notification command selection behavior', () => {
    const instructions = buildKarakuriWorldModeInstructions();
    const normalized = instructions.toLowerCase();

    expect(instructions).toContain('KarakuriWorld mode is active.');
    expect(instructions).toContain('get_notification');
    expect(instructions).toContain('`karakuri_world_command`');
    expect(instructions).toContain('notification.choices[]');
    expect(instructions).toContain('choices[].params');
    expect(instructions).toContain('required_params');
    expect(instructions).toContain('param_schema');
    expect(instructions).toContain('param_constraints');
    expect(instructions).toContain('Do not put `notification_id` in tool input');
    expect(instructions).toContain('comment');
    expect(instructions).toContain('in-character action line');
    expect(instructions).toContain('current role/persona');
    expect(instructions).toContain('Do not expose private chain-of-thought');
    expect(normalized).toContain('idle_reminder');
    expect(instructions).toContain('Choose `wait` only');
    expect(instructions).toContain('intended destination node directly');
    expect(instructions).toContain('farthest reachable listed node');
    expect(instructions).toContain('get_perception');
    expect(instructions).toContain('get_available_actions');
    expect(instructions).toContain('get_map');
    expect(instructions).toContain('data');
    expect(instructions).toContain('Do not execute a second command');
    expect(instructions).toContain('transfer_response');
    expect(instructions).toContain('next_speaker_agent_id');
    expect(instructions).toContain('"command": "move"');
    expect(instructions).not.toContain('karakuri_world_get_map');
    expect(instructions).not.toContain('karakuri_world_move');
    expect(instructions).not.toContain('duration_ms');
  });
});
