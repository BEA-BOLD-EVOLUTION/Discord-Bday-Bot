import { REST, Routes } from 'discord.js';
import { config } from '../config.js';
import { commandDefinitions } from '../commands.js';
import { logger } from '../logger.js';

const rest = new REST({ version: '10' }).setToken(config.discord.token);

async function main() {
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

main().catch((err) => {
  logger.error('Command registration failed', { error: err });
  process.exit(1);
});
