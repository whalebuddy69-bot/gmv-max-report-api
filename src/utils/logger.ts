type Level = "info" | "warn" | "error";

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  const target = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (meta && Object.keys(meta).length > 0) {
    target(line, JSON.stringify(meta));
  } else {
    target(line);
  }
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => emit("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit("error", message, meta),
};
