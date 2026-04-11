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
