const { Client, GatewayIntentBits, Options } = require('discord.js');
const { blockedAllowedMentions } = require('../config/constants');

const discordCacheLimits = Object.freeze({
  messagesPerChannel: 20,
  membersPerGuild: 250,
  users: 1000,
});

const discordMessageSweeper = Object.freeze({
  interval: 5 * 60,
  lifetime: 10 * 60,
});

function createDiscordClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    allowedMentions: blockedAllowedMentions,
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: discordCacheLimits.messagesPerChannel,
      GuildMemberManager: {
        maxSize: discordCacheLimits.membersPerGuild,
        keepOverLimit: (member) => member.id === member.client.user?.id,
      },
      UserManager: {
        maxSize: discordCacheLimits.users,
        keepOverLimit: (user) => user.id === user.client.user?.id,
      },
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: discordMessageSweeper,
    },
  });
}

module.exports = {
  createDiscordClient,
  discordCacheLimits,
  discordMessageSweeper,
};
