import type { ToolExecutionOptions } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import {
  createKarakuriWorldTools,
  karakuriWorldInputSchema,
  KarakuriWorldApiError,
  KarakuriWorldResponseError,
} from '../src/agent/tools/karakuri-world.js';

const DEFAULT_OPTIONS: ToolExecutionOptions = {
  toolCallId: 'tool-1',
  messages: [],
};

const EXPECTED_TOOL_NAMES = [
  'karakuri_world_get_map',
  'karakuri_world_get_world_agents',
  'karakuri_world_move',
  'karakuri_world_action',
  'karakuri_world_use_item',
  'karakuri_world_transfer',
  'karakuri_world_accept_transfer',
  'karakuri_world_reject_transfer',
  'karakuri_world_wait',
  'karakuri_world_conversation_start',
  'karakuri_world_conversation_accept',
  'karakuri_world_conversation_reject',
  'karakuri_world_conversation_join',
  'karakuri_world_conversation_stay',
  'karakuri_world_conversation_leave',
  'karakuri_world_conversation_speak',
  'karakuri_world_end_conversation',
  'karakuri_world_server_event_select',
] as const;

describe('karakuri-world tools', () => {
  it('exports dedicated operation-specific tools and keeps the combined schema strict', () => {
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch: vi.fn(),
    });

    expect(Object.keys(tools)).toEqual(EXPECTED_TOOL_NAMES);
    expect(karakuriWorldInputSchema.parse({ operation: 'move', target_node_id: '1-2' })).toEqual({
      operation: 'move',
      target_node_id: '1-2',
    });
    expect(karakuriWorldInputSchema.parse({ operation: 'wait', duration: '3' })).toEqual({
      operation: 'wait',
      duration: 3,
    });
    expect(() => karakuriWorldInputSchema.parse({ operation: 'get_map', extra: true })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({ operation: 'wait', duration: '1000ms' })).toThrow();
    expect(karakuriWorldInputSchema.parse({ operation: 'use_item', item_id: 'potion' })).toEqual({
      operation: 'use_item',
      item_id: 'potion',
    });
    expect(() => karakuriWorldInputSchema.parse({ operation: 'use_item' })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({ operation: 'use_item', item_id: '' })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({ operation: 'use_item', item_id: 'x', extra: 1 })).toThrow();

    // waitDurationSchema 境界値
    expect(karakuriWorldInputSchema.parse({ operation: 'wait', duration: 1 })).toEqual({ operation: 'wait', duration: 1 });
    expect(karakuriWorldInputSchema.parse({ operation: 'wait', duration: 6 })).toEqual({ operation: 'wait', duration: 6 });
    expect(() => karakuriWorldInputSchema.parse({ operation: 'wait', duration: 0 })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({ operation: 'wait', duration: 7 })).toThrow();
  });

  it('validates transfer schemas strictly (item XOR money exclusivity)', () => {
    // 正常: item only / money only / 数値文字列の preprocess
    expect(karakuriWorldInputSchema.parse({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      item: { item_id: 'apple', quantity: 2 },
    })).toEqual({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      item: { item_id: 'apple', quantity: 2 },
    });
    expect(karakuriWorldInputSchema.parse({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      money: 100,
    })).toEqual({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      money: 100,
    });
    expect(karakuriWorldInputSchema.parse({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      item: { item_id: 'apple', quantity: '3' },
    })).toEqual({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      item: { item_id: 'apple', quantity: 3 },
    });
    expect(karakuriWorldInputSchema.parse({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      money: '100',
    })).toEqual({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      money: 100,
    });

    // 排他: 両方指定 / 両方なしは拒否
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      item: { item_id: 'apple', quantity: 1 },
      money: 100,
    })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
    })).toThrow();

    // 余剰フィールド / 数量・金額の境界
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      item: { item_id: 'apple', quantity: 2 },
      extra: true,
    })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      item: { item_id: 'apple', quantity: 0 },
    })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      item: { item_id: 'apple', quantity: -1 },
    })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      money: 0,
    })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      money: -1,
    })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'transfer',
      target_agent_id: '',
      money: 1,
    })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      item: { item_id: 'apple', quantity: 10_001 },
    })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      money: 10_000_001,
    })).toThrow();
    // items (旧形) は厳密に拒否される
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      items: [{ item_id: 'apple', quantity: 1 }],
    })).toThrow();
  });

  it('validates accept_transfer / reject_transfer schemas strictly (no arguments)', () => {
    // accept_transfer / reject_transfer は引数なし。サーバー側が pending_transfer_id から自動解決する
    expect(karakuriWorldInputSchema.parse({
      operation: 'accept_transfer',
    })).toEqual({
      operation: 'accept_transfer',
    });
    expect(karakuriWorldInputSchema.parse({
      operation: 'reject_transfer',
    })).toEqual({
      operation: 'reject_transfer',
    });

    // 旧 API 引数 transfer_id は strict object で拒否される (リグレッションガード)
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'accept_transfer',
      transfer_id: 't-1',
    })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'accept_transfer',
      extra: true,
    })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'reject_transfer',
      transfer_id: 't-1',
    })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'reject_transfer',
      extra: true,
    })).toThrow();
  });

  it('posts move requests with bearer auth and returns the API result directly', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          from_node_id: '1-1',
          to_node_id: '1-2',
          arrives_at: 42,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/',
      apiKey: 'secret',
      fetch,
    });

    const result = await tools.karakuri_world_move!.execute!(
      { target_node_id: '1-2', comment: '門へ向かいます。' },
      DEFAULT_OPTIONS,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/api/agents/move',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ target_node_id: '1-2' }),
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(result).toEqual({
      from_node_id: '1-1',
      to_node_id: '1-2',
      arrives_at: 42,
    });
  });

  it('posts transfer/accept/reject requests with bearer auth', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/transfer/accept')) {
        return new Response(JSON.stringify({
          ok: true,
          message: 'accepted',
          transfer_status: 'completed',
          transfer_id: 't-1',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/transfer/reject')) {
        return new Response(JSON.stringify({
          ok: true,
          message: 'rejected',
          transfer_status: 'rejected',
          transfer_id: 't-2',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        ok: true,
        message: 'pending',
        transfer_status: 'pending',
        transfer_id: 't-0',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com/',
      apiKey: 'secret',
      fetch,
    });

    await expect(tools.karakuri_world_transfer!.execute!(
      {
        target_agent_id: 'agent-bob',
        item: { item_id: 'apple', quantity: 2 },
        comment: '渡します。',
      },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      ok: true,
      message: 'pending',
      transfer_status: 'pending',
      transfer_id: 't-0',
    });
    await expect(tools.karakuri_world_accept_transfer!.execute!(
      { comment: '受け取ります。' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      ok: true,
      message: 'accepted',
      transfer_status: 'completed',
      transfer_id: 't-1',
    });
    await expect(tools.karakuri_world_reject_transfer!.execute!(
      { comment: '今は受け取れません。' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      ok: true,
      message: 'rejected',
      transfer_status: 'rejected',
      transfer_id: 't-2',
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://example.com/api/agents/transfer',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          target_agent_id: 'agent-bob',
          item: { item_id: 'apple', quantity: 2 },
        }),
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://example.com/api/agents/transfer/accept',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({}),
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      'https://example.com/api/agents/transfer/reject',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({}),
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
        }),
      }),
    );
    for (const [, requestInit] of fetch.mock.calls) {
      expect(requestInit?.body).not.toContain('comment');
    }
  });

  it('parses transferActionResponseSchema for all transfer_status values', async () => {
    const payloads = [
      { ok: true, message: 'pending', transfer_status: 'pending', transfer_id: 't-pending', warning: 'x' },
      { ok: true, message: 'completed', transfer_status: 'completed', transfer_id: 't-completed' },
      { ok: true, message: 'rejected', transfer_status: 'rejected', transfer_id: 't-rejected' },
      { ok: true, message: 'persist failed', transfer_status: 'failed', failure_reason: 'persist_failed' },
      { ok: true, message: 'role conflict', transfer_status: 'failed', failure_reason: 'role_conflict' },
      { ok: true, message: 'inventory full', transfer_status: 'failed', failure_reason: 'overflow_inventory_full' },
      { ok: true, message: 'money overflow', transfer_status: 'failed', failure_reason: 'overflow_money' },
      { ok: true, message: 'validation failed', transfer_status: 'failed', failure_reason: 'validation_failed' },
    ] as const;
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const payload of payloads) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    }
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    await expect(tools.karakuri_world_transfer!.execute!(
      { target_agent_id: 'agent-bob', money: 1, comment: '1' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      ok: true,
      message: 'pending',
      transfer_status: 'pending',
      transfer_id: 't-pending',
    });
    await expect(tools.karakuri_world_transfer!.execute!(
      { target_agent_id: 'agent-bob', money: 2, comment: '2' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      ok: true,
      message: 'completed',
      transfer_status: 'completed',
      transfer_id: 't-completed',
    });
    await expect(tools.karakuri_world_transfer!.execute!(
      { target_agent_id: 'agent-bob', money: 3, comment: '3' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      ok: true,
      message: 'rejected',
      transfer_status: 'rejected',
      transfer_id: 't-rejected',
    });
    await expect(tools.karakuri_world_transfer!.execute!(
      { target_agent_id: 'agent-bob', money: 4, comment: '4' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      ok: true,
      message: 'persist failed',
      transfer_status: 'failed',
      failure_reason: 'persist_failed',
    });
    await expect(tools.karakuri_world_transfer!.execute!(
      { target_agent_id: 'agent-bob', money: 5, comment: '5' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      ok: true,
      message: 'role conflict',
      transfer_status: 'failed',
      failure_reason: 'role_conflict',
    });
    await expect(tools.karakuri_world_transfer!.execute!(
      { target_agent_id: 'agent-bob', money: 6, comment: '6' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      ok: true,
      message: 'inventory full',
      transfer_status: 'failed',
      failure_reason: 'overflow_inventory_full',
    });
    await expect(tools.karakuri_world_transfer!.execute!(
      { target_agent_id: 'agent-bob', money: 7, comment: '7' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      ok: true,
      message: 'money overflow',
      transfer_status: 'failed',
      failure_reason: 'overflow_money',
    });
    await expect(tools.karakuri_world_transfer!.execute!(
      { target_agent_id: 'agent-bob', money: 8, comment: '8' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      ok: true,
      message: 'validation failed',
      transfer_status: 'failed',
      failure_reason: 'validation_failed',
    });
  });

  it('rejects transfer response with transfer_status="failed" but missing failure_reason', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({
        ok: true,
        message: 'failed',
        transfer_status: 'failed',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    await expect(tools.karakuri_world_transfer!.execute!(
      { target_agent_id: 'agent-bob', money: 1, comment: 'failed のみ。' },
      DEFAULT_OPTIONS,
    )).rejects.toThrow(KarakuriWorldResponseError);
  });

  it('rejects conversation_speak response with transfer_status="failed" but missing failure_reason', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({
        turn: 12,
        transfer_status: 'failed',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    await expect(tools.karakuri_world_conversation_speak!.execute!(
      {
        message: 'これあげる。',
        next_speaker_agent_id: 'agent-2',
        transfer: { money: 10 },
        comment: 'failed のみ受信。',
      },
      DEFAULT_OPTIONS,
    )).rejects.toThrow(KarakuriWorldResponseError);
  });

  it('requires comment in direct karakuri-world tool schemas', () => {
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch: vi.fn(),
    });
    const moveInputSchema = tools.karakuri_world_move?.inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const mapInputSchema = tools.karakuri_world_get_map?.inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };

    expect(moveInputSchema.safeParse({ target_node_id: '1-2' }).success).toBe(false);
    expect(moveInputSchema.safeParse({
      target_node_id: '1-2',
      comment: '移動します。',
    }).success).toBe(true);
    expect(moveInputSchema.safeParse({
      target_node_id: '1-2',
      comment: '',
    }).success).toBe(false);
    expect(moveInputSchema.safeParse({
      target_node_id: '1-2',
      comment: '   ',
    }).success).toBe(false);
    expect(mapInputSchema.safeParse({}).success).toBe(false);
    expect(mapInputSchema.safeParse({ comment: 'まず地図を確認します。' }).success).toBe(true);
    expect(mapInputSchema.safeParse({ comment: '' }).success).toBe(false);
  });

  it('uses GET endpoints without sending a request body for read operations', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          message: 'Map request accepted. Details will arrive by notification.',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    const result = await tools.karakuri_world_get_map!.execute!({}, DEFAULT_OPTIONS);

    expect(fetch).toHaveBeenCalledTimes(1);
    const firstCall = fetch.mock.calls[0];
    if (!firstCall) {
      throw new Error('Expected fetch to be called.');
    }

    const [requestUrl, requestInit] = firstCall;

    expect(requestUrl).toBe('https://example.com/api/agents/map');
    expect(requestInit).toMatchObject({
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer secret',
      },
    });
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(requestInit).not.toHaveProperty('body');
    expect(result).toEqual({
      ok: true,
      message: 'Map request accepted. Details will arrive by notification.',
    });
  });

  it('uses GET for get_world_agents and returns a notification ack response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          message: 'World agents request accepted. Details will arrive by notification.',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    const result = await tools.karakuri_world_get_world_agents!.execute!({}, DEFAULT_OPTIONS);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetch.mock.calls[0]!;
    expect(requestUrl).toBe('https://example.com/api/agents/world-agents');
    expect(requestInit).toMatchObject({ method: 'GET' });
    expect(requestInit).not.toHaveProperty('body');
    expect(result).toEqual({
      ok: true,
      message: 'World agents request accepted. Details will arrive by notification.',
    });
  });

  it('retries once on transient network failures for GET requests', async () => {
    const transientError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          ok: true,
          message: 'Map request accepted.',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    const result = await tools.karakuri_world_get_map!.execute!({}, DEFAULT_OPTIONS);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: true, message: 'Map request accepted.' });
  });

  it('does not retry transient network failures for POST requests', async () => {
    const transientError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(transientError);
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    await expect(
      tools.karakuri_world_wait!.execute!({ duration: 3 }, DEFAULT_OPTIONS),
    ).rejects.toThrow('Failed to reach the karakuri-world API');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries timeout failures with a fresh signal for each attempt on GET requests', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            ok: true,
            message: 'Map request accepted.',
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      const tools = createKarakuriWorldTools({
        apiBaseUrl: 'https://example.com',
        apiKey: 'secret',
        fetch,
      });

      const result = await tools.karakuri_world_get_map!.execute!({}, DEFAULT_OPTIONS);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(timeoutSpy).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(fetch.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(fetch.mock.calls[0]?.[1]?.signal).not.toBe(fetch.mock.calls[1]?.[1]?.signal);
      expect(result).toEqual({ ok: true, message: 'Map request accepted.' });
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('normalizes numeric-string wait durations before sending requests', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({ completes_at: 123 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    const parsedInput = karakuriWorldInputSchema.parse({
      operation: 'wait',
      duration: '3',
    });
    if (parsedInput.operation !== 'wait') {
      throw new Error('Expected a wait input.');
    }
    const { operation: _operation, ...waitInput } = parsedInput;
    const result = await tools.karakuri_world_wait!.execute!(waitInput, DEFAULT_OPTIONS);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/api/agents/wait',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ duration: 3 }),
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(result).toEqual({ completes_at: 123 });
  });


  it('accepts action with optional duration_minutes and coerces string values', () => {
    // Without duration_minutes (fixed-duration action)
    expect(karakuriWorldInputSchema.parse({ operation: 'action', action_id: 'rest' })).toEqual({
      operation: 'action',
      action_id: 'rest',
    });

    // With duration_minutes (variable-duration action)
    expect(karakuriWorldInputSchema.parse({ operation: 'action', action_id: 'sleep', duration_minutes: 120 })).toEqual({
      operation: 'action',
      action_id: 'sleep',
      duration_minutes: 120,
    });

    // String coercion (LLM may send numbers as strings)
    expect(karakuriWorldInputSchema.parse({ operation: 'action', action_id: 'sleep', duration_minutes: '120' })).toEqual({
      operation: 'action',
      action_id: 'sleep',
      duration_minutes: 120,
    });

    // Boundary: min=1
    expect(karakuriWorldInputSchema.parse({ operation: 'action', action_id: 'sleep', duration_minutes: 1 })).toEqual({
      operation: 'action',
      action_id: 'sleep',
      duration_minutes: 1,
    });

    // Boundary: max=10080
    expect(karakuriWorldInputSchema.parse({ operation: 'action', action_id: 'sleep', duration_minutes: 10080 })).toEqual({
      operation: 'action',
      action_id: 'sleep',
      duration_minutes: 10080,
    });

    // Invalid: 0
    expect(() => karakuriWorldInputSchema.parse({ operation: 'action', action_id: 'sleep', duration_minutes: 0 })).toThrow();

    // Invalid: 10081
    expect(() => karakuriWorldInputSchema.parse({ operation: 'action', action_id: 'sleep', duration_minutes: 10081 })).toThrow();

    // Invalid: non-integer
    expect(() => karakuriWorldInputSchema.parse({ operation: 'action', action_id: 'sleep', duration_minutes: 1.5 })).toThrow();
  });

  it('posts action requests with duration_minutes for variable-duration actions', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({ ok: true, message: 'Action accepted.' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    const result = await tools.karakuri_world_action!.execute!(
      { action_id: 'sleep', duration_minutes: 120, comment: '2時間ほど休みます。' },
      DEFAULT_OPTIONS,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/api/agents/action',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action_id: 'sleep', duration_minutes: 120 }),
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(result).toEqual({ ok: true, message: 'Action accepted.' });
  });

  it('rejects legacy karakuri-world schemas that the server no longer accepts', () => {
    expect(() => karakuriWorldInputSchema.parse({ operation: 'wait', duration_ms: 1000 })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({ operation: 'conversation_accept', conversation_id: 'conv-1' })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({ operation: 'conversation_reject', conversation_id: 'conv-1' })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({ operation: 'conversation_speak', conversation_id: 'conv-1', message: 'hello' })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'end_conversation',
      message: 'またね',
      next_speaker_agent_id: 'agent-2',
      transfer: { item: { item_id: 'x', quantity: 1 } },
    })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({ operation: 'get_perception' })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({ operation: 'get_available_actions' })).toThrow();
  });

  it('validates group-conversation schemas strictly', () => {
    expect(karakuriWorldInputSchema.parse({
      operation: 'conversation_join',
      conversation_id: 'conv-1',
    })).toEqual({
      operation: 'conversation_join',
      conversation_id: 'conv-1',
    });
    expect(() => karakuriWorldInputSchema.parse({ operation: 'conversation_join' })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'conversation_join',
      conversation_id: '',
    })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'conversation_join',
      conversation_id: 'conv-1',
      message: '混ぜてください。',
    })).toThrow();

    expect(karakuriWorldInputSchema.parse({ operation: 'conversation_stay' })).toEqual({
      operation: 'conversation_stay',
    });
    expect(() => karakuriWorldInputSchema.parse({ operation: 'conversation_stay', extra: true })).toThrow();

    expect(karakuriWorldInputSchema.parse({ operation: 'conversation_leave' })).toEqual({
      operation: 'conversation_leave',
    });
    expect(karakuriWorldInputSchema.parse({
      operation: 'conversation_leave',
      message: 'ここで失礼します。',
    })).toEqual({
      operation: 'conversation_leave',
      message: 'ここで失礼します。',
    });
    expect(() => karakuriWorldInputSchema.parse({ operation: 'conversation_leave', message: '' })).toThrow();

    expect(karakuriWorldInputSchema.parse({
      operation: 'conversation_speak',
      message: 'こんにちは。',
      next_speaker_agent_id: 'agent-2',
    })).toEqual({
      operation: 'conversation_speak',
      message: 'こんにちは。',
      next_speaker_agent_id: 'agent-2',
    });
    expect(() => karakuriWorldInputSchema.parse({ operation: 'conversation_speak', message: 'こんにちは。' })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'conversation_speak',
      message: 'こんにちは。',
      next_speaker_agent_id: '',
    })).toThrow();

    expect(karakuriWorldInputSchema.parse({
      operation: 'end_conversation',
      message: 'また後で。',
      next_speaker_agent_id: 'agent-2',
    })).toEqual({
      operation: 'end_conversation',
      message: 'また後で。',
      next_speaker_agent_id: 'agent-2',
    });
    expect(() => karakuriWorldInputSchema.parse({ operation: 'end_conversation', message: 'また後で。' })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'end_conversation',
      message: 'また後で。',
      next_speaker_agent_id: '',
    })).toThrow();
  });

  it('validates conversation_speak with transfer and transfer_response', async () => {
    expect(karakuriWorldInputSchema.parse({
      operation: 'conversation_speak',
      message: 'どうぞ。',
      next_speaker_agent_id: 'agent-2',
      transfer: {
        item: { item_id: 'apple', quantity: 1 },
      },
    })).toEqual({
      operation: 'conversation_speak',
      message: 'どうぞ。',
      next_speaker_agent_id: 'agent-2',
      transfer: {
        item: { item_id: 'apple', quantity: 1 },
      },
    });
    expect(karakuriWorldInputSchema.parse({
      operation: 'conversation_speak',
      message: '受け取ります。',
      next_speaker_agent_id: 'agent-2',
      transfer_response: 'accept',
    })).toEqual({
      operation: 'conversation_speak',
      message: '受け取ります。',
      next_speaker_agent_id: 'agent-2',
      transfer_response: 'accept',
    });
    expect(karakuriWorldInputSchema.parse({
      operation: 'conversation_speak',
      message: 'こんにちは。',
      next_speaker_agent_id: 'agent-2',
    })).toEqual({
      operation: 'conversation_speak',
      message: 'こんにちは。',
      next_speaker_agent_id: 'agent-2',
    });
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'conversation_speak',
      message: 'だめです。',
      next_speaker_agent_id: 'agent-2',
      transfer: {
        item: { item_id: 'apple', quantity: 1 },
      },
      transfer_response: 'reject',
    })).toThrow();

    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ turn: 8 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ turn: 9 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    await expect(tools.karakuri_world_conversation_speak!.execute!(
      {
        message: 'どうぞ。',
        next_speaker_agent_id: 'agent-2',
        transfer: { item: { item_id: 'apple', quantity: 1 } },
        comment: '渡します。',
      },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({ turn: 8 });
    await expect(tools.karakuri_world_conversation_speak!.execute!(
      {
        message: '受け取ります。',
        next_speaker_agent_id: 'agent-2',
        transfer_response: 'accept',
        comment: '受諾します。',
      },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({ turn: 9 });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://example.com/api/agents/conversation/speak',
      expect.objectContaining({
        body: JSON.stringify({
          message: 'どうぞ。',
          next_speaker_agent_id: 'agent-2',
          transfer: { item: { item_id: 'apple', quantity: 1 } },
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://example.com/api/agents/conversation/speak',
      expect.objectContaining({
        body: JSON.stringify({
          message: '受け取ります。',
          next_speaker_agent_id: 'agent-2',
          transfer_response: 'accept',
        }),
      }),
    );
  });

  it('validates conversation_speak response with optional transfer fields', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ turn: 7 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        turn: 7,
        transfer_status: 'pending',
        transfer_id: 't-1',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        turn: 7,
        transfer_status: 'failed',
        failure_reason: 'overflow_inventory_full',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    await expect(tools.karakuri_world_conversation_speak!.execute!(
      { message: 'a', next_speaker_agent_id: 'agent-2', comment: 'a' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({ turn: 7 });
    await expect(tools.karakuri_world_conversation_speak!.execute!(
      { message: 'b', next_speaker_agent_id: 'agent-2', comment: 'b' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      turn: 7,
      transfer_status: 'pending',
      transfer_id: 't-1',
    });
    await expect(tools.karakuri_world_conversation_speak!.execute!(
      { message: 'c', next_speaker_agent_id: 'agent-2', comment: 'c' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      turn: 7,
      transfer_status: 'failed',
      failure_reason: 'overflow_inventory_full',
    });
  });

  it('validates end_conversation with transfer_response only', async () => {
    expect(karakuriWorldInputSchema.parse({
      operation: 'end_conversation',
      message: 'またね。',
      next_speaker_agent_id: 'agent-2',
      transfer_response: 'reject',
    })).toEqual({
      operation: 'end_conversation',
      message: 'またね。',
      next_speaker_agent_id: 'agent-2',
      transfer_response: 'reject',
    });
    expect(() => karakuriWorldInputSchema.parse({
      operation: 'end_conversation',
      message: 'またね。',
      next_speaker_agent_id: 'agent-2',
      transfer: { item: { item_id: 'apple', quantity: 1 } },
    })).toThrow();

    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({ turn: 10 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    await expect(tools.karakuri_world_end_conversation!.execute!(
      {
        message: 'またね。',
        next_speaker_agent_id: 'agent-2',
        transfer_response: 'reject',
        comment: '断って会話を終えます。',
      },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({ turn: 10 });

    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/api/agents/conversation/end',
      expect.objectContaining({
        body: JSON.stringify({
          message: 'またね。',
          next_speaker_agent_id: 'agent-2',
          transfer_response: 'reject',
        }),
      }),
    );
  });

  it('rejects invalid transfer_response enum values on conversation_speak / end_conversation', () => {
    const invalidValues: unknown[] = ['maybe', '', 'ACCEPT', 'Accept', 'reject ', 1, true, null];

    for (const value of invalidValues) {
      expect(karakuriWorldInputSchema.safeParse({
        operation: 'conversation_speak',
        message: 'うん。',
        next_speaker_agent_id: 'agent-2',
        transfer_response: value,
      }).success).toBe(false);
      expect(karakuriWorldInputSchema.safeParse({
        operation: 'end_conversation',
        message: 'またね。',
        next_speaker_agent_id: 'agent-2',
        transfer_response: value,
      }).success).toBe(false);
    }

    // 既知 enum 値は通る
    expect(karakuriWorldInputSchema.safeParse({
      operation: 'conversation_speak',
      message: 'うん。',
      next_speaker_agent_id: 'agent-2',
      transfer_response: 'accept',
    }).success).toBe(true);
    expect(karakuriWorldInputSchema.safeParse({
      operation: 'conversation_speak',
      message: 'やめとく。',
      next_speaker_agent_id: 'agent-2',
      transfer_response: 'reject',
    }).success).toBe(true);
  });

  it('rejects empty item_id in transfer item attachment', () => {
    // standalone transfer
    expect(karakuriWorldInputSchema.safeParse({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      item: { item_id: '', quantity: 1 },
    }).success).toBe(false);

    // conversation_speak.transfer
    expect(karakuriWorldInputSchema.safeParse({
      operation: 'conversation_speak',
      message: 'これあげる。',
      next_speaker_agent_id: 'agent-2',
      transfer: { item: { item_id: '', quantity: 1 } },
    }).success).toBe(false);

    // 念のため正常系も確認
    expect(karakuriWorldInputSchema.safeParse({
      operation: 'transfer',
      target_agent_id: 'agent-bob',
      item: { item_id: 'apple', quantity: 1 },
    }).success).toBe(true);
  });

  it('rejects transfer + transfer_response on the conversation_speak tool inputSchema', () => {
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch: vi.fn(),
    });
    const speakInputSchema = tools.karakuri_world_conversation_speak?.inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };

    expect(speakInputSchema.safeParse({
      message: 'だめです。',
      next_speaker_agent_id: 'agent-2',
      transfer: { item: { item_id: 'apple', quantity: 1 } },
      transfer_response: 'reject',
      comment: '矛盾入力。',
    }).success).toBe(false);
  });

  it('enforces item XOR money exclusivity on the transfer tool inputSchema', () => {
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch: vi.fn(),
    });
    const transferInputSchema = tools.karakuri_world_transfer?.inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };

    // 両方なし
    expect(transferInputSchema.safeParse({
      target_agent_id: 'agent-bob',
      comment: '空譲渡。',
    }).success).toBe(false);
    // 両方指定
    expect(transferInputSchema.safeParse({
      target_agent_id: 'agent-bob',
      item: { item_id: 'apple', quantity: 1 },
      money: 50,
      comment: '両方指定。',
    }).success).toBe(false);
    // 旧形 (items 配列) は拒否
    expect(transferInputSchema.safeParse({
      target_agent_id: 'agent-bob',
      items: [{ item_id: 'apple', quantity: 1 }],
      comment: '旧形。',
    }).success).toBe(false);
    // money: 0 は positiveInt 違反
    expect(transferInputSchema.safeParse({
      target_agent_id: 'agent-bob',
      money: 0,
      comment: 'ゼロ譲渡。',
    }).success).toBe(false);
    // 正常 (item のみ)
    expect(transferInputSchema.safeParse({
      target_agent_id: 'agent-bob',
      item: { item_id: 'apple', quantity: 1 },
      comment: 'りんご 1 個。',
    }).success).toBe(true);
    // 正常 (money のみ)
    expect(transferInputSchema.safeParse({
      target_agent_id: 'agent-bob',
      money: 1,
      comment: 'お金だけ。',
    }).success).toBe(true);
  });

  it('rejects transfer field on the end_conversation tool inputSchema', () => {
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch: vi.fn(),
    });
    const endInputSchema = tools.karakuri_world_end_conversation?.inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };

    expect(endInputSchema.safeParse({
      message: 'またね。',
      next_speaker_agent_id: 'agent-2',
      transfer: { item: { item_id: 'apple', quantity: 1 } },
      comment: 'end で transfer は禁止。',
    }).success).toBe(false);
    expect(endInputSchema.safeParse({
      message: 'またね。',
      next_speaker_agent_id: 'agent-2',
      transfer_response: 'accept',
      comment: 'end で transfer_response はOK。',
    }).success).toBe(true);
  });

  it('sends money-only transfer body without item field', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({
        ok: true,
        message: 'pending',
        transfer_status: 'pending',
        transfer_id: 't-money-only',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    await tools.karakuri_world_transfer!.execute!(
      {
        target_agent_id: 'agent-bob',
        money: 50,
        comment: 'お金だけ渡す。',
      },
      DEFAULT_OPTIONS,
    );

    const sentBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(sentBody).toEqual({
      target_agent_id: 'agent-bob',
      money: 50,
    });
    expect(sentBody).not.toHaveProperty('item');
    expect(sentBody).not.toHaveProperty('items');
  });

  it('sends money-only transfer attachment in conversation_speak body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({ turn: 11 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    await tools.karakuri_world_conversation_speak!.execute!(
      {
        message: 'お金だけ渡すね。',
        next_speaker_agent_id: 'agent-2',
        transfer: { money: 30 },
        comment: '会話中にお金だけ渡す。',
      },
      DEFAULT_OPTIONS,
    );

    const sentBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(sentBody).toEqual({
      message: 'お金だけ渡すね。',
      next_speaker_agent_id: 'agent-2',
      transfer: { money: 30 },
    });
    expect(sentBody).not.toHaveProperty('comment');
  });

  it('parses unknown transfer_status / failure_reason values for forward compatibility', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({
        ok: true,
        message: 'expired',
        transfer_status: 'expired',
        transfer_id: 't-expired',
        failure_reason: 'overflow_quantity_limit',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    await expect(tools.karakuri_world_accept_transfer!.execute!(
      { comment: '受諾試みる。' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      ok: true,
      message: 'expired',
      transfer_status: 'expired',
      transfer_id: 't-expired',
      failure_reason: 'overflow_quantity_limit',
    });
  });

  it('parses unknown fields on conversation_speak response for forward compatibility', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({
        turn: 12,
        transfer_status: 'completed',
        transfer_id: 't-future',
        new_future_field: 'whatever',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    await expect(tools.karakuri_world_conversation_speak!.execute!(
      {
        message: 'はい。',
        next_speaker_agent_id: 'agent-2',
        comment: '応答。',
      },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      turn: 12,
      transfer_status: 'completed',
      transfer_id: 't-future',
    });
  });

  it('returns a not_logged_in response for transfer / accept_transfer / reject_transfer', async () => {
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch: vi.fn<typeof globalThis.fetch>(async () =>
        new Response(JSON.stringify({
          error: 'not_logged_in',
          message: 'You are not logged in.',
        }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })),
    });

    await expect(tools.karakuri_world_transfer!.execute!(
      {
        target_agent_id: 'agent-bob',
        money: 1,
        comment: 'ログイン前。',
      },
      DEFAULT_OPTIONS,
    )).resolves.toMatchObject({ status: 'not_logged_in' });
    await expect(tools.karakuri_world_accept_transfer!.execute!(
      { comment: 'ログイン前。' },
      DEFAULT_OPTIONS,
    )).resolves.toMatchObject({ status: 'not_logged_in' });
    await expect(tools.karakuri_world_reject_transfer!.execute!(
      { comment: 'ログイン前。' },
      DEFAULT_OPTIONS,
    )).resolves.toMatchObject({ status: 'not_logged_in' });
  });

  it('posts conversation join, stay, and leave requests while stripping comment', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    await expect(tools.karakuri_world_conversation_join!.execute!(
      {
        conversation_id: 'conv-1',
        comment: '輪に入ります。',
      },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({ status: 'ok' });
    await expect(tools.karakuri_world_conversation_stay!.execute!(
      { comment: 'まだ会話に残ります。' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({ status: 'ok' });
    await expect(tools.karakuri_world_conversation_leave!.execute!(
      {
        message: 'そろそろ失礼します。',
        comment: 'inactive check に離脱で応答します。',
      },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({ status: 'ok' });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://example.com/api/agents/conversation/join',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ conversation_id: 'conv-1' }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://example.com/api/agents/conversation/stay',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      'https://example.com/api/agents/conversation/leave',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: 'そろそろ失礼します。' }),
      }),
    );
    for (const [, requestInit] of fetch.mock.calls) {
      expect(requestInit?.body).not.toContain('comment');
    }
  });

  it('accepts the group-leave status response for end_conversation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    await expect(tools.karakuri_world_end_conversation!.execute!(
      { message: 'お先に失礼します。', next_speaker_agent_id: 'agent-3', comment: 'グループから退出します。' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({ status: 'ok' });
  });

  it('posts conversation_leave with an empty body when message is omitted', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    await expect(tools.karakuri_world_conversation_leave!.execute!(
      { comment: 'お別れの挨拶なしで抜けます。' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({ status: 'ok' });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/api/agents/conversation/leave',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
  });

  it('posts conversation accept, reject, speak, and end requests with updated payloads', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/accept')) {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/reject')) {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ turn: 7 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    await expect(tools.karakuri_world_conversation_accept!.execute!({ message: '了解です。' }, DEFAULT_OPTIONS))
      .resolves.toEqual({ status: 'ok' });
    await expect(tools.karakuri_world_conversation_reject!.execute!({}, DEFAULT_OPTIONS))
      .resolves.toEqual({ status: 'ok' });
    await expect(tools.karakuri_world_conversation_speak!.execute!(
      { message: 'こんにちは。', next_speaker_agent_id: 'agent-2' },
      DEFAULT_OPTIONS,
    ))
      .resolves.toEqual({ turn: 7 });
    await expect(tools.karakuri_world_end_conversation!.execute!(
      { message: 'また後で。', next_speaker_agent_id: 'agent-2' },
      DEFAULT_OPTIONS,
    ))
      .resolves.toEqual({ turn: 7 });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://example.com/api/agents/conversation/accept',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: '了解です。' }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://example.com/api/agents/conversation/reject',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      'https://example.com/api/agents/conversation/speak',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: 'こんにちは。', next_speaker_agent_id: 'agent-2' }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      'https://example.com/api/agents/conversation/end',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: 'また後で。', next_speaker_agent_id: 'agent-2' }),
      }),
    );
  });

  it('posts action requests and returns a notification-accepted response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          message: '正常に受け付けました。結果が通知されるまで待機してください。',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    const result = await tools.karakuri_world_action!.execute!(
      { action_id: 'rest', comment: '休憩します。' },
      DEFAULT_OPTIONS,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/api/agents/action',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action_id: 'rest' }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      message: '正常に受け付けました。結果が通知されるまで待機してください。',
    });
  });

  it('posts use-item requests and returns a notification-accepted response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          message: '正常に受け付けました。結果が通知されるまで待機してください。',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    const result = await tools.karakuri_world_use_item!.execute!(
      { item_id: 'omikuji', comment: 'おみくじを引きます。' },
      DEFAULT_OPTIONS,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/api/agents/use-item',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ item_id: 'omikuji' }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      message: '正常に受け付けました。結果が通知されるまで待機してください。',
    });
  });

  it('rejects the old action response format after schema migration', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          action_id: 'rest',
          action_name: 'Rest',
          completes_at: 1234567890,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    await expect(
      tools.karakuri_world_action!.execute!(
        { action_id: 'rest', comment: '休憩します。' },
        DEFAULT_OPTIONS,
      ),
    ).rejects.toThrow(KarakuriWorldResponseError);
  });

  it('returns a busy response instead of throwing for state_conflict errors', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          error: 'state_conflict',
          message: 'Agent is not idle',
        }),
        {
          status: 409,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    const result = await tools.karakuri_world_action!.execute!({ action_id: 'rest' }, DEFAULT_OPTIONS);

    expect(result).toEqual({
      status: 'busy',
      message: 'Agent is not idle',
      instruction: expect.stringContaining('再送しないでください'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns a busy response instead of throwing for not_your_turn errors', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          error: 'not_your_turn',
          message: 'It is not your turn to speak.',
        }),
        {
          status: 409,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    const result = await tools.karakuri_world_conversation_speak!.execute!(
      { message: 'hello', next_speaker_agent_id: 'agent-2' },
      DEFAULT_OPTIONS,
    );

    expect(result).toEqual({
      status: 'busy',
      message: 'It is not your turn to speak.',
      instruction: expect.stringContaining('再送しないでください'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats transfer 409 errors (role_conflict / already_settled / refund_failed) as throwing errors, not busy', async () => {
    for (const code of ['transfer_role_conflict', 'transfer_already_settled', 'transfer_refund_failed'] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        new Response(JSON.stringify({
          error: code,
          message: `Transfer failed: ${code}`,
        }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }));
      const tools = createKarakuriWorldTools({
        apiBaseUrl: 'https://example.com',
        apiKey: 'secret',
        fetch,
      });

      let thrownError: unknown;
      try {
        await tools.karakuri_world_transfer!.execute!(
          { target_agent_id: 'agent-bob', money: 1, comment: code },
          DEFAULT_OPTIONS,
        );
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(KarakuriWorldApiError);
      expect(thrownError).toMatchObject({
        status: 409,
        code,
      });
      expect(thrownError).not.toMatchObject({ status: 'busy' });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('returns a not_logged_in response instead of throwing for 403 not_logged_in errors', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          error: 'not_logged_in',
          message: 'Agent is not logged in.',
        }),
        {
          status: 403,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    const result = await tools.karakuri_world_move!.execute!(
      { target_node_id: '1-2' },
      DEFAULT_OPTIONS,
    );

    expect(result).toEqual({
      status: 'not_logged_in',
      message: 'Agent is not logged in.',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws for non-not_logged_in 403 errors like forbidden', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          error: 'forbidden',
          message: 'Access denied.',
        }),
        {
          status: 403,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    let thrownError: unknown;
    try {
      await tools.karakuri_world_move!.execute!(
        { target_node_id: '1-2' },
        DEFAULT_OPTIONS,
      );
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(KarakuriWorldApiError);
    expect(thrownError).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws for non-busy 409 errors like target_unavailable', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          error: 'target_unavailable',
          message: 'Target agent cannot receive a conversation right now.',
        }),
        {
          status: 409,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    let thrownError: unknown;
    try {
      await tools.karakuri_world_conversation_start!.execute!(
        { target_agent_id: 'a-1', message: 'hello' },
        DEFAULT_OPTIONS,
      );
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(KarakuriWorldApiError);
    expect(thrownError).toMatchObject({
      status: 409,
      code: 'target_unavailable',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws for 400-level application errors', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          error: 'out_of_bounds',
          message: 'Destination is outside the map.',
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    let thrownError: unknown;
    try {
      await tools.karakuri_world_move!.execute!({ target_node_id: '99-99' }, DEFAULT_OPTIONS);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(KarakuriWorldApiError);
    expect(thrownError).toMatchObject({
      status: 400,
      code: 'out_of_bounds',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws with the raw text message for non-JSON error responses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        '<html><body>502 Bad Gateway</body></html>',
        {
          status: 502,
          statusText: 'Bad Gateway',
          headers: { 'content-type': 'text/html' },
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    let thrownError: unknown;
    try {
      await tools.karakuri_world_get_map!.execute!({}, DEFAULT_OPTIONS);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(KarakuriWorldApiError);
    expect(thrownError).toMatchObject({
      status: 502,
      code: undefined,
      apiMessage: '<html><body>502 Bad Gateway</body></html>',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to statusText for empty non-JSON error responses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        '',
        {
          status: 500,
          statusText: 'Internal Server Error',
        },
      ));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    let thrownError: unknown;
    try {
      await tools.karakuri_world_get_map!.execute!({}, DEFAULT_OPTIONS);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(KarakuriWorldApiError);
    expect(thrownError).toMatchObject({
      status: 500,
      code: undefined,
      apiMessage: 'Internal Server Error',
    });
  });

  it('throws response validation errors when a successful payload is malformed', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createKarakuriWorldTools({
      apiBaseUrl: 'https://example.com',
      apiKey: 'secret',
      fetch,
    });

    let thrownError: unknown;
    try {
      await tools.karakuri_world_conversation_start!.execute!({
        target_agent_id: 'a-1',
        message: 'hi',
      }, DEFAULT_OPTIONS);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(KarakuriWorldResponseError);
    expect(thrownError).toMatchObject({
      status: 200,
      message: expect.stringContaining('Response validation failed'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
