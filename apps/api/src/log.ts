export type Logger = {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

/** One JSON line per event. Never call it with message text unless LOG_PROMPTS is on. */
export const createLogger = (sink: (line: string) => void = (line) => console.log(line), now: () => Date = () => new Date()): Logger => {
  const write = (level: "info" | "error", event: string, fields: Record<string, unknown>) => sink(JSON.stringify({ ts: now().toISOString(), level, event, ...fields }));
  return {
    info: (event, fields = {}) => write("info", event, fields),
    error: (event, fields = {}) => write("error", event, fields),
  };
};

export const silentLogger: Logger = { info: () => undefined, error: () => undefined };
