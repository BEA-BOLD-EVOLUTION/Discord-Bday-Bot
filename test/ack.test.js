import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ackReply,
  ackUpdate,
  isUnknownInteraction,
  UNKNOWN_INTERACTION,
} from '../src/utils/ack.js';

// Minimal stand-in for a discord.js component interaction: only the bits the
// ack helpers touch, plus a log of which defer was called.
/**
 * @param {{ deferImpl?: (kind: string) => unknown, deferred?: boolean, replied?: boolean }} opts
 */
function makeInteraction({ deferImpl, deferred = false, replied = false } = {}) {
  const calls = [];
  const record = (kind) => async () => {
    calls.push(kind);
    if (deferImpl) return deferImpl(kind);
  };
  return {
    calls,
    guildId: 'guild-1',
    customId: 'bday:confirm:7:29:americas',
    user: { id: 'user-1' },
    createdTimestamp: Date.now(),
    deferred,
    replied,
    deferUpdate: record('deferUpdate'),
    deferReply: record('deferReply'),
  };
}

// A DiscordAPIError-like object carries a numeric `code`.
function apiError(code, message = 'api error') {
  return Object.assign(new Error(message), { code });
}

test('ackUpdate defers in place and reports success', async () => {
  const interaction = makeInteraction();
  assert.equal(await ackUpdate(interaction), true);
  assert.deepEqual(interaction.calls, ['deferUpdate']);
});

test('ackReply defers with a fresh ephemeral', async () => {
  const interaction = makeInteraction();
  assert.equal(await ackReply(interaction), true);
  assert.deepEqual(interaction.calls, ['deferReply']);
});

test('is a no-op once the interaction is already acknowledged', async () => {
  const deferredAlready = makeInteraction({ deferred: true });
  assert.equal(await ackUpdate(deferredAlready), true);
  assert.deepEqual(deferredAlready.calls, []);

  const repliedAlready = makeInteraction({ replied: true });
  assert.equal(await ackReply(repliedAlready), true);
  assert.deepEqual(repliedAlready.calls, []);
});

test('reports failure instead of throwing when the token is already dead', async () => {
  const interaction = makeInteraction({
    deferImpl: () => {
      throw apiError(UNKNOWN_INTERACTION, 'Unknown interaction');
    },
  });
  assert.equal(await ackUpdate(interaction), false);
});

test('rethrows anything that is not an expired token', async () => {
  const interaction = makeInteraction({
    deferImpl: () => {
      throw apiError(50013, 'Missing Permissions');
    },
  });
  await assert.rejects(() => ackUpdate(interaction), /Missing Permissions/);
});

test('isUnknownInteraction only matches 10062', () => {
  assert.equal(isUnknownInteraction(apiError(UNKNOWN_INTERACTION)), true);
  assert.equal(isUnknownInteraction(apiError(10008)), false);
  assert.equal(isUnknownInteraction(new Error('boom')), false);
  assert.equal(isUnknownInteraction(null), false);
});
