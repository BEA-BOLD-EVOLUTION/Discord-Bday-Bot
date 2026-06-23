import { test } from 'node:test';
import assert from 'node:assert/strict';

import { logger, setLogNotifier, getRecentErrors } from '../src/logger.js';

// Capture the structured record the logger emits (warn/error are forwarded to
// the notifier) while silencing the actual stdout/stderr writes so test output
// stays clean. emit() is synchronous, so the record is set by the time fn
// returns.
function capture(fn) {
  let record = null;
  setLogNotifier((r) => {
    record = r;
  });
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    setLogNotifier(null);
  }
  return record;
}

test('serializes Error name/message/code/stack instead of dropping them', () => {
  // Regression: redact() used to flatten the Error (own-enumerable props only)
  // before serializeError ran, leaving only { code } and undefined name/message/stack.
  const err = Object.assign(new Error('Missing Access'), { code: 50001 });
  const rec = capture(() =>
    logger.error('Command error', { command: 'birthday-panel', error: err })
  );

  assert.equal(rec.error.name, 'Error');
  assert.equal(rec.error.message, 'Missing Access');
  assert.equal(rec.error.code, 50001);
  assert.ok(rec.error.stack?.startsWith('Error: Missing Access'), 'stack should be preserved');
  assert.equal(rec.command, 'birthday-panel');
});

test('redacts secret-looking field keys', () => {
  const rec = capture(() =>
    logger.warn('boot', { token: 'a'.repeat(50), authorization: 'Bearer xyz', guild_id: 'g1' })
  );
  assert.equal(rec.token, '[REDACTED]');
  assert.equal(rec.authorization, '[REDACTED]');
  assert.equal(rec.guild_id, 'g1');
});

test('redacts long opaque token-like string values', () => {
  const longToken = 'abcDEF1234567890_-./=abcDEF1234567890_-./=';
  assert.ok(longToken.length > 40);
  const rec = capture(() => logger.error('x', { note: longToken }));
  assert.equal(rec.note, '[REDACTED]');
});

test('getRecentErrors is newest-first and filters by guild', () => {
  capture(() => logger.error('first-err', { guild_id: 'gA' }));
  capture(() => logger.error('second-err', { guild_id: 'gB' }));

  const recent = getRecentErrors({ limit: 10 });
  const iFirst = recent.findIndex((r) => r.message === 'first-err');
  const iSecond = recent.findIndex((r) => r.message === 'second-err');
  assert.ok(iSecond >= 0 && iFirst >= 0);
  assert.ok(iSecond < iFirst, 'most recent error should come first');

  const gB = getRecentErrors({ guildId: 'gB', limit: 50 });
  assert.ok(gB.some((r) => r.message === 'second-err'));
  assert.ok(
    gB.every((r) => !r.guild_id || r.guild_id === 'gB'),
    'guild filter should exclude other guilds'
  );
});

test('info logs are not added to the error buffer', () => {
  capture(() => logger.info('plain-info', { guild_id: 'gInfo' }));
  const hit = getRecentErrors({ limit: 100 }).filter((r) => r.message === 'plain-info');
  assert.equal(hit.length, 0);
});
