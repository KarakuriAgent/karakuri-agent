export function waitForDuration(durationMs: number): {
  promise: Promise<void>;
  cleanup(): void;
} {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return {
    promise: new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timeout = null;
        resolve();
      }, durationMs);
    }),
    cleanup() {
      if (timeout == null) {
        return;
      }

      clearTimeout(timeout);
      timeout = null;
    },
  };
}

export function waitForAbort(signal: AbortSignal): {
  promise: Promise<'aborted'>;
  cleanup(): void;
} {
  if (signal.aborted) {
    return {
      promise: Promise.resolve('aborted'),
      cleanup() {},
    };
  }

  let onAbort: (() => void) | null = null;

  return {
    promise: new Promise<'aborted'>((resolve) => {
      onAbort = () => {
        resolve('aborted');
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }),
    cleanup() {
      if (onAbort == null) {
        return;
      }

      signal.removeEventListener('abort', onAbort);
      onAbort = null;
    },
  };
}
