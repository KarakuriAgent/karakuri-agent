import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { handleRequest } from '../src/index.js';

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
    if (server != null) {
      await closeServer(server);
      server = undefined;
    }
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
