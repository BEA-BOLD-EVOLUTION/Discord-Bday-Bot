import { pathToFileURL } from 'node:url';
import { REST, Routes } from 'discord.js';
import { config } from '../config.js';
import { commandDefinitions } from '../commands.js';
import { logger } from '../logger.js';

export async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const route = config.discord.devGuildId
    ? Routes.applicationGuildCommands(config.discord.clientId, config.discord.devGuildId)
    : Routes.applicationCommands(config.discord.clientId);

  logger.info(
    `Registering ${commandDefinitions.length} command(s) ${
      config.discord.devGuildId ? `to guild ${config.discord.devGuildId}` : 'globally'
    }...`
  );
  await rest.put(route, { body: commandDefinitions });
  logger.info('✅ Commands registered.');
}

// Run as a CLI script (`npm run register`), but stay importable from index.js.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  registerCommands().catch((err) => {
    logger.error('Command registration failed', { error: err });
    process.exit(1);
  });
}
