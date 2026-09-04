import { MessageFlags } from 'discord.js';
import { logger } from '../logger.js';

// Discord invalidates an interaction token 3 seconds after it is created. Any
// handler that talks to Supabase or the Discord REST API before responding is
// racing that clock: one slow round-trip (a cold PostgREST connection is
// enough) burns the whole budget, and the eventual reply fails with 10062 —
// so the user is told the action failed even when the write succeeded.
//
// The fix is ordering, not speed: acknowledge first, then do the work, then
// edit the acknowledgement into the real response. Acknowledging extends the
// window to 15 minutes.
export const UNKNOWN_INTERACTION = 10062;

export function isUnknownInteraction(err) {
  return err?.code === UNKNOWN_INTERACTION;
}

// How much of the 3s budget was already gone when we started handling this.
export function interactionAgeMs(interaction) {
  return Date.now() - interaction.createdTimestamp;
}

async function ack(interaction, defer) {
  // Idempotent: a nested handler can call this without knowing whether an
  // outer one already acknowledged.
  if (interaction.deferred || interaction.replied) return true;
  const startedAt = Date.now();
  try {
    await defer();
  } catch (err) {
    if (isUnknownInteraction(err)) {
      // The token was already dead before we got here, which means 3s+ of
      // gateway or event-loop lag. Nothing can be delivered to the user, so
      // the caller must bail out rather than keep working on a dead token.
      logger.info('interaction_expired_before_ack', {
        guild_id: interaction.guildId,
        user_id: interaction.user?.id,
        custom_id: interaction.customId,
        age_ms: interactionAgeMs(interaction),
      });
      return false;
    }
    throw err;
  }
  logger.debug('interaction_acked', {
    custom_id: interaction.customId,
    age_ms: interactionAgeMs(interaction),
    ack_ms: Date.now() - startedAt,
  });
  return true;
}

// Acknowledge while leaving the source message on screen. Follow up with
// interaction.editReply() to replace that message, or interaction.followUp()
// to send a separate ephemeral alongside it.
export function ackUpdate(interaction) {
  return ack(interaction, () => interaction.deferUpdate());
}

// Acknowledge with a fresh ephemeral placeholder, leaving the source message
// untouched. Follow up with interaction.editReply().
export function ackReply(interaction) {
  return ack(interaction, () => interaction.deferReply({ flags: MessageFlags.Ephemeral }));
}
