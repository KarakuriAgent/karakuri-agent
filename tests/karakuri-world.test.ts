import type { ToolExecutionOptions } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import {
  createKarakuriWorldTools,
  fetchKarakuriWorldNotification,
  isKarakuriWorldNotificationFetchError,
  karakuriWorldCommandInputSchema,
  KarakuriWorldApiError,
  KarakuriWorldResponseError,
} from '../src/agent/tools/karakuri-world.js';

const DEFAULT_OPTIONS: ToolExecutionOptions = {
  toolCallId: 'tool-1',
  messages: [],
};

const NOTIFICATION_RESPONSE = {
  ok: true,
  notification_id: 'notif-123',
  created_at: 1,
  expires_at: 999,
  stale: false,
  notification: {
    schema_version: 1,
    kind: 'idle_reminder',
    summary: '次の行動を選んでください。',
    choices: [
      { command: 'wait', label: '少し待つ', params: {}, required_params: ['duration'] },
    ],
  },
};

describe('karakuri-world tools', () => {
  it('exports only the generic command tool and validates command input shape', () => {
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      notificationId: 'notif-123',
      fetch: vi.fn(),
    });

    expect(Object.keys(tools)).toEqual(['karakuri_world_command']);
    expect(karakuriWorldCommandInputSchema.parse({
      command: 'wait',
      params: { duration: 1 },
      comment: '状況を見るために少し待ちます。',
    })).toEqual({
      command: 'wait',
      params: { duration: 1 },
      comment: '状況を見るために少し待ちます。',
    });
    expect(karakuriWorldCommandInputSchema.parse({
      command: 'get_status',
      comment: '所持品と現在地を確認します。',
    })).toEqual({
      command: 'get_status',
      params: {},
      comment: '所持品と現在地を確認します。',
    });
    expect(() => karakuriWorldCommandInputSchema.parse({
      command: 'wait',
      notification_id: 'notif-123',
      params: { duration: 1 },
      comment: '余計な notification_id は渡しません。',
    })).toThrow();
    expect(() => karakuriWorldCommandInputSchema.parse({
      command: 'wait',
      params: [],
      comment: 'params は object です。',
    })).toThrow();
  });

  it('fetches saved notification detail with bearer auth', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(NOTIFICATION_RESPONSE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const result = await fetchKarakuriWorldNotification({
      apiBaseUrl: 'https://example.com/api/',
      apiKey: 'secret',
      fetch,
    }, 'notif-123');

    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/api/agents/notifications/notif-123',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer secret',
        }),
      }),
    );
    expect(result).toEqual(NOTIFICATION_RESPONSE);
  });

  it('restricts command tool calls to the fetched notification choices before posting', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      notificationId: 'notif-123',
      allowedCommands: ['wait'],
      fetch,
    });
    const inputSchema = tools.karakuri_world_command!.inputSchema as typeof karakuriWorldCommandInputSchema;

    expect(inputSchema.safeParse({
      command: 'wait',
      params: { duration: 1 },
      comment: '一覧にある待機を選びます。',
    }).success).toBe(true);
    expect(inputSchema.safeParse({
      command: 'move',
      params: { target_node_id: '1-2' },
      comment: '一覧にない移動は tool schema で拒否されます。',
    }).success).toBe(false);

    await expect(tools.karakuri_world_command!.execute!({
      command: 'move',
      params: { target_node_id: '1-2' },
      comment: '一覧にない移動は実行時にも拒否されます。',
    }, DEFAULT_OPTIONS)).rejects.toThrow('karakuri-world command is not allowed by this notification: move');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts generic command requests with the bound notification_id', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      ok: true,
      message: 'Wait accepted.',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      notificationId: 'notif-123',
      fetch,
    });

    const result = await tools.karakuri_world_command!.execute!({
      command: 'wait',
      params: { duration: 1 },
      comment: '今は待つのが自然なので10分待機します。',
    }, DEFAULT_OPTIONS);

    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/api/agents/command',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          notification_id: 'notif-123',
          command: 'wait',
          params: { duration: 1 },
        }),
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(result).toEqual({ ok: true, message: 'Wait accepted.' });
  });

  it('returns informational responses for command busy and not_logged_in errors', async () => {
    const busyFetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      error: 'state_conflict',
      message: 'Agent is busy.',
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }));
    const busyTools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      notificationId: 'notif-123',
      fetch: busyFetch,
    });

    await expect(busyTools.karakuri_world_command!.execute!({
      command: 'move',
      params: { target_node_id: '1-2' },
      comment: '移動を試します。',
    }, DEFAULT_OPTIONS)).resolves.toMatchObject({
      status: 'busy',
      message: 'Agent is busy.',
    });

    const notLoggedInFetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      error: 'not_logged_in',
      message: 'Agent is not logged in.',
    }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }));
    const notLoggedInTools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      notificationId: 'notif-123',
      fetch: notLoggedInFetch,
    });

    await expect(notLoggedInTools.karakuri_world_command!.execute!({
      command: 'wait',
      params: { duration: 1 },
      comment: '待機します。',
    }, DEFAULT_OPTIONS)).resolves.toEqual({
      status: 'not_logged_in',
      message: 'Agent is not logged in.',
    });
  });

  it('classifies get_notification API errors so KW mode can skip logout/stale notices', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      error: 'not_logged_in',
      message: 'Agent is not logged in.',
    }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }));

    let caught: unknown;
    try {
      await fetchKarakuriWorldNotification({
        apiBaseUrl: 'https://example.com/api',
        apiKey: 'secret',
        fetch,
      }, 'notif-logout');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(KarakuriWorldApiError);
    expect(isKarakuriWorldNotificationFetchError(caught)).toBe(true);
    expect((caught as KarakuriWorldApiError).operation).toBe('get_notification');
    expect((caught as KarakuriWorldApiError).code).toBe('not_logged_in');
  });

  it('rejects malformed get_notification responses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(fetchKarakuriWorldNotification({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      fetch,
    }, 'notif-123')).rejects.toBeInstanceOf(KarakuriWorldResponseError);
  });

  it('prevents move commands to the current node/building without calling the API (#103)', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const outcomes: Array<{ command: string; failed: boolean }> = [];
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      notificationId: 'notif-123',
      fetch,
      currentNode: { nodeId: '12-13', buildingId: 'building-station', label: '最寄り駅' },
      onCommandOutcome: (outcome) => outcomes.push(outcome),
    });

    const sameNode = await tools.karakuri_world_command!.execute!({
      command: 'move',
      params: { target_node_id: '12-13' },
      comment: '移動するよ。',
    }, DEFAULT_OPTIONS) as { status?: string; message?: string };
    expect(sameNode.status).toBe('same_node');
    expect(sameNode.message).toContain('最寄り駅');

    const sameBuilding = await tools.karakuri_world_command!.execute!({
      command: 'move',
      params: { target_building_id: 'building-station' },
      comment: '駅へ移動するよ。',
    }, DEFAULT_OPTIONS) as { status?: string };
    expect(sameBuilding.status).toBe('same_node');

    expect(fetch).not.toHaveBeenCalled();
    // 無効だった試みとして失敗に数える
    expect(outcomes).toEqual([
      { command: 'move', failed: true },
      { command: 'move', failed: true },
    ]);
  });

  it('short-circuits expired notifications without calling the API (#103)', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const outcomes: Array<{ command: string; failed: boolean }> = [];
    const expiresAt = Date.parse('2026-07-12T00:00:00.000Z');
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      notificationId: 'notif-123',
      fetch,
      expiresAt,
      now: () => new Date(expiresAt + 60_000),
      onCommandOutcome: (outcome) => outcomes.push(outcome),
    });

    const result = await tools.karakuri_world_command!.execute!({
      command: 'conversation_accept',
      params: {},
      comment: '返事するよ。',
    }, DEFAULT_OPTIONS) as { status?: string };
    expect(result.status).toBe('stale');
    expect(fetch).not.toHaveBeenCalled();
    // 積み残し通知の期限切れは中立（失敗ストリークに影響しない）
    expect(outcomes).toEqual([]);
  });

  it('does not treat small non-millisecond expires_at values as expired (#103)', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      notificationId: 'notif-123',
      fetch,
      expiresAt: 999,
      now: () => new Date('2026-07-12T00:00:00.000Z'),
    });

    const result = await tools.karakuri_world_command!.execute!({
      command: 'wait',
      params: {},
      comment: '待つよ。',
    }, DEFAULT_OPTIONS) as { status?: string };
    expect(result.status).toBeUndefined();
    expect(fetch).toHaveBeenCalled();
  });

  it('allows intra-building moves when target_node_id differs from the current node (#103)', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      notificationId: 'notif-123',
      fetch,
      currentNode: { nodeId: '8-7', buildingId: 'building-kanon-house', label: 'リビング' },
    });

    // 同じ建物内の別ノードへの移動は正当（誤ブロックしない）
    const result = await tools.karakuri_world_command!.execute!({
      command: 'move',
      params: { target_node_id: '3-5', target_building_id: 'building-kanon-house' },
      comment: 'ベッドへ移動するよ。',
    }, DEFAULT_OPTIONS) as { status?: string };
    expect(result.status).toBeUndefined();
    expect(fetch).toHaveBeenCalled();
  });

  it('reports success/failure outcomes to the hook (#103)', async () => {
    const outcomes: Array<{ command: string; failed: boolean }> = [];
    const okFetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const okTools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      notificationId: 'notif-123',
      fetch: okFetch,
      onCommandOutcome: (outcome) => outcomes.push(outcome),
    });
    await okTools.karakuri_world_command!.execute!({ command: 'wait', params: {}, comment: '待つよ。' }, DEFAULT_OPTIONS);
    expect(outcomes).toEqual([{ command: 'wait', failed: false }]);

    outcomes.length = 0;
    const errorFetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ error: 'same_node', message: 'Destination node must differ.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }));
    const errorTools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      notificationId: 'notif-123',
      fetch: errorFetch,
      onCommandOutcome: (outcome) => outcomes.push(outcome),
    });
    await expect(errorTools.karakuri_world_command!.execute!({
      command: 'move',
      params: { target_node_id: '1-1' },
      comment: '移動するよ。',
    }, DEFAULT_OPTIONS)).rejects.toBeInstanceOf(KarakuriWorldApiError);
    expect(outcomes).toEqual([{ command: 'move', failed: true }]);
  });

  it('treats busy responses as neutral for the failure streak (#103)', async () => {
    const outcomes: Array<{ command: string; failed: boolean }> = [];
    const busyFetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ error: 'state_conflict', message: 'Agent is busy.' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      notificationId: 'notif-123',
      fetch: busyFetch,
      onCommandOutcome: (outcome) => outcomes.push(outcome),
    });
    const result = await tools.karakuri_world_command!.execute!({
      command: 'move',
      params: { target_node_id: '1-1' },
      comment: '移動するよ。',
    }, DEFAULT_OPTIONS) as { status?: string };
    expect(result.status).toBe('busy');
    // busy はストリークを消しも増やしもしない（フック自体を呼ばない）
    expect(outcomes).toEqual([]);
  });

  it('converts a production-shaped 409 body (hint / suggestions 付き) into an informational response', async () => {
    // 実サーバーのエラーボディには hint / suggestions が付く。以前は .strict()
    // スキーマがパース失敗 → code=undefined → busy 変換が効かず、生の例外が
    // LLM へ届いて「サーバーが混んでいる」と誤解釈された（本番で 100+ 件）
    const conflictFetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      error: 'state_conflict',
      message: 'Agent cannot wait in the current state.',
      details: { state: 'conversation_pending' },
      hint: '会話への応答待ちです。受諾または拒否を選んでください。',
      suggestions: [{ command: 'conversation_accept' }, { command: 'conversation_reject' }],
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      notificationId: 'notif-123',
      fetch: conflictFetch,
    });

    await expect(tools.karakuri_world_command!.execute!({
      command: 'wait',
      params: { duration: 1 },
      comment: '待機するよ。',
    }, DEFAULT_OPTIONS)).resolves.toMatchObject({
      status: 'busy',
      message: 'Agent cannot wait in the current state.',
      hint: '会話への応答待ちです。受諾または拒否を選んでください。',
    });
  });

  it('converts a code-less command 409 into an informational response (notification superseded 等)', async () => {
    // サーバー仕様で notification_id は最新以外無効になる。command への 409 は
    // どの形でも「世界側の状態と噛み合わなかった」正常系なので例外にしない
    const conflictFetch = vi.fn<typeof globalThis.fetch>(async () => new Response('Conflict', {
      status: 409,
      headers: { 'content-type': 'text/plain' },
    }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/api',
      apiKey: 'secret',
      notificationId: 'notif-123',
      fetch: conflictFetch,
    });

    const result = await tools.karakuri_world_command!.execute!({
      command: 'wait',
      params: { duration: 1 },
      comment: '待機するよ。',
    }, DEFAULT_OPTIONS) as { status?: string; instruction?: string };
    expect(result.status).toBe('busy');
    expect(result.instruction).toContain('次の通知で選び直してください');
  });
});
