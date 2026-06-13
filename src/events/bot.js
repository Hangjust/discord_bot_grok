const { Events } = require('discord.js');
const { token } = require('../config/env');
const { createDiscordClient } = require('../discord/client');
const { handleReady } = require('./ready');
const { createMessageCreateHandler } = require('./messageCreate');
const { createInteractionCreateHandler } = require('./interactionCreate');

const client = createDiscordClient();

function wireBotEvents(discordClient = client) {
  discordClient.once(Events.ClientReady, handleReady);
  discordClient.on(Events.MessageCreate, createMessageCreateHandler(discordClient));
  discordClient.on(Events.InteractionCreate, createInteractionCreateHandler(discordClient));
  return discordClient;
}

wireBotEvents(client);

function startBot() {
  if (!token) {
    throw new Error('Missing DISCORD_TOKEN in your environment.');
  }

  return client.login(token);
}

module.exports = {
  client,
  startBot,
  wireBotEvents,
};
