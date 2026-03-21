import { mkdirSync, watch, type FSWatcher } from 'node:fs';

import { createLogger } from './logger.js';

const logger = createLogger('FileWatcher');

export interface WatchDisposable {
  unsubscribe(): void;
}

interface WatchState {
  watcher: FSWatcher;
  callback: () => Promise<void>;
  filenameFilter?: RegExp;
  debounceMs: number;
  generation: number;
  completedGeneration: number;
  running: boolean;
  timer: NodeJS.Timeout | null;
  closed: boolean;
}

export class FileWatcher {
  private readonly watches = new Set<WatchState>();
  private closed = false;

  watch(
    directory: string,
    callback: () => Promise<void>,
    options: { filenameFilter?: RegExp; debounceMs?: number } = {},
  ): WatchDisposable {
    if (this.closed) {
      throw new Error('FileWatcher is already closed');
    }

    mkdirSync(directory, { recursive: true });

    const state: WatchState = {
      watcher: watch(directory, (eventType, filename) => {
        if (state.closed || (eventType !== 'change' && eventType !== 'rename')) {
          return;
        }

        if (!matchesFilename(filename, state.filenameFilter)) {
          return;
        }

        state.generation += 1;
        this.schedule(state);
      }),
      callback,
      ...(options.filenameFilter != null ? { filenameFilter: options.filenameFilter } : {}),
      debounceMs: options.debounceMs ?? 50,
      generation: 0,
      completedGeneration: 0,
      running: false,
      timer: null,
      closed: false,
    };

    this.watches.add(state);
    logger.debug('Watching directory', { directory });
    state.watcher.on('error', (error) => {
      if (!state.closed) {
        logger.warn(`File watcher error in ${directory}`, error);
      }
    });

    return {
      unsubscribe: () => {
        this.dispose(state);
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const state of [...this.watches]) {
      this.dispose(state);
    }
    logger.debug('FileWatcher closed');
  }

  private schedule(state: WatchState): void {
    if (state.closed) {
      return;
    }

    if (state.timer != null) {
      clearTimeout(state.timer);
    }

    state.timer = setTimeout(() => {
      state.timer = null;
      void this.run(state);
    }, state.debounceMs);
  }

  private async run(state: WatchState): Promise<void> {
    if (state.closed || state.running || state.generation <= state.completedGeneration) {
      return;
    }

    state.running = true;
    const targetGeneration = state.generation;

    try {
      await state.callback();
      state.completedGeneration = targetGeneration;
    } catch (error) {
      logger.warn('File watcher callback failed', error);
    } finally {
      state.running = false;

      if (!state.closed && state.generation > state.completedGeneration) {
        this.schedule(state);
      }
    }
  }

  private dispose(state: WatchState): void {
    if (state.closed) {
      return;
    }

    state.closed = true;
    if (state.timer != null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.watcher.close();
    this.watches.delete(state);
  }
}

function matchesFilename(filename: string | Buffer | null, filenameFilter?: RegExp): boolean {
  if (filenameFilter == null) {
    return true;
  }

  if (filename == null) {
    return true;
  }

  return filenameFilter.test(filename.toString());
}
