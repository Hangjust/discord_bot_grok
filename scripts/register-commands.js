require('dotenv').config();

const { REST, Routes } = require('discord.js');
const {
  discordApplicationId,
  token,
} = require('../src/config/env');
const { commandDefinitions } = require('../src/interactions/commandDefinitions');
const { upsertOwnedCommandsWithRest } = require('../src/interactions/registerCommands');

async function registerCommands(options = {}) {
  const registrationToken = options.token ?? token;
  const applicationId = options.discordApplicationId ?? discordApplicationId;

  if (!registrationToken) {
    throw new Error('DISCORD_TOKEN is required to register commands.');
  }

  if (!/^\d+$/.test(applicationId)) {
    throw new Error('DISCORD_APPLICATION_ID must be set to the numeric application ID.');
  }

  const rest = options.rest || new REST({ version: '10' }).setToken(registrationToken);
  const route = Routes.applicationCommands(applicationId);

  await upsertOwnedCommandsWithRest(rest, route);

  const logger = options.logger || console;
  logger.log(`Registered ${commandDefinitions.length} command definition(s) globally without replacing unrelated commands.`);
}

if (require.main === module) {
  registerCommands().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  registerCommands,
};
