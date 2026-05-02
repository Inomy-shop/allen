/**
 * Zero-dependency structured logger for the Allen server.
 *
 * Controlled by:
 *   LOG_LEVEL  — 'debug' | 'info' | 'warn' | 'error'  (default: 'info')
 *   LOG_FORMAT — 'json'  | 'pretty'                   (default: 'pretty')
 *
 * JSON format:  { ts, level, component?, msg, ...redactedMeta }
 * Pretty format: HH:MM:SS.mmm LEVEL [component?] msg key=val ...
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogMeta extends Record<string, unknown> {
  component?: string;
  requestId?: string;
  executionId?: string;
}

export interface Logger {
  debug(msg: string, meta?: LogMeta): void;
  info(msg: string, meta?: LogMeta): void;
  warn(msg: string, meta?: LogMeta): void;
  error(msg: string, meta?: LogMeta): void;
  child(component: string): Logger;
}

// ── Level constants ──────────────────────────────────────────────────────────

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

// ── Configuration (read once at module load) ─────────────────────────────────

function parseLevel(raw: string | undefined): number {
  const key = (raw ?? 'info').toLowerCase() as LogLevel;
  return LEVEL_ORDER[key] ?? LEVEL_ORDER.info;
}

const _minLevel: number = parseLevel(process.env.LOG_LEVEL);
const _format: 'json' | 'pretty' = process.env.LOG_FORMAT === 'json' ? 'json' : 'pretty';

// ── Redaction ────────────────────────────────────────────────────────────────

const REDACT_RE = /(?:authorization|cookie|token|password|secret|key|auth)/i;

function redactValue(v: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > 6) return v;
  if (v instanceof Error) return { message: v.message, stack: v.stack };
  if (Array.isArray(v)) {
    seen.add(v as unknown as object);
    return v.map((item) => redactValue(item, depth + 1, seen));
  }
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj)) {
      out[k] = REDACT_RE.test(k) ? '[REDACTED]' : redactValue(val, depth + 1, seen);
    }
    return out;
  }
  return v;
}

function redactMeta(meta: LogMeta): Record<string, unknown> {
  const seen = new WeakSet<object>();
  seen.add(meta as object);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = REDACT_RE.test(k) ? '[REDACTED]' : redactValue(v, 1, seen);
  }
  return out;
}

// ── Formatters ───────────────────────────────────────────────────────────────

function toKv(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (k === 'component') continue; // already in the prefix bracket
    const str = typeof v === 'string'
      ? v.replace(/[\r\n\t]/g, (c) => ({ '\r': '\\r', '\n': '\\n', '\t': '\\t' }[c] ?? c))
      : JSON.stringify(v);
    parts.push(`${k}=${str}`);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

// ── Core emit ────────────────────────────────────────────────────────────────

function emit(level: LogLevel, msg: string, mergedMeta: LogMeta): void {
  // Level gate — MUST be first, before any meta assembly work
  if (LEVEL_ORDER[level] < _minLevel) return;

  try {
    const component = mergedMeta.component;
    const redacted = redactMeta(mergedMeta);

    let line: string;

    if (_format === 'json') {
      // Build record with defined key ordering: ts → level → component? → msg → ...rest
      const { component: _c, ...restMeta } = redacted;
      const record: Record<string, unknown> = {};
      record['ts'] = new Date().toISOString();
      record['level'] = level;
      if (component !== undefined) record['component'] = component;
      record['msg'] = msg;
      Object.assign(record, restMeta);
      line = JSON.stringify(record);
    } else {
      // HH:MM:SS.mmm LEVEL [component?] msg key=val ...
      const now = new Date();
      const ts = [
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
      ].join(':') + '.' + String(now.getMilliseconds()).padStart(3, '0');
      const compStr = component != null ? ` [${component}]` : '';
      line = `${ts} ${LEVEL_LABEL[level]}${compStr} ${msg}${toKv(redacted)}`;
    }

    if (level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  } catch {
    // Safety net — never let logger errors crash the server
    process.stdout.write('[logger] failed to format log entry\n');
  }
}

// ── Logger factory ───────────────────────────────────────────────────────────

function makeLogger(defaultComponent?: string): Logger {
  function merge(meta?: LogMeta): LogMeta {
    if (defaultComponent) {
      return { component: defaultComponent, ...meta };
    }
    return { ...meta };
  }

  return {
    debug(msg: string, meta?: LogMeta): void {
      // Level gate before merge (fast-path: LEVEL_ORDER['debug'] = 0)
      if (LEVEL_ORDER['debug'] < _minLevel) return;
      emit('debug', msg, merge(meta));
    },
    info(msg: string, meta?: LogMeta): void {
      if (LEVEL_ORDER['info'] < _minLevel) return;
      emit('info', msg, merge(meta));
    },
    warn(msg: string, meta?: LogMeta): void {
      if (LEVEL_ORDER['warn'] < _minLevel) return;
      emit('warn', msg, merge(meta));
    },
    error(msg: string, meta?: LogMeta): void {
      if (LEVEL_ORDER['error'] < _minLevel) return;
      emit('error', msg, merge(meta));
    },
    child(component: string): Logger {
      return makeLogger(component);
    },
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export function createLogger(): Logger {
  return makeLogger();
}

export const logger: Logger = createLogger();
