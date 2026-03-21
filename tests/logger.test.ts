import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger, type Logger } from '../src/utils/logger.js';

describe('createLogger', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let originalLogLevel: string | undefined;

  beforeEach(() => {
    originalLogLevel = process.env.LOG_LEVEL;
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
    vi.restoreAllMocks();
  });

  it('returns an object satisfying the Logger interface', () => {
    const logger: Logger = createLogger('Test');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('suppresses info and warn when LOG_LEVEL=error', () => {
    process.env.LOG_LEVEL = 'error';
    const logger = createLogger('Test');

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('outputs all levels when LOG_LEVEL=debug', () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = createLogger('Test');

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('defaults to info level when LOG_LEVEL is unset', () => {
    delete process.env.LOG_LEVEL;
    const logger = createLogger('Test');

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('includes timestamp, level, and module name in output', () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = createLogger('MyModule');

    logger.info('hello');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const message = logSpy.mock.calls[0]![0] as string;
    expect(message).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] \[MyModule\] hello$/);
  });

  it('falls back to info level for invalid LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'INVALID';
    const logger = createLogger('Test');

    logger.debug('d');
    logger.info('i');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('passes extra args to console methods', () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = createLogger('Test');
    const err = new Error('test error');

    logger.error('failed', err);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[ERROR] [Test] failed'), err);
  });

  it('evaluates LOG_LEVEL lazily on each call', () => {
    delete process.env.LOG_LEVEL;
    const logger = createLogger('Test');

    logger.debug('should be suppressed');
    expect(debugSpy).not.toHaveBeenCalled();

    process.env.LOG_LEVEL = 'debug';
    logger.debug('should now appear');
    expect(debugSpy).toHaveBeenCalledTimes(1);
  });
});
