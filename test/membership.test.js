import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchMemberSafe, UNKNOWN_MEMBER } from '../src/utils/membership.js';

// Minimal stand-in for a discord.js Guild: only the bits fetchMemberSafe
// touches (`id` for logging, `members.fetch`).
function makeGuild(fetchImpl) {
  return { id: 'guild-1', members: { fetch: fetchImpl } };
}

// A DiscordAPIError-like object carries a numeric `code`.
function apiError(code, message = 'api error') {
  return Object.assign(new Error(message), { code });
}

test('resolves a present member', async () => {
  const member = { id: 'user-1' };
  const { member: got, gone } = await fetchMemberSafe(
    makeGuild(async () => member),
    'user-1'
  );
  assert.equal(got, member);
  assert.equal(gone, false);
});

test('treats Unknown Member (10007) as a confirmed non-member', async () => {
  const { member, gone } = await fetchMemberSafe(
    makeGuild(async () => {
      throw apiError(UNKNOWN_MEMBER);
    }),
    'user-2'
  );
  assert.equal(member, null);
  assert.equal(gone, true);
});

test('treats a rate-limit / 5xx as transient (membership unknown)', async () => {
  const { member, gone } = await fetchMemberSafe(
    makeGuild(async () => {
      throw apiError(50001, 'Missing Access');
    }),
    'user-3'
  );
  assert.equal(member, null);
  assert.equal(gone, false);
});

test('treats a network error with no code as transient', async () => {
  const { member, gone } = await fetchMemberSafe(
    makeGuild(async () => {
      throw new Error('ECONNRESET');
    }),
    'user-4'
  );
  assert.equal(member, null);
  assert.equal(gone, false);
});
