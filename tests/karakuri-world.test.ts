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
});
