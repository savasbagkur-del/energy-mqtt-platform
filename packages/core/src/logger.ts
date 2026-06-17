import { appConfig, type LogLevel } from "./config.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export interface Logger {
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
  child: (scope: string) => Logger;
}

/**
 * Minimal zero-dependency structured logger. Emits one JSON line per record and respects
 * `appConfig.logLevel` so per-message firehose logs can run at `debug` without flooding stdout
 * at fleet scale. Bridge toward a full logging stack (pino/OTel) in a later phase.
 */
export const createLogger = (scope: string): Logger => {
  const threshold = LEVEL_ORDER[appConfig.logLevel];

  const emit = (
    level: LogLevel,
    msg: string,
    fields?: Record<string, unknown>
  ): void => {
    if (LEVEL_ORDER[level] < threshold) {
      return;
    }
    const record = {
      level,
      scope,
      msg,
      time: new Date().toISOString(),
      ...(fields ?? {})
    };
    const line = JSON.stringify(record);
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (childScope: string) => createLogger(`${scope}:${childScope}`)
  };
};
