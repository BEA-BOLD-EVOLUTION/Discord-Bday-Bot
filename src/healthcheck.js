import { logger } from './logger.js';
import { pingDatabase, getGuildSettings } from './db.js';
import { inspectBotPermissions } from './utils/permissions.js';
import { getNextRunsByRegion } from './scheduler.js';

// Runs once after the client is ready. Verifies bot login, database tables,
// scheduler configuration, and per-guild channel/role configuration.
// Surfaces problems through the structured logger so they are visible in
// JSON logs and the in-memory error buffer (admin debug panel).
export async function runStartupHealthCheck(client) {
  const startedAt = Date.now();

  // ClientReady can occasionally fire before GUILD_CREATE events finish
  // hydrating the cache (we saw guilds:0 in a real boot). Wait up to 10s
  // for at least one guild before running the per-guild checks.
  if (client.guilds.cache.size === 0) {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (client.guilds.cache.size > 0) break;
    }
  }
  logger.info('startup_health_check_begin', { user: client.user?.tag, guilds: client.guilds.cache.size });

  // ---- Discord login ----
  if (!client.user) {
    logger.error('Discord login appears to have failed (client.user missing)');
    return;
  }
  logger.info('discord_login_ok', { tag: client.user.tag, id: client.user.id });

  // ---- Required env / config ----
  const requiredEnv = ['DISCORD_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length) {
    logger.error('Missing required env vars', { missing });
  } else {
    logger.info('env_vars_ok', { checked: requiredEnv });
  }

  // ---- Database tables ----
  try {
    const dbStatus = await pingDatabase();
    const failed = Object.entries(dbStatus).filter(([, v]) => v !== 'ok');
    if (failed.length) {
      logger.error('Database tables not all reachable', { dbStatus });
    } else {
      logger.info('database_ok', { tables: Object.keys(dbStatus) });
    }
  } catch (err) {
    logger.error('Database ping failed', { error: err });
  }

  // ---- Scheduler ----
  try {
    const nextByRegion = getNextRunsByRegion();
    const broken = Object.entries(nextByRegion).filter(([, v]) => !v).map(([k]) => k);
    if (broken.length) {
      logger.error('Regional scheduler cron(s) invalid', { broken });
    } else {
      logger.info('scheduler_ok', { next_runs: nextByRegion });
    }
  } catch (err) {
    logger.error('Scheduler check failed', { error: err });
  }

  // ---- Per-guild channels & role checks ----
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      // One-shot diagnostic: dump exactly what perms our role actually has,
      // so we can stop theorizing about "Manage Roles vs Manage Channels".
      const me = guild.members.me;
      if (me) {
        const perms = me.permissions;
        const friendly = Object.entries({
          Administrator: 1n << 3n,
          ManageGuild: 1n << 5n,
          ManageRoles: 1n << 28n,
          ManageChannels: 1n << 4n,
          ViewChannel: 1n << 10n,
          SendMessages: 1n << 11n,
          EmbedLinks: 1n << 14n,
          ReadMessageHistory: 1n << 16n,
          CreatePublicThreads: 1n << 34n,
          SendMessagesInThreads: 1n << 38n,
        })
          .filter(([, bit]) => (perms.bitfield & bit) === bit)
          .map(([name]) => name);
        logger.info('bot_role_perms_dump', {
          guild_id: guildId,
          bitfield: perms.bitfield.toString(),
          has: friendly,
          highest_role: me.roles.highest?.name,
          highest_role_position: me.roles.highest?.position,
        });
      }

      const settings = await getGuildSettings(guildId);
      if (!settings) {
        logger.warn('guild_unconfigured', { guild_id: guildId, name: guild.name });
        continue;
      }
      const checks = await inspectBotPermissions(guild, settings);
      const failed = checks.filter((c) => !c.ok);
      if (failed.length) {
        logger.warn('guild_health_issues', {
          guild_id: guildId,
          name: guild.name,
          issues: failed.map((f) => `${f.check}: ${f.detail}`),
        });
        await reportToErrorChannel(guild, settings, failed);
      } else {
        logger.info('guild_health_ok', { guild_id: guildId, name: guild.name });
      }
    } catch (err) {
      logger.error('Guild health check failed', { guild_id: guildId, error: err });
    }
  }

  logger.info('startup_health_check_complete', { duration_ms: Date.now() - startedAt });
}

async function reportToErrorChannel(guild, settings, failed) {
  if (!settings?.error_log_channel_id) return;
  try {
    const channel = await guild.channels.fetch(settings.error_log_channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) return;
    const lines = [
      `**[STARTUP] Health check warnings for ${guild.name}**`,
      `\`${new Date().toISOString()}\``,
      ...failed.map((f) => `\u274c ${f.check} \u2014 ${f.detail || 'failing'}`),
    ];
    await channel.send({ content: lines.join('\n'), allowedMentions: { parse: [] } });
  } catch {
    // ignore
  }
}
