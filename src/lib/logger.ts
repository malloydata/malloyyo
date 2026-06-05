type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL as Level] ?? 20;
const IS_DEV = process.env.NODE_ENV !== "production";

function write(level: Level, msg: string, fields?: Fields): void {
  if (LEVELS[level] < MIN_LEVEL) return;
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (IS_DEV) {
    const extra = fields ? " " + JSON.stringify(fields) : "";
    out(`[${level.toUpperCase()}] ${msg}${extra}`);
  } else {
    out(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
  }
}

export function serializeErr(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err) };
}

type Logger = {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
};

function makeLogger(base?: Fields): Logger {
  return {
    debug: (msg, fields) => write("debug", msg, base ? { ...base, ...fields } : fields),
    info:  (msg, fields) => write("info",  msg, base ? { ...base, ...fields } : fields),
    warn:  (msg, fields) => write("warn",  msg, base ? { ...base, ...fields } : fields),
    error: (msg, fields) => write("error", msg, base ? { ...base, ...fields } : fields),
    child: (fields) => makeLogger({ ...base, ...fields }),
  };
}

export const logger = makeLogger();
