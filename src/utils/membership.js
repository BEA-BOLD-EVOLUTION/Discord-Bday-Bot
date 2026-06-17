import { logger } from '../logger.js';

// Discord API error code returned when a user is genuinely not a member of
// the guild (left, kicked, or never joined). Anything else thrown by
// members.fetch — rate limits (429), gateway/5xx, network blips — is a
// transient failure where membership is simply unknown.
// https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
export const UNKNOWN_MEMBER = 10007;

/**
 * Fetch a guild member while distinguishing "definitely gone" from a
 * transient failure. The plain `guild.members.fetch(id).catch(() => null)`
 * pattern collapses both into `null`, which means a single rate-limit or 5xx
 * on someone's actual birthday silently drops their announcement with no
 * same-day retry (the scheduler only runs once per region per day).
 *
 * @returns {Promise<{ member: import('discord.js').GuildMember | null, gone: boolean }>}
 *   - `{ member, gone: false }` — resolved member.
 *   - `{ member: null, gone: true }` — Discord confirmed the user is not a member.
 *   - `{ member: null, gone: false }` — transient error; membership unknown.
 */
export async function fetchMemberSafe(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    return { member, gone: false };
  } catch (err) {
    if (err?.code === UNKNOWN_MEMBER) {
      return { member: null, gone: true };
    }
    logger.warn('member_fetch_transient_error', {
      guild_id: guild.id,
      user_id: userId,
      error: err,
    });
    return { member: null, gone: false };
  }
}
