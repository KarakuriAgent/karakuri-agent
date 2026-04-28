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
    expect(instructions).toContain('`karakuri_world_conversation_join`');
    expect(instructions).toContain('`karakuri_world_conversation_stay`');
    expect(instructions).toContain('`karakuri_world_conversation_leave`');
    expect(instructions).toContain('`karakuri_world_transfer`');
    expect(instructions).toContain('`karakuri_world_accept_transfer`');
    expect(instructions).toContain('`karakuri_world_reject_transfer`');
    expect(instructions).toContain('`karakuri_world_end_conversation`');
    expect(instructions).toContain('next_speaker_agent_id');
    expect(instructions).toContain('transfer_response');
    expect(instructions).toContain('in_transfer');
    expect(instructions).toMatch(/STANDALONE|standalone/);
    expect(instructions).toMatch(/IN-CONVERSATION|in_conversation/);
    expect(instructions).toContain('auto-rejected');
    expect(instructions).toContain('transfer_status: "failed"');
    expect(instructions).toContain('failure_reason');
    // 新仕様 (item|money 排他、in_action から開始可) の文言が含まれていること
    expect(instructions).toContain('idle or in_action');
    expect(instructions).toContain('idle / in_action');
    expect(instructions).toMatch(/EITHER `item`.*OR `money`/);
    // 旧 items 配列フィールド形式の JSON 例が残っていないこと
    expect(instructions).not.toContain('"items":');
    expect(instructions).not.toContain('"items":[');
    expect(normalized).toContain('inactive_check');
    expect(instructions).toContain('2-person conversations');
    expect(instructions).toContain('3 or more participants');
    expect(instructions).toContain('Do NOT pass `next_speaker_agent_id` to `karakuri_world_conversation_leave`');
    expect(instructions).toContain('"target_node_id": "4-1"');
    expect(instructions).toContain('"next_speaker_agent_id": "agent-xyz"');
    expect(instructions).not.toContain('get_available_actions');
    expect(instructions).not.toContain('duration_ms');
    expect(instructions).toContain('duration_minutes');
    expect(instructions).toContain('"action_id"');
  });
});
