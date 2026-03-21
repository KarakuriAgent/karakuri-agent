export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

type LogLevel = keyof typeof LEVELS;

function resolveLogLevel(): number {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw != null && raw in LEVELS) {
    return LEVELS[raw as LogLevel];
  }
  return LEVELS.info;
}

export function createLogger(name: string): Logger {
  return {
    debug(message: string, ...args: unknown[]): void {
      if (resolveLogLevel() <= LEVELS.debug) {
        console.debug(`${new Date().toISOString()} [DEBUG] [${name}] ${message}`, ...args);
      }
    },
    info(message: string, ...args: unknown[]): void {
      if (resolveLogLevel() <= LEVELS.info) {
        console.log(`${new Date().toISOString()} [INFO] [${name}] ${message}`, ...args);
      }
    },
    warn(message: string, ...args: unknown[]): void {
      if (resolveLogLevel() <= LEVELS.warn) {
        console.warn(`${new Date().toISOString()} [WARN] [${name}] ${message}`, ...args);
      }
    },
    error(message: string, ...args: unknown[]): void {
      if (resolveLogLevel() <= LEVELS.error) {
        console.error(`${new Date().toISOString()} [ERROR] [${name}] ${message}`, ...args);
      }
    },
  };
}
