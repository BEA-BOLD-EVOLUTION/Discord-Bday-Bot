// Lightweight in-process mutex keyed by string. Used to serialize
// non-idempotent operations that aren't already protected by a DB
// uniqueness constraint, e.g. "post the belated horoscope thread for
// guild X" or "run the americas scheduler region". Single-process only —
// the `withDbLock` wrapper below covers the multi-process case.

import { randomUUID } from 'node:crypto';
import { tryAcquireDbLock, releaseDbLock } from '../db.js';
import { logger } from '../logger.js';

const inflight = new Set();

// Stable identifier for this Node process across the run. Used as the
// `owner` in the cross-process lease table so a crashed process can
// later be identified and so we can safely release only our own leases.
export const PROCESS_OWNER_ID = `${process.pid}:${randomUUID()}`;

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

// Cross-process leased lock backed by the `process_locks` table. Use for
// operations that must not double-fire across replicas — chiefly the
// regional scheduler. If acquired, runs `fn` and releases the lease on
// settle. If another live process holds it, returns `{ acquired: false }`
// without running `fn`. If the DB itself is unreachable, falls back to
// running `fn` so the bot stays operational on a single replica.
export async function withDbLock(key, ttlSeconds, fn) {
  let held = false;
  try {
    held = await tryAcquireDbLock(key, PROCESS_OWNER_ID, ttlSeconds);
  } catch (err) {
    logger.warn('db_lock_acquire_failed', { key, error: err?.message ?? String(err) });
    // Best-effort: don't block the bot when the lock table is unreachable.
    return { acquired: true, result: await fn() };
  }
  if (!held) return { acquired: false };
  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    try {
      await releaseDbLock(key, PROCESS_OWNER_ID);
    } catch (err) {
      logger.warn('db_lock_release_failed', { key, error: err?.message ?? String(err) });
    }
  }
}
