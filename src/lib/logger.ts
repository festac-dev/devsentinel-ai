/**
 * Structured JSON logging to stdout (stateless-deployment rule 3): one JSON
 * object per line so any platform can ship logs without parsing prose.
 * Never log secret values; callers pass redacted metadata only.
 */

type Level = "info" | "warn" | "error";

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    service: "devsentinel",
    role: process.env.APP_ROLE ?? "all",
    msg,
  };
  if (meta) {
    for (const [k, v] of Object.entries(meta)) {
      if (v instanceof Error) entry[k] = { name: v.name, message: v.message };
      else entry[k] = v;
    }
  }
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
