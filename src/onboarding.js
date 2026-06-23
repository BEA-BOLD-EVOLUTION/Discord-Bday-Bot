import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { buildPanelMessage, buildSetupPendingMessage, SETUP_PENDING_MARKER } from './ui.js';
import { getGuildSettings, updateGuildSettings } from './db.js';
import { logger } from './logger.js';

const DEFAULT_CHANNEL_NAME = 'birthday-club';
const DEFAULT_CHANNEL_TOPIC =
  '🎂 Click a button below to save your birthday. We only store month + day — never your year or age.';
const DEFAULT_BIRTHDAY_ROLE_NAME = '🎂 Birthday';
const DEFAULT_BIRTHDAY_ROLE_COLOR = 0xff7ab6; // pink

// Permission bits the bot must have on the collection channel in order to
// post and maintain the panel + horoscope threads.
const REQUIRED_BOT_CHANNEL_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.SendMessagesInThreads,
];

// Reduced perm set for read-only-ish channels (audit, alert). Bot needs to be
// able to see and write to them, but doesn't need thread perms.
const REQUIRED_BOT_LOG_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
];

// Ensure the bot has the perms it needs on this channel. If a channel-level
// override (or category inheritance) is blocking us, add an explicit allow
// overwrite for the bot's own member. Requires ManageChannels on the bot's
// role; if we don't have it, we log and bail so the caller can degrade
// gracefully.
async function ensureBotCanPost(channel, required = REQUIRED_BOT_CHANNEL_PERMS) {
  const me = channel.guild.members.me;
  if (!me) return { ok: false, reason: 'no_member', channel };
  const current = channel.permissionsFor(me);
  const missing = required.filter((p) => !current?.has(p));
  if (missing.length === 0) return { ok: true, channel };

  // Discord requires Manage Roles on the channel to edit permission
  // overwrites (NOT Manage Channels — that controls renaming/topic/etc).
  // Plus the API enforces "you can only grant permissions you yourself
  // have" so we also need every perm we're trying to add.
  const canManage = current?.has(PermissionFlagsBits.ManageRoles);
  const canGrantEachMissing = missing.every((p) => current?.has(p));
  if (!canManage || !canGrantEachMissing) {
    logger.warn('channel_perms_self_heal_blocked', {
      guild_id: channel.guild.id,
      channel_id: channel.id,
      channel_name: channel.name,
      has_manage_roles: !!canManage,
      missing: missing.map(permLabel),
      bot_effective_perms_bitfield: current?.bitfield?.toString(),
      bot_role_perms_bitfield: me.permissions?.bitfield?.toString(),
    });
    return {
      ok: false,
      reason: canManage ? 'cant_grant_unheld' : 'no_manage_roles',
      missing,
      channel,
    };
  }
  try {
    await channel.permissionOverwrites.edit(
      me.id,
      Object.fromEntries(required.map((p) => [p, true])),
      { reason: 'OrbitDay onboarding: grant self perms' }
    );
    logger.info('channel_perms_granted', {
      guild_id: channel.guild.id,
      channel_id: channel.id,
      granted: required.map((p) => permLabel(p)),
    });
    return { ok: true, channel };
  } catch (err) {
    return {
      ok: false,
      reason: err?.code === 50001 ? 'no_view' : 'api_error',
      code: err?.code,
      missing,
      channel,
    };
  }
}

// Keys are stringified because PermissionFlagsBits values are BigInts, which
// can't be used as computed object-literal keys under tsc --checkJs (they get
// coerced to strings at runtime anyway).
const PERM_LABELS = {
  [String(PermissionFlagsBits.ViewChannel)]: 'View Channel',
  [String(PermissionFlagsBits.SendMessages)]: 'Send Messages',
  [String(PermissionFlagsBits.EmbedLinks)]: 'Embed Links',
  [String(PermissionFlagsBits.ReadMessageHistory)]: 'Read Message History',
  [String(PermissionFlagsBits.CreatePublicThreads)]: 'Create Public Threads',
  [String(PermissionFlagsBits.SendMessagesInThreads)]: 'Send Messages in Threads',
  [String(PermissionFlagsBits.ManageChannels)]: 'Manage Channels',
};
function permLabel(p) {
  return PERM_LABELS[String(p)] || String(p);
}

// In-process cache so we DM the owner at most once per process per guild.
const ownerNotified = new Set();
async function notifyOwnerOfPermIssues(guild, problems) {
  if (ownerNotified.has(guild.id)) return;
  ownerNotified.add(guild.id);
  try {
    const owner = await guild.fetchOwner().catch(() => null);
    if (!owner) return;
    const lines = problems.map((p) => {
      const chRef = p.channel?.id ? `<#${p.channel.id}>` : '(missing channel)';
      const missing = (p.missing || []).map(permLabel).join(', ') || 'view access';
      const why =
        p.reason === 'no_view'
          ? "I can't even see this channel"
          : p.reason === 'no_manage'
            ? 'I lack Manage Channel here (a category or channel override is blocking me)'
            : `Discord rejected my edit (code ${p.code ?? '?'})`;
      return `• **${p.slot}** → ${chRef}\n   missing: ${missing}\n   reason: ${why}`;
    });
    const msg =
      `Hi! I'm **OrbitDay** running in **${guild.name}**. I tried to fix my own channel permissions but couldn't:\n\n` +
      lines.join('\n\n') +
      `\n\n**Fix:** open each channel → *Edit Channel* → *Permissions* → add my bot role and tick **View Channel**, **Send Messages**, **Embed Links**, **Read Message History** (plus **Create Public Threads** + **Send Messages in Threads** for the collection/announcement channels). Or simply give my role **Manage Channels** at the server level with no channel-level deny overrides.\n\nOnce that's done, I'll auto-heal everything else on my next restart.`;
    await owner.send(msg).catch(() => null);
    logger.info('owner_perm_dm_sent', {
      guild_id: guild.id,
      owner_id: owner.id,
      problems: problems.length,
    });
  } catch (err) {
    logger.warn('owner_perm_dm_failed', { guild_id: guild.id, error: err?.message });
  }
}

// Walk every configured channel for this guild and self-grant any missing
// perms. Called on startup back-fill and on GuildCreate so admins never
// have to manually fix channel overrides after configuring a channel.
// When a channel is unfixable by the bot (Discord denies us Manage Channel
// or View), DM the guild owner with the precise repair list.
export async function ensureBotPermsOnConfiguredChannels(guild) {
  try {
    const settings = await getGuildSettings(guild.id);
    if (!settings) return;
    const targets = [
      [settings.collection_channel_id, REQUIRED_BOT_CHANNEL_PERMS, 'collection'],
      [settings.announcement_channel_id, REQUIRED_BOT_CHANNEL_PERMS, 'announcement'],
      [settings.audit_channel_id, REQUIRED_BOT_LOG_PERMS, 'audit'],
      [settings.error_log_channel_id, REQUIRED_BOT_LOG_PERMS, 'error_log'],
    ];
    const problems = [];
    for (const [id, required, slot] of targets) {
      if (!id) continue;
      const ch = await guild.channels.fetch(id).catch(() => null);
      if (!ch?.isTextBased?.()) {
        problems.push({ reason: 'no_view', missing: required, channel: { id }, slot });
        continue;
      }
      const result = await ensureBotCanPost(ch, required);
      if (!result.ok) {
        logger.warn('channel_perms_unfixable', {
          guild_id: guild.id,
          channel_id: ch.id,
          slot,
          reason: result.reason,
          missing: result.missing?.map((p) => permLabel(p)),
          code: result.code,
        });
        problems.push({ ...result, slot });
      }
    }
    if (problems.length) {
      await notifyOwnerOfPermIssues(guild, problems);
    }
  } catch (err) {
    logger.warn('ensureBotPermsOnConfiguredChannels failed', {
      guild_id: guild.id,
      error: err?.message,
    });
  }
}

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
      const existing =
        guild.channels.cache.get(settings.collection_channel_id) ??
        (await guild.channels.fetch(settings.collection_channel_id).catch(() => null));
      if (existing) {
        logger.info('birthday_club_channel_present', {
          guild_id: guild.id,
          channel_id: existing.id,
        });
        // Self-heal perms in case a category/role override was added after
        // the channel was first configured.
        await ensureBotCanPost(existing).catch(() => {});
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
          // Explicit allow for the bot so category/@everyone denies can't
          // silently lock us out of our own channel.
          permissionOverwrites: me
            ? [
                {
                  id: me.id,
                  allow: REQUIRED_BOT_CHANNEL_PERMS,
                },
              ]
            : undefined,
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

    // 4. Post a message in the channel. Two possible messages:
    //    - If announcement_channel_id is NOT yet configured, post a
    //      setup-pending admin notice (no interactive buttons). Posting
    //      the real collection panel here would let users save birthdays
    //      that have nowhere to be announced.
    //    - Once announcement_channel_id IS configured, post the real
    //      panel (this path runs again after /birthday-config saves).
    //    Either message counts as "already posted" — we never spam on
    //    restart.
    const isConfigured = Boolean(settings?.announcement_channel_id);
    let shouldPost = created;
    if (!shouldPost) {
      try {
        const recent = await channel.messages.fetch({ limit: 50 });
        const selfId = guild.client.user.id;
        const alreadyPosted = recent.some((m) => {
          if (m.author?.id !== selfId) return false;
          const hasComponents = Array.isArray(m.components) && m.components.length > 0;
          const isSetupPending = m.embeds?.some((e) => e?.footer?.text === SETUP_PENDING_MARKER);
          return hasComponents || isSetupPending;
        });
        shouldPost = !alreadyPosted;
      } catch (err) {
        logger.error('Failed to check existing panel messages', {
          guild_id: guild.id,
          channel_id: channel.id,
          error: err,
        });
        // Be conservative — don't re-post if we can't tell.
        shouldPost = false;
      }
    }
    // Make sure the bot can post here — adds a self-overwrite if a pre-existing
    // channel was adopted (case 2) and its perms don't allow us. No-op on
    // freshly created channels because we already set the overwrite at create.
    await ensureBotCanPost(channel).catch(() => {});

    if (shouldPost) {
      try {
        const payload = isConfigured ? buildPanelMessage() : buildSetupPendingMessage();
        await channel.send(payload);
        logger.info(isConfigured ? 'birthday_panel_posted' : 'birthday_setup_notice_posted', {
          guild_id: guild.id,
          channel_id: channel.id,
        });
      } catch (err) {
        logger.error('Failed to post message in Birthday Club channel', {
          guild_id: guild.id,
          channel_id: channel.id,
          configured: isConfigured,
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

// Called from /birthday-config after the announcement channel is saved.
// Finds the setup-pending notice in the collection channel and replaces it
// with the real birthday panel. Idempotent: if a real panel is already
// posted, does nothing; if no setup-pending notice exists, just posts the
// panel.
export async function promoteSetupPendingToPanel(guild) {
  try {
    const settings = await getGuildSettings(guild.id);
    if (!settings?.announcement_channel_id) return; // not actually configured
    if (!settings?.collection_channel_id) return; // nothing to upgrade
    const channel =
      guild.channels.cache.get(settings.collection_channel_id) ??
      (await guild.channels.fetch(settings.collection_channel_id).catch(() => null));
    if (!channel) return;

    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!recent) return;
    const selfId = guild.client.user.id;
    const realPanel = recent.find(
      (m) => m.author?.id === selfId && Array.isArray(m.components) && m.components.length > 0
    );
    if (realPanel) return; // already promoted

    const pending = recent.find(
      (m) =>
        m.author?.id === selfId && m.embeds?.some((e) => e?.footer?.text === SETUP_PENDING_MARKER)
    );
    if (pending) {
      await pending.delete().catch((err) =>
        logger.error('Failed to delete setup-pending notice', {
          guild_id: guild.id,
          channel_id: channel.id,
          error: err,
        })
      );
    }
    await channel.send(buildPanelMessage());
    logger.info('birthday_panel_promoted', {
      guild_id: guild.id,
      channel_id: channel.id,
      replaced_pending: Boolean(pending),
    });
  } catch (err) {
    logger.error('promoteSetupPendingToPanel failed', { guild_id: guild.id, error: err });
  }
}

// Idempotently ensure the guild has a birthday role configured. Reuses an
// existing role by id (if still present) or by name; otherwise creates a new
// one and persists its id. Requires ManageRoles on the bot; logs and bails if
// missing so admins can set one manually via /birthday-config.
// Hoist the Birthday role so members carrying it show up in their own group in
// the member-list sidebar — without this it's nearly invisible. Best-effort:
// editing a role needs ManageRoles and the role to sit below the bot's highest
// role, so failures are logged at debug and otherwise ignored. Runs for every
// guild via the startup back-fill, so existing roles get hoisted too.
async function ensureRoleHoisted(role) {
  if (!role || role.hoist) return;
  try {
    await role.edit({ hoist: true }, 'Birthday Bot: show Birthday role in the member list');
    logger.info('birthday_role_hoisted', { guild_id: role.guild.id, role_id: role.id });
  } catch (err) {
    logger.debug('Could not hoist Birthday role; skipping', {
      guild_id: role.guild?.id,
      role_id: role.id,
      error: err,
    });
  }
}

const roleInflight = new Map();
export async function ensureBirthdayRole(guild) {
  const prior = roleInflight.get(guild.id);
  if (prior) return prior;
  const p = _ensureBirthdayRole(guild).finally(() => roleInflight.delete(guild.id));
  roleInflight.set(guild.id, p);
  return p;
}

async function _ensureBirthdayRole(guild) {
  try {
    const settings = await getGuildSettings(guild.id);

    // 1. Already configured & role still exists?
    if (settings?.birthday_role_id) {
      const existing =
        guild.roles.cache.get(settings.birthday_role_id) ??
        (await guild.roles.fetch(settings.birthday_role_id).catch(() => null));
      if (existing) {
        logger.info('birthday_role_present', { guild_id: guild.id, role_id: existing.id });
        await ensureRoleHoisted(existing);
        return existing;
      }
      // configured role is gone — fall through and re-provision
    }

    // 2. Reuse an existing role by name (case-insensitive, ignoring emoji).
    const normalize = (s) =>
      String(s ?? '')
        .toLowerCase()
        .replace(/[^a-z]+/g, '');
    const wanted = normalize(DEFAULT_BIRTHDAY_ROLE_NAME);
    const allRoles = await guild.roles.fetch().catch(() => null);
    let role = allRoles?.find((r) => normalize(r.name) === wanted) ?? null;

    // 3. Otherwise create one.
    if (!role) {
      const me = guild.members.me;
      if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        // The birthday role is optional; not having perms to create it isn't an
        // error worth alerting on. Skip quietly.
        logger.debug('Skipping Birthday role auto-create: missing Manage Roles', {
          guild_id: guild.id,
        });
        return null;
      }
      try {
        role = await guild.roles.create({
          name: DEFAULT_BIRTHDAY_ROLE_NAME,
          color: DEFAULT_BIRTHDAY_ROLE_COLOR,
          mentionable: true,
          hoist: true,
          reason: 'Birthday Bot onboarding: created Birthday role',
        });
        logger.info('birthday_role_created', { guild_id: guild.id, role_id: role.id });
      } catch (err) {
        logger.debug('Failed to create Birthday role; skipping', {
          guild_id: guild.id,
          error: err,
        });
        return null;
      }
    }

    await ensureRoleHoisted(role);
    await updateGuildSettings(guild.id, { birthday_role_id: role.id });
    return role;
  } catch (err) {
    logger.debug('ensureBirthdayRole failed; skipping', { guild_id: guild.id, error: err });
    return null;
  }
}
