import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMemoryMaintenanceModelConfig, handleRequest } from '../src/index.js';
import { parseModelSelector } from '../src/llm/model-selector.js';

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error != null) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

describe('handleRequest', () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (server != null) {
      await closeServer(server);
      server = undefined;
    }
  });

  it('always configures no-thinking maintenance requests', async () => {
    const baseFetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', baseFetch);

    const config = createMemoryMaintenanceModelConfig({
      llmApiKey: 'main-key',
      llmBaseUrl: 'https://main.example/v1',
      llmModelSelector: parseModelSelector('openai/chat/gpt-4o'),
      postResponseLlmApiKey: 'post-key',
      postResponseLlmBaseUrl: 'https://post.example/v1',
      postResponseLlmModelSelector: parseModelSelector('openai/gpt-4.1'),
    });

    await config.modelFactoryOptions.fetch?.('https://example.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ input: 'ping' }),
    });

    expect(config.modelSelector).toEqual(parseModelSelector('openai/gpt-4.1'));
    expect(config.modelFactoryOptions.apiKey).toBe('post-key');
    expect(config.modelFactoryOptions.baseURL).toBe('https://post.example/v1');
    expect(config.providerOptions).toEqual({ openai: { reasoningEffort: 'low' } });
    expect(baseFetch).toHaveBeenCalledWith(
      'https://example.com/v1/responses',
      expect.objectContaining({
        body: JSON.stringify({ input: 'ping', enable_thinking: false }),
      }),
    );
  });

  it('returns health for both GET and HEAD probes', async () => {
    let gatewayConnected = false;
    const bot = {
      isGatewayConnected(): boolean {
        return gatewayConnected;
      },
      async handleWebhook(): Promise<Response> {
        return new Response('unexpected webhook call', { status: 500 });
      },
    } satisfies Parameters<typeof handleRequest>[0];

    server = createServer((request, response) => {
      void handleRequest(bot, 0, request, response);
    });
    await listen(server);

    const { port } = server.address() as AddressInfo;
    const healthzUrl = `http://127.0.0.1:${port}/healthz`;

    let healthzResponse = await fetch(healthzUrl);
    expect(healthzResponse.status).toBe(503);
    expect(await healthzResponse.text()).toBe('discord gateway unavailable');

    let headHealthzResponse = await fetch(healthzUrl, { method: 'HEAD' });
    expect(headHealthzResponse.status).toBe(503);
    expect(await headHealthzResponse.text()).toBe('');

    gatewayConnected = true;

    healthzResponse = await fetch(healthzUrl);
    expect(healthzResponse.status).toBe(200);
    expect(await healthzResponse.text()).toBe('ok');

    headHealthzResponse = await fetch(healthzUrl, { method: 'HEAD' });
    expect(headHealthzResponse.status).toBe(200);
    expect(await headHealthzResponse.text()).toBe('');

    gatewayConnected = false;

    healthzResponse = await fetch(healthzUrl);
    expect(healthzResponse.status).toBe(503);
    expect(await healthzResponse.text()).toBe('discord gateway unavailable');

    headHealthzResponse = await fetch(healthzUrl, { method: 'HEAD' });
    expect(headHealthzResponse.status).toBe(503);
    expect(await headHealthzResponse.text()).toBe('');
  });
});
