import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { buildPanelMessage } from './ui.js';
import { getGuildSettings, updateGuildSettings } from './db.js';
import { logger } from './logger.js';

const DEFAULT_CHANNEL_NAME = 'birthday-club';
const DEFAULT_CHANNEL_TOPIC =
  '🎂 Click a button below to save your birthday. We only store month + day — never your year or age.';

// Per-guild in-process mutex. Concurrent invocations for the same guild
// (e.g. GuildCreate hydration + ClientReady back-fill firing in parallel)
// would otherwise both miss each other's create and produce duplicate
// "birthday-club" channels. Serialize them.
const inflight = new Map();

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
//      "birthday-club" (or DEFAULT_CHANNEL_NAME) and reuse it. We fetch from
//      the API rather than relying on the cache, because the cache may not
//      yet be populated during early gateway hydration.
//   3. Otherwise create one (requires Manage Channels). If we can't create
//      it (no perms), log and bail — admins can still run /birthday-panel
//      manually in a channel of their choosing.
//   4. Post the panel in the channel and persist its id.
export async function ensureBirthdayClubChannel(guild) {
  // Serialize per guild.
  const prior = inflight.get(guild.id);
  if (prior) return prior;
  const p = _ensureBirthdayClubChannel(guild).finally(() => {
    inflight.delete(guild.id);
  });
  inflight.set(guild.id, p);
  return p;
}

async function _ensureBirthdayClubChannel(guild) {
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
    //    Fetch from the API so we don't miss it when the cache is cold
    //    (e.g. during GuildCreate hydration on bot startup). If multiple
    //    duplicates already exist from earlier buggy runs, pick the OLDEST
    //    one deterministically so every replica converges on the same id
    //    and stops creating more.
    let channel = null;
    try {
      const all = await guild.channels.fetch();
      const matches = [...all.values()].filter(
        (c) => c && c.type === ChannelType.GuildText && c.name === DEFAULT_CHANNEL_NAME
      );
      if (matches.length > 1) {
        logger.error('birthday_club_channel_duplicates_detected', {
          guild_id: guild.id,
          count: matches.length,
          channel_ids: matches.map((c) => c.id),
        });
      }
      matches.sort((a, b) => {
        // Snowflake IDs are time-ordered; smaller = older.
        if (a.id.length !== b.id.length) return a.id.length - b.id.length;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      channel = matches[0] ?? null;
    } catch (err) {
      logger.error('Failed to fetch channels for reuse lookup', {
        guild_id: guild.id,
        error: err,
      });
    }

    // 3. Otherwise create one.
    const created = !channel;
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

    // 4. Post the panel ONLY if we just created the channel (or the channel
    //    has no messages yet). Otherwise reusing an existing channel would
    //    spam a fresh panel every bot restart.
    let shouldPostPanel = created;
    if (!shouldPostPanel) {
      try {
        const recent = await channel.messages.fetch({ limit: 50 });
        const selfId = guild.client.user.id;
        const alreadyPosted = recent.some(
          (m) => m.author?.id === selfId && Array.isArray(m.components) && m.components.length > 0
        );
        shouldPostPanel = !alreadyPosted;
      } catch (err) {
        logger.error('Failed to check existing panel messages', {
          guild_id: guild.id,
          channel_id: channel.id,
          error: err,
        });
        // Be conservative — don't re-post if we can't tell.
        shouldPostPanel = false;
      }
    }
    if (shouldPostPanel) {
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
    }

    await updateGuildSettings(guild.id, { collection_channel_id: channel.id });
    return channel;
  } catch (err) {
    logger.error('ensureBirthdayClubChannel failed', { guild_id: guild.id, error: err });
    return null;
  }
}
