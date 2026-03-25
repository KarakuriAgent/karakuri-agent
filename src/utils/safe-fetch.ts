import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { Agent } from 'undici';
import { z } from 'zod';

const DEFAULT_MAX_REDIRECTS = 5;
const blockedAddressList = createBlockedAddressList();
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export const BLOCKED_TARGET_ERROR =
  'Blocked URL target: private, loopback, and link-local addresses are not allowed.';
export const DISALLOWED_PROTOCOL_ERROR = 'URL must use http or https.';

export class ResponseTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Response body exceeds ${maxBytes} bytes.`);
    this.name = 'ResponseTooLargeError';
    this.maxBytes = maxBytes;
  }
}

export const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => isAllowedProtocol(new URL(value)), 'url must use http or https');

export interface LookupAddress {
  address: string;
  family: number;
}

export type LookupFn = (
  hostname: string,
  options: { all: true; verbatim: boolean },
) => Promise<LookupAddress[]>;

interface ResolvedFetchTarget {
  parsedUrl: URL;
  hostname: string;
  addresses: LookupAddress[];
}

export async function fetchWithValidatedRedirects(
  initialUrl: string,
  options: {
    fetchFn?: typeof globalThis.fetch;
    lookupFn?: LookupFn;
    requestInit?: Omit<RequestInit, 'redirect'>;
    maxRedirects?: number;
    maxResponseBytes?: number;
  } = {},
): Promise<{ requestUrl: string; response: Response; bodyBytes?: Uint8Array }> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const lookupFn = options.lookupFn ?? (lookup as LookupFn);
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const signal = options.requestInit?.signal ?? undefined;

  let currentUrl = initialUrl;
  const visitedUrls = new Set<string>();

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    throwIfAborted(signal);

    const target = await resolveValidatedFetchTarget(currentUrl, lookupFn, signal);
    const normalizedUrl = target.parsedUrl.toString();

    if (visitedUrls.has(normalizedUrl)) {
      throw new Error('Redirect loop detected while fetching URL.');
    }

    visitedUrls.add(normalizedUrl);

    const dispatcher = target.addresses.length > 0
      ? new Agent({
        connect: {
          lookup: createPinnedLookup(target.hostname, target.addresses),
        },
      })
      : undefined;
    const requestInit = {
      ...options.requestInit,
      redirect: 'manual',
      ...(dispatcher != null ? { dispatcher } : {}),
    } as RequestInit & { dispatcher?: Agent };

    try {
      const response = await fetchFn(normalizedUrl, requestInit);

      if (isRedirectStatus(response.status)) {
        await disposeResponse(response, dispatcher);

        if (redirectCount === maxRedirects) {
          throw new Error('Too many redirects while fetching URL.');
        }

        const location = response.headers.get('location');
        if (location == null || location.trim().length === 0) {
          throw new Error('Redirect response missing Location header.');
        }

        currentUrl = new URL(location, normalizedUrl).toString();
        continue;
      }

      const bufferedResponse = await cloneResponseWithLimit(response, options.maxResponseBytes, signal);
      await closeDispatcher(dispatcher);

      return {
        requestUrl: normalizedUrl,
        response: bufferedResponse.response,
        ...(bufferedResponse.bodyBytes != null ? { bodyBytes: bufferedResponse.bodyBytes } : {}),
      };
    } catch (error) {
      dispatcher?.destroy();
      throw error;
    }
  }

  throw new Error('Too many redirects while fetching URL.');
}

export async function validateFetchTarget(url: string, lookupFn: LookupFn = lookup as LookupFn): Promise<URL> {
  return (await resolveValidatedFetchTarget(url, lookupFn)).parsedUrl;
}

async function resolveValidatedFetchTarget(
  url: string,
  lookupFn: LookupFn,
  signal?: AbortSignal,
): Promise<ResolvedFetchTarget> {
  throwIfAborted(signal);

  const parsedUrl = new URL(url);
  if (!isAllowedProtocol(parsedUrl)) {
    throw new Error(DISALLOWED_PROTOCOL_ERROR);
  }

  const hostname = normalizeHostname(parsedUrl.hostname);

  if (hostname.length === 0) {
    throw new Error('URL must include a hostname.');
  }

  if (isBlockedHostname(hostname) || isBlockedIpAddress(hostname)) {
    throw new Error(BLOCKED_TARGET_ERROR);
  }

  if (isIP(hostname) !== 0) {
    return {
      parsedUrl,
      hostname,
      addresses: [],
    };
  }

  const addresses = dedupeAddresses(await withAbortSignal(
    lookupFn(hostname, { all: true, verbatim: true }),
    signal,
  ));
  if (addresses.length === 0) {
    throw new Error(`URL hostname did not resolve: ${hostname}`);
  }

  if (addresses.some(({ address }) => isBlockedIpAddress(address))) {
    throw new Error(BLOCKED_TARGET_ERROR);
  }

  return {
    parsedUrl,
    hostname,
    addresses,
  };
}

function createPinnedLookup(hostname: string, addresses: LookupAddress[]): LookupFunction {
  const normalizedHostname = normalizeHostname(hostname);
  const normalizedAddresses = addresses.map((address) => ({
    address: normalizeHostname(address.address),
    family: normalizeAddressFamily(address.family),
  }));

  return ((requestedHostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const requested = normalizeHostname(requestedHostname);
    if (requested !== normalizedHostname) {
      callback(new Error(`Unexpected hostname lookup: ${requestedHostname}`));
      return;
    }

    const normalizedOptions = normalizeLookupOptions(options);
    const matchingAddresses = normalizedAddresses.filter((address) => (
      normalizedOptions.family === 0 || address.family === normalizedOptions.family
    ));

    if (matchingAddresses.length === 0) {
      callback(new Error(`No validated DNS results available for ${requestedHostname}.`));
      return;
    }

    if (normalizedOptions.all) {
      callback(null, matchingAddresses.map((address) => ({
        address: address.address,
        family: address.family,
      })));
      return;
    }

    const selectedAddress = matchingAddresses[0]!;
    callback(null, selectedAddress.address, selectedAddress.family);
  }) as LookupFunction;
}

async function cloneResponseWithLimit(
  response: Response,
  maxBytes?: number,
  signal?: AbortSignal,
): Promise<{ response: Response; bodyBytes?: Uint8Array }> {
  const bodyBytes = await readResponseBytes(response, maxBytes, signal);

  return {
    response: new Response(bodyBytes, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    }),
    ...(bodyBytes != null ? { bodyBytes } : {}),
  };
}

async function readResponseBytes(
  response: Response,
  maxBytes?: number,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  throwIfAborted(signal);

  if (response.body == null) {
    return undefined;
  }

  const contentLengthHeader = response.headers.get('content-length');
  if (maxBytes != null && contentLengthHeader != null) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body.cancel();
      throw new ResponseTooLargeError(maxBytes);
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await withAbortSignal(reader.read(), signal);
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (maxBytes != null && totalBytes > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(maxBytes);
    }

    chunks.push(value);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return merged;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw getAbortReason(signal);
  }
}

function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal == null) {
    return promise;
  }

  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(getAbortReason(signal));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function disposeResponse(response: Response, dispatcher?: Agent): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore cleanup failures and continue closing the dispatcher.
  }

  await closeDispatcher(dispatcher);
}

async function closeDispatcher(dispatcher?: Agent): Promise<void> {
  if (dispatcher == null) {
    return;
  }

  try {
    await dispatcher.close();
  } catch {
    dispatcher.destroy();
  }
}

function dedupeAddresses(addresses: LookupAddress[]): LookupAddress[] {
  const seen = new Set<string>();
  const deduped: LookupAddress[] = [];

  for (const entry of addresses) {
    const normalizedAddress = normalizeHostname(entry.address);
    const normalizedFamily = normalizeAddressFamily(entry.family);
    const key = `${normalizedFamily}:${normalizedAddress}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({
      address: normalizedAddress,
      family: normalizedFamily,
    });
  }

  return deduped;
}

function normalizeLookupOptions(options: unknown): { all: boolean; family: number } {
  if (typeof options === 'number') {
    return {
      all: false,
      family: normalizeAddressFamily(options),
    };
  }

  if (options == null || typeof options !== 'object') {
    return { all: false, family: 0 };
  }

  const lookupOptions = options as { all?: unknown; family?: unknown };
  return {
    all: lookupOptions.all === true,
    family: typeof lookupOptions.family === 'number'
      ? normalizeAddressFamily(lookupOptions.family)
      : 0,
  };
}

function normalizeAddressFamily(family: number): number {
  return family === 4 || family === 6 ? family : 0;
}

function isAllowedProtocol(url: URL): boolean {
  return ALLOWED_PROTOCOLS.has(url.protocol);
}

function createBlockedAddressList(): BlockList {
  const blockList = new BlockList();

  blockList.addSubnet('0.0.0.0', 8, 'ipv4');
  blockList.addSubnet('10.0.0.0', 8, 'ipv4');
  blockList.addSubnet('100.64.0.0', 10, 'ipv4');
  blockList.addSubnet('127.0.0.0', 8, 'ipv4');
  blockList.addSubnet('169.254.0.0', 16, 'ipv4');
  blockList.addSubnet('172.16.0.0', 12, 'ipv4');
  blockList.addSubnet('192.0.0.0', 24, 'ipv4');
  blockList.addSubnet('192.0.2.0', 24, 'ipv4');
  blockList.addSubnet('192.168.0.0', 16, 'ipv4');
  blockList.addSubnet('198.18.0.0', 15, 'ipv4');
  blockList.addSubnet('198.51.100.0', 24, 'ipv4');
  blockList.addSubnet('203.0.113.0', 24, 'ipv4');
  blockList.addSubnet('240.0.0.0', 4, 'ipv4');
  blockList.addSubnet('::', 128, 'ipv6');
  blockList.addSubnet('::1', 128, 'ipv6');
  blockList.addSubnet('fc00::', 7, 'ipv6');
  blockList.addSubnet('fe80::', 10, 'ipv6');

  return blockList;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function isBlockedHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

function isBlockedIpAddress(address: string): boolean {
  const normalizedAddress = normalizeHostname(address);
  const ipVersion = isIP(normalizedAddress);

  if (ipVersion === 0) {
    return false;
  }

  if (ipVersion === 6) {
    const mappedIPv4 = extractMappedIPv4(normalizedAddress);
    if (mappedIPv4 != null) {
      return blockedAddressList.check(mappedIPv4, 'ipv4');
    }
  }

  return blockedAddressList.check(normalizedAddress, ipVersion === 4 ? 'ipv4' : 'ipv6');
}

function extractMappedIPv4(ipv6: string): string | null {
  if (!ipv6.startsWith('::ffff:')) {
    return null;
  }

  const suffix = ipv6.slice('::ffff:'.length);

  if (isIP(suffix) === 4) {
    return suffix;
  }

  const match = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(suffix);
  if (match != null) {
    const high = Number.parseInt(match[1]!, 16);
    const low = Number.parseInt(match[2]!, 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }

  return null;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
