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
  'karakuri_world_get_perception',
  'karakuri_world_get_available_actions',
  'karakuri_world_get_map',
  'karakuri_world_get_world_agents',
  'karakuri_world_move',
  'karakuri_world_action',
  'karakuri_world_wait',
  'karakuri_world_conversation_start',
  'karakuri_world_conversation_accept',
  'karakuri_world_conversation_reject',
  'karakuri_world_conversation_speak',
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
    expect(karakuriWorldInputSchema.parse({ operation: 'wait', duration_ms: '1000' })).toEqual({
      operation: 'wait',
      duration_ms: 1000,
    });
    expect(() => karakuriWorldInputSchema.parse({ operation: 'get_map', extra: true })).toThrow();
    expect(() => karakuriWorldInputSchema.parse({ operation: 'wait', duration_ms: '1000ms' })).toThrow();
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
      comment: '門へ向かいます。',
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
    const perceptionInputSchema = tools.karakuri_world_get_perception?.inputSchema as {
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
    expect(perceptionInputSchema.safeParse({}).success).toBe(false);
    expect(perceptionInputSchema.safeParse({ comment: 'まず観察します。' }).success).toBe(true);
    expect(perceptionInputSchema.safeParse({ comment: '' }).success).toBe(false);
  });

  it('uses GET endpoints without sending a request body for read operations', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          rows: 2,
          cols: 2,
          nodes: { '1-1': { type: 'plain' } },
          buildings: [],
          npcs: [],
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
      rows: 2,
      cols: 2,
      nodes: { '1-1': { type: 'plain' } },
      buildings: [],
      npcs: [],
    });
  });

  it('accepts perception current_node metadata that the server may include', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify({
          current_node: {
            node_id: '1-1',
            type: 'door',
            label: 'Gate',
            building_id: 'gatehouse',
          },
          nodes: [
            {
              node_id: '1-1',
              type: 'door',
              label: 'Gate',
              distance: 0,
            },
          ],
          agents: [],
          npcs: [],
          buildings: [],
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

    const result = await tools.karakuri_world_get_perception!.execute!({}, DEFAULT_OPTIONS);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      current_node: {
        node_id: '1-1',
        type: 'door',
        label: 'Gate',
        building_id: 'gatehouse',
      },
      nodes: [
        {
          node_id: '1-1',
          type: 'door',
          label: 'Gate',
          distance: 0,
        },
      ],
      agents: [],
      npcs: [],
      buildings: [],
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
          current_node: { node_id: '1-1', type: 'plain' },
          nodes: [],
          agents: [],
          npcs: [],
          buildings: [],
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

    const result = await tools.karakuri_world_get_perception!.execute!({}, DEFAULT_OPTIONS);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ current_node: { node_id: '1-1' } });
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
      tools.karakuri_world_wait!.execute!({ duration_ms: 1000 }, DEFAULT_OPTIONS),
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
            current_node: { node_id: '1-1', type: 'plain' },
            nodes: [],
            agents: [],
            npcs: [],
            buildings: [],
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

      const result = await tools.karakuri_world_get_perception!.execute!({}, DEFAULT_OPTIONS);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(timeoutSpy).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(fetch.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(fetch.mock.calls[0]?.[1]?.signal).not.toBe(fetch.mock.calls[1]?.[1]?.signal);
      expect(result).toMatchObject({ current_node: { node_id: '1-1' } });
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
      duration_ms: '1000',
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
        body: JSON.stringify({ duration_ms: 1000 }),
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(result).toEqual({ completes_at: 123 });
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
      { conversation_id: 'conv-1', message: 'hello' },
      DEFAULT_OPTIONS,
    );

    expect(result).toEqual({
      status: 'busy',
      message: 'It is not your turn to speak.',
      instruction: expect.stringContaining('再送しないでください'),
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
      await tools.karakuri_world_get_perception!.execute!({}, DEFAULT_OPTIONS);
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
      await tools.karakuri_world_get_perception!.execute!({}, DEFAULT_OPTIONS);
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
