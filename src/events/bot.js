const { Events } = require('discord.js');
const {
  guildConfigMasterKey,
  deepSeekBaseUrl,
  deepSeekTimeoutMs,
  guildConfigMasterKeyId,
  guildConfigPath,
  token,
} = require('../config/env');
const { createAccessPolicy } = require('../discord/accessPolicy');
const { createDiscordClient } = require('../discord/client');
const { createSecretCipher } = require('../security/secretCipher');
const { createCredentialValidators } = require('../services/credentialValidators');
const { createGuildConfigService } = require('../services/guildConfigService');
const { createRequestGate } = require('../services/requestGate');
const { createGuildConfigStore } = require('../storage/guildConfigStore');
const { createInteractionCreateHandler } = require('./interactionCreate');
const { createMessageCreateHandler } = require('./messageCreate');
const { createGuildCreateHandler, createReadyHandler } = require('./ready');

const client = createDiscordClient();
const wiredClients = new WeakSet();

function createBotDependencies(options = {}) {
  let guildConfigService = options.guildConfigService;

  if (!guildConfigService) {
    const store = options.store || createGuildConfigStore({
      filePath: options.guildConfigPath || guildConfigPath,
    });
    const cipher = options.cipher || createSecretCipher({
      masterKey: options.guildConfigMasterKey || guildConfigMasterKey,
      keyId: options.guildConfigMasterKeyId || guildConfigMasterKeyId,
    });
    guildConfigService = createGuildConfigService({
      store,
      cipher,
      env: options.env || process.env,
    });
  }

  const accessPolicy = options.accessPolicy || createAccessPolicy({ guildConfigService });
  const credentialValidators = options.credentialValidators || createCredentialValidators({
    fetchImpl: options.fetchImpl,
    deepseekBaseUrl: options.deepSeekBaseUrl || deepSeekBaseUrl,
    deepseekTimeoutMs: options.deepSeekTimeoutMs || deepSeekTimeoutMs,
  });
  const requestGate = options.requestGate || createRequestGate({
    env: options.env || process.env,
    maxConcurrentPerGuild: options.deepSeekMaxConcurrentPerGuild,
    maxRequestsPerGuildPerMinute: options.deepSeekMaxRequestsPerGuildPerMinute,
    maxRequestsPerUserPerMinute: options.deepSeekMaxRequestsPerUserPerMinute,
  });

  return Object.freeze({
    accessPolicy,
    credentialValidators,
    fetchImpl: options.fetchImpl,
    guildConfigService,
    logger: options.logger,
    requestGate,
  });
}

function wireBotEvents(discordClient = client, dependencies = createBotDependencies()) {
  if (wiredClients.has(discordClient)) {
    return discordClient;
  }

  discordClient.once(Events.ClientReady, createReadyHandler(dependencies));
  discordClient.on(Events.GuildCreate, createGuildCreateHandler(dependencies));
  discordClient.on(Events.MessageCreate, createMessageCreateHandler(discordClient, dependencies));
  discordClient.on(Events.InteractionCreate, createInteractionCreateHandler(discordClient, dependencies));
  wiredClients.add(discordClient);
  return discordClient;
}

function startBot() {
  if (!token) {
    throw new Error('Missing DISCORD_TOKEN in your environment.');
  }

  wireBotEvents(client);
  return client.login(token);
}

module.exports = {
  client,
  createBotDependencies,
  startBot,
  wireBotEvents,
};
