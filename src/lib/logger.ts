type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

function write(level: Level, msg: string, fields?: Fields): void {
  if (LEVELS[level] < MIN_LEVEL) return;
  const entry = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

type Logger = {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(base: Fields): Logger;
};

function makeLogger(base?: Fields): Logger {
  return {
    debug: (msg, fields) => write("debug", msg, base ? { ...base, ...fields } : fields),
    info:  (msg, fields) => write("info",  msg, base ? { ...base, ...fields } : fields),
    warn:  (msg, fields) => write("warn",  msg, base ? { ...base, ...fields } : fields),
    error: (msg, fields) => write("error", msg, base ? { ...base, ...fields } : fields),
    child: (more) => makeLogger({ ...base, ...more }),
  };
}

export const logger = makeLogger();
