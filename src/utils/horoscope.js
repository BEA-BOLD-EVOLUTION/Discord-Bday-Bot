// Daily horoscope fetcher backed by freehoroscopeapi.com.
//
// - Free, no auth, no rate limit documented; we still cache aggressively to
//   stay polite: at most one HTTP call per (sign, ISO date) across the whole
//   process, so a worst-case day costs 12 requests no matter how many guilds
//   or members we serve.
// - Failures are swallowed and return `null`. The caller falls back to a
//   horoscope-less announcement so a flaky third party never blocks a
//   birthday shoutout.

import { logger } from '../logger.js';

const BASE_URL = 'https://freehoroscopeapi.com/api/v1/get-horoscope/daily';
const TIMEOUT_MS = 5_000;

// key: `${sign}|${isoDate}` -> { text, fetchedAt }
const cache = new Map();
const MAX_CACHE_ENTRIES = 200;

/** Returns true if horoscope lookups are enabled via env (default: enabled). */
export function horoscopeEnabled() {
  const v = process.env.HOROSCOPE_ENABLED;
  if (v === undefined || v === null || v === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

/**
 * Returns true if the daily horoscope should be posted in a thread off the
 * announcement message (default: enabled). When false, the embed is posted
 * inline in the announcement channel.
 */
export function threadsEnabled() {
  const v = process.env.HOROSCOPE_THREAD;
  if (v === undefined || v === null || v === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

/**
 * Fetch the daily horoscope for a sign. Cached per (sign, isoDate).
 * @param {string} sign  e.g. 'aquarius'
 * @param {string} isoDate  e.g. '2026-05-13'
 * @returns {Promise<string|null>}
 */
export async function fetchDailyHoroscope(sign, isoDate) {
  if (!horoscopeEnabled()) return null;
  if (!sign || !isoDate) return null;

  const key = `${sign.toLowerCase()}|${isoDate}`;
  if (cache.has(key)) return cache.get(key).text;

  try {
    const url = `${BASE_URL}?sign=${encodeURIComponent(sign.toLowerCase())}`;
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn('Horoscope fetch returned non-OK', { sign, status: res.status });
      return null;
    }
    const body = await res.json();
    const text = body?.data?.horoscope?.trim();
    if (!text) return null;

    // Bound cache size; FIFO eviction is fine since entries are dated.
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(key, { text, fetchedAt: Date.now() });
    return text;
  } catch (err) {
    logger.warn('Horoscope fetch failed', { sign, error: err });
    return null;
  }
}
