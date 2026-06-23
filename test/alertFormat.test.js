import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatRecord } from '../src/alertFormat.js';

test('includes role_id in the context block', () => {
  // Regression: the context allowlist dropped role_id, so the "birthday role
  // not found" alert never told the admin which role to fix.
  const out = formatRecord({
    level: 'warn',
    message: 'Configured birthday role not found',
    timestamp: '2026-06-23T15:00:07.059Z',
    guild_id: '1214639345022279814',
    role_id: '1504180162927792149',
  });

  assert.match(out, /\*\*\[WARN\]\*\* Configured birthday role not found/);
  assert.match(out, /"guild_id": "1214639345022279814"/);
  assert.match(out, /"role_id": "1504180162927792149"/);
});

test('omits context keys that are absent', () => {
  const out = formatRecord({
    level: 'error',
    message: 'boom',
    timestamp: '2026-06-23T00:00:00.000Z',
    guild_id: 'g1',
  });
  assert.match(out, /"guild_id": "g1"/);
  assert.doesNotMatch(out, /role_id/);
  assert.doesNotMatch(out, /channel_id/);
});

test('renders error detail when an error is present', () => {
  const out = formatRecord({
    level: 'error',
    message: 'Command error',
    timestamp: '2026-06-23T00:00:00.000Z',
    error: { name: 'DiscordAPIError', message: 'Missing Access', code: 50001 },
    guild_id: 'g1',
  });
  assert.match(out, /Error: `DiscordAPIError: Missing Access`/);
});

test('produces no json block when there is no context', () => {
  const out = formatRecord({
    level: 'info',
    message: 'hello',
    timestamp: '2026-06-23T00:00:00.000Z',
  });
  assert.doesNotMatch(out, /```json/);
  assert.equal(out, '**[INFO]** hello\n`2026-06-23T00:00:00.000Z`');
});
