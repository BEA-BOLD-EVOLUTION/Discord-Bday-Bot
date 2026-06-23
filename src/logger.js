// Structured logger with an in-memory ring buffer of recent errors.
// JSON output is enabled when LOG_FORMAT=json so production hosts can ship
// logs to a centralized aggregator. Secrets are redacted before emission.

import { inspect } from 'node:util';

const JSON_MODE = process.env.LOG_FORMAT === 'json';
const DEBUG = !!process.env.DEBUG;

const SECRET_KEYS = /(token|secret|password|api[_-]?key|service[_-]?role|authorization)/i;

function redact(value, depth = 0) {
  if (value == null) return value;
  if (depth > 4) return '[depth-limit]';
  if (typeof value === 'string') {
    if (value.length > 40 && /^[A-Za-z0-9._\-+/=]+$/.test(value)) return '[REDACTED]';
    return value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.test(k)) out[k] = '[REDACTED]';
    else out[k] = redact(v, depth + 1);
  }
  return out;
}

function serializeError(err) {
  if (!err || typeof err !== 'object') return err;
  return {
    name: err.name,
    message: err.message,
    code: err.code,
    stack: err.stack?.split('\n').slice(0, 6).join('\n'),
  };
}

const ERROR_BUFFER_LIMIT = 50;
const errorBuffer = []; // newest first

// Optional sink invoked for every warn/error record. Used by index.js to
// forward alerts to a per-guild Discord alert channel. Must never throw
// (the logger is the last line of defense).
let notifier = null;
export function setLogNotifier(fn) {
  notifier = typeof fn === 'function' ? fn : null;
}

function pushErrorRecord(record) {
  errorBuffer.unshift(record);
  if (errorBuffer.length > ERROR_BUFFER_LIMIT) errorBuffer.length = ERROR_BUFFER_LIMIT;
}

export function getRecentErrors({ guildId = null, limit = 10 } = {}) {
  const filtered = guildId
    ? errorBuffer.filter((e) => !e.guild_id || e.guild_id === guildId)
    : errorBuffer;
  return filtered.slice(0, limit);
}

function emit(level, message, fields = {}) {
  // Serialize the error BEFORE redacting. redact() flattens objects via
  // Object.entries (own-enumerable only), which would strip an Error's
  // name/message/stack and leave just enumerable props like `code`.
  const prepared = fields?.error ? { ...fields, error: serializeError(fields.error) } : fields;
  const safeFields = redact(prepared) ?? {};
  const record = {
    timestamp: new Date().toISOString(),
    level,
    message: typeof message === 'string' ? message : String(message),
    ...safeFields,
  };
  if (level === 'error' || level === 'warn') {
    pushErrorRecord(record);
    if (notifier) {
      try { notifier(record); } catch { /* never throw from logger */ }
    }
  }

  if (JSON_MODE) {
    const line = JSON.stringify(record) + '\n';
    // Single write per record → no interleaving between concurrent calls.
    if (level === 'error') process.stderr.write(line);
    else process.stdout.write(line);
    return;
  }
  // Text mode: also emit each record as a single write so concurrent
  // logger calls can't interleave their field dumps on stdout/stderr.
  // util.inspect with breakLength:Infinity + compact:true keeps the
  // fields on one line, which is what you want for grep anyway.
  const prefix = `[${record.timestamp}] [${level}]`;
  const hasFields = Object.keys(safeFields).length > 0;
  const extra = hasFields
    ? ' ' + inspect(safeFields, { depth: 5, breakLength: Infinity, compact: true, colors: false })
    : '';
  const line = `${prefix} ${record.message}${extra}\n`;
  if (level === 'error' || level === 'warn') process.stderr.write(line);
  else process.stdout.write(line);
}

export const logger = {
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
  debug: (message, fields) => {
    if (DEBUG) emit('debug', message, fields);
  },
};
