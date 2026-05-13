import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { handleInteraction } from './interactions.js';
import { handleCommand } from './commands.js';
import { startScheduler } from './scheduler.js';
import { runStartupHealthCheck } from './healthcheck.js';
import { ensureBirthdayClubChannel } from './onboarding.js';
import { installAlertNotifier } from './alerts.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

client.once(Events.ClientReady, async (c) => {
  logger.info('discord_ready', { tag: c.user.tag, id: c.user.id });
  installAlertNotifier(c);
  startScheduler(client);
  runStartupHealthCheck(client).catch((err) =>
    logger.error('Startup health check failed', { error: err })
  );
  // Back-fill: ensure every guild we're already in has a Birthday Club channel.
  for (const [, guild] of c.guilds.cache) {
    ensureBirthdayClubChannel(guild).catch((err) =>
      logger.error('Onboarding back-fill failed', { guild_id: guild.id, error: err })
    );
  }
});

client.on(Events.GuildCreate, async (guild) => {
  // Events.GuildCreate fires twice in a bot's lifetime per guild:
  //   (a) during initial gateway hydration on every startup — client.isReady()
  //       is FALSE here. The ClientReady back-fill loop will handle these, so
  //       skipping avoids racing with the back-fill and creating duplicate
  //       Birthday Club channels.
  //   (b) when the bot is actually added to a new server — client.isReady()
  //       is TRUE. Onboard immediately.
  if (!client.isReady()) {
    logger.info('guild_create_hydration_skip', { guild_id: guild.id, name: guild.name });
    return;
  }
  logger.info('guild_create', { guild_id: guild.id, name: guild.name });
  await ensureBirthdayClubChannel(guild);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    return handleCommand(interaction);
  }
  if (
    interaction.isButton() ||
    interaction.isStringSelectMenu() ||
    interaction.isChannelSelectMenu() ||
    interaction.isRoleSelectMenu()
  ) {
    return handleInteraction(interaction);
  }
});

// Crash recovery: keep the process alive so cron schedule + persisted DB
// continue to function. Errors are logged structurally and added to the
// in-memory error buffer for the admin debug panel.
process.on('unhandledRejection', (err) => logger.error('unhandledRejection', { error: err }));
process.on('uncaughtException', (err) => logger.error('uncaughtException', { error: err }));

client.login(config.discord.token).catch((err) => {
  logger.error('Failed to log in', { error: err });
  process.exit(1);
});
