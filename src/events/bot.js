const { Events } = require('discord.js');
const {
  configEncryptionKey,
  guildConfigPath,
  token,
} = require('../config/env');
const { createDiscordClient } = require('../discord/client');
const { GuildConfigStore } = require('../storage/guildConfigStore');
const { parseEncryptionKey } = require('../storage/crypto');
const { assertSupportedNodeVersion } = require('../config/runtime');
const { createGuildCreateHandler } = require('./guildCreate');
const { createGuildDeleteHandler } = require('./guildDelete');
const { createChannelDeleteHandler } = require('./channelDelete');
const { handleReady } = require('./ready');
const { createMessageCreateHandler } = require('./messageCreate');
const { createInteractionCreateHandler } = require('./interactionCreate');

const client = createDiscordClient();
const guildConfigStore = new GuildConfigStore({
  filePath: guildConfigPath,
  encryptionKey: configEncryptionKey,
});
const wiredClients = new WeakSet();

function logEventFailure(operation, error) {
  console.error(operation, {
    name: error?.name,
    message: error?.message,
  });
}

function wireBotEvents(discordClient = client, dependencies = {}) {
  if (wiredClients.has(discordClient)) return discordClient;
  wiredClients.add(discordClient);
  const store = dependencies.store ?? guildConfigStore;
  discordClient.once(Events.ClientReady, (readyClient) => {
    handleReady(readyClient, store).catch((error) => logEventFailure('Ready handler failed.', error));
  });
  discordClient.on(Events.GuildCreate, createGuildCreateHandler(store));
  discordClient.on(Events.GuildDelete, createGuildDeleteHandler(store));
  discordClient.on(Events.ChannelDelete, createChannelDeleteHandler());
  discordClient.on(
    Events.MessageCreate,
    createMessageCreateHandler(discordClient, store, dependencies),
  );
  discordClient.on(
    Events.InteractionCreate,
    createInteractionCreateHandler(store, dependencies),
  );
  return discordClient;
}

wireBotEvents(client);

async function startBot() {
  if (!token) {
    throw new Error('Missing DISCORD_TOKEN in your environment.');
  }
  assertSupportedNodeVersion();

  // Fail before connecting if the host cannot safely encrypt guild API keys.
  parseEncryptionKey(configEncryptionKey);
  await guildConfigStore.validateStoredApiKeys();

  return client.login(token);
}

module.exports = {
  client,
  guildConfigStore,
  startBot,
  wireBotEvents,
};
