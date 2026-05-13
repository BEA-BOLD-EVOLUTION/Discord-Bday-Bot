import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { buildPanelMessage } from './ui.js';
import { getGuildSettings, updateGuildSettings } from './db.js';
import { logger } from './logger.js';

const DEFAULT_CHANNEL_NAME = 'birthday-club';
const DEFAULT_CHANNEL_TOPIC =
  '🎂 Click a button below to save your birthday. We only store month + day — never your year or age.';

// Idempotently ensure the guild has a Birthday Club collection channel with
// the public panel posted in it. Safe to call:
//   - on GuildCreate (bot newly added to a server)
//   - on startup for every guild already in cache (back-fill)
//   - manually
//
// Logic:
//   1. If guild_settings.collection_channel_id exists AND that channel still
//      exists in Discord, do nothing.
//   2. Otherwise look for an existing text channel literally named
//      "birthday-club" (or DEFAULT_CHANNEL_NAME) and reuse it.
//   3. Otherwise create one (requires Manage Channels). If we can't create
//      it (no perms), log and bail — admins can still run /birthday-panel
//      manually in a channel of their choosing.
//   4. Post the panel in the channel and persist its id.
export async function ensureBirthdayClubChannel(guild) {
  try {
    const settings = await getGuildSettings(guild.id);

    // 1. Already configured & channel still exists?
    if (settings?.collection_channel_id) {
      const existing = guild.channels.cache.get(settings.collection_channel_id)
        ?? (await guild.channels.fetch(settings.collection_channel_id).catch(() => null));
      if (existing) {
        logger.info('birthday_club_channel_present', {
          guild_id: guild.id,
          channel_id: existing.id,
        });
        return existing;
      }
      // configured channel is gone — fall through and re-provision
    }

    // 2. Reuse an existing channel literally named "birthday-club".
    let channel = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === DEFAULT_CHANNEL_NAME
    );

    // 3. Otherwise create one.
    if (!channel) {
      const me = guild.members.me;
      if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        logger.error('Cannot auto-create Birthday Club channel: missing Manage Channels', {
          guild_id: guild.id,
        });
        return null;
      }
      try {
        channel = await guild.channels.create({
          name: DEFAULT_CHANNEL_NAME,
          type: ChannelType.GuildText,
          topic: DEFAULT_CHANNEL_TOPIC,
          reason: 'Birthday Bot onboarding: created Birthday Club channel',
        });
        logger.info('birthday_club_channel_created', {
          guild_id: guild.id,
          channel_id: channel.id,
        });
      } catch (err) {
        logger.error('Failed to create Birthday Club channel', {
          guild_id: guild.id,
          error: err,
        });
        return null;
      }
    }

    // 4. Post the panel & persist.
    try {
      await channel.send(buildPanelMessage());
    } catch (err) {
      logger.error('Failed to post panel in Birthday Club channel', {
        guild_id: guild.id,
        channel_id: channel.id,
        error: err,
      });
      // still persist so admins know which channel was chosen
    }

    await updateGuildSettings(guild.id, { collection_channel_id: channel.id });
    return channel;
  } catch (err) {
    logger.error('ensureBirthdayClubChannel failed', { guild_id: guild.id, error: err });
    return null;
  }
}
