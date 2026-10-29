// Minimal levelled logger. Call-compatible with console.* so call sites stay
// unchanged; emits one JSON line per entry in production, plain text otherwise.
// LOG_LEVEL (debug | info | warn | error | silent) overrides the default.
type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const threshold = (): number => {
  const configured = process.env.LOG_LEVEL as keyof typeof ORDER | undefined;
  if (configured && configured in ORDER) return ORDER[configured];
  return process.env.NODE_ENV === 'test' ? ORDER.error : ORDER.info;
};

const format = (arg: unknown): unknown =>
  arg instanceof Error ? { name: arg.name, message: arg.message, stack: arg.stack } : arg;

const emit = (level: Level, args: unknown[]): void => {
  if (ORDER[level] < threshold()) return;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (process.env.NODE_ENV === 'production') {
    const [first, ...rest] = args;
    sink(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        msg: typeof first === 'string' ? first : format(first),
        ...(rest.length ? { details: rest.map(format) } : {}),
      })
    );
  } else {
    sink(...args);
  }
};

export const logger = {
  debug: (...args: unknown[]) => emit('debug', args),
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
};
