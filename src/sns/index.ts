import type { SnsCredentials } from '../config.js';
import type { LookupFn } from '../utils/safe-fetch.js';

import { MastodonProvider } from './mastodon.js';
import { XProvider } from './x.js';
import type { SnsProvider } from './types.js';

export type CreateSnsProviderOptions = SnsCredentials & {
  dataDir?: string;
  fetch?: typeof fetch;
  lookupFn?: LookupFn;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function createSnsProvider(options: CreateSnsProviderOptions): SnsProvider {
  switch (options.provider) {
    case 'mastodon':
      return new MastodonProvider({
        instanceUrl: options.instanceUrl,
        accessToken: options.accessToken,
        ...(options.fetch != null ? { fetch: options.fetch } : {}),
        ...(options.lookupFn != null ? { lookupFn: options.lookupFn } : {}),
        ...(options.sleep != null ? { sleep: options.sleep } : {}),
      });
    case 'x':
      return new XProvider({
        accessToken: options.accessToken,
        ...(options.clientId != null ? { clientId: options.clientId } : {}),
        ...(options.clientSecret != null ? { clientSecret: options.clientSecret } : {}),
        ...(options.refreshToken != null ? { refreshToken: options.refreshToken } : {}),
        ...(options.apiKey != null ? { apiKey: options.apiKey } : {}),
        ...(options.apiSecret != null ? { apiSecret: options.apiSecret } : {}),
        ...(options.accessTokenSecret != null ? { accessTokenSecret: options.accessTokenSecret } : {}),
        ...(options.dataDir != null ? { dataDir: options.dataDir } : {}),
        ...(options.lookupFn != null ? { lookupFn: options.lookupFn } : {}),
        ...(options.sleep != null ? { sleep: options.sleep } : {}),
      });
  }
}
