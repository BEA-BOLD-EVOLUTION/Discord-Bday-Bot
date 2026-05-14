// Lightweight in-process mutex keyed by string. Used to serialize
// non-idempotent operations that aren't already protected by a DB
// uniqueness constraint, e.g. "post the belated horoscope thread for
// guild X" or "run the americas scheduler region". Single-process only —
// if the bot is ever scaled horizontally this must move to a shared
// store (Redis, Postgres advisory locks).

const inflight = new Set();

// Try to acquire `key`. If already held, returns
// `{ acquired: false }`. Otherwise runs `fn` and releases on settle.
// `fn`'s result is exposed as `result`.
export async function withLock(key, fn) {
  if (inflight.has(key)) return { acquired: false };
  inflight.add(key);
  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    inflight.delete(key);
  }
}

// Inspect / introspect for diagnostics.
export function lockHeld(key) {
  return inflight.has(key);
}

export function activeLocks() {
  return [...inflight];
}
