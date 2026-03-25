import type { SnsCredentials } from '../config.js';
import type { LookupFn } from '../utils/safe-fetch.js';

import { MastodonProvider } from './mastodon.js';
import type { SnsProvider } from './types.js';

export interface CreateSnsProviderOptions extends SnsCredentials {
  fetch?: typeof fetch;
  lookupFn?: LookupFn;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function createSnsProvider({
  provider,
  instanceUrl,
  accessToken,
  fetch,
  lookupFn,
  sleep,
}: CreateSnsProviderOptions): SnsProvider {
  switch (provider) {
    case 'mastodon':
      return new MastodonProvider({
        instanceUrl,
        accessToken,
        ...(fetch != null ? { fetch } : {}),
        ...(lookupFn != null ? { lookupFn } : {}),
        ...(sleep != null ? { sleep } : {}),
      });
  }
}
