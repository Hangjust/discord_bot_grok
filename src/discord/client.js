const { Client, GatewayIntentBits } = require('discord.js');
const { blockedAllowedMentions } = require('../config/constants');

function createDiscordClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    allowedMentions: blockedAllowedMentions,
  });
}

module.exports = {
  createDiscordClient,
};
