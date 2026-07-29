const { PermissionFlagsBits } = require('discord.js');
const { setReadyPresence } = require('../discord/presence');
const { createSetupPanel } = require('../interactions/guildConfig');
const { startGuildIdleChatterTimers } = require('../state/idleChatter');
const { upsertOwnedCommands } = require('../interactions/registerCommands');

function canPostSetupPanel(channel, botMember) {
  if (!channel || typeof channel.send !== 'function' || (channel.isTextBased && !channel.isTextBased())) {
    return false;
  }

  const permissions = channel.permissionsFor?.(botMember);
  return Boolean(permissions
    && permissions.has(PermissionFlagsBits.ViewChannel)
    && permissions.has(PermissionFlagsBits.SendMessages));
}

function findSetupChannel(guild) {
  const botMember = guild.members?.me;

  if (canPostSetupPanel(guild.systemChannel, botMember)) {
    return guild.systemChannel;
  }

  const channels = guild.channels?.cache;

  if (!channels || typeof channels.values !== 'function') {
    return null;
  }

  return [...channels.values()].find((channel) => canPostSetupPanel(channel, botMember)) || null;
}

async function ensureGuildSetupPanel(guild, guildConfigService) {
  const status = await guildConfigService.getStatus(guild.id);

  if (status.configured || status.onboardingPanel.channelId || status.onboardingPanel.messageId) {
    return null;
  }

  const channel = findSetupChannel(guild);

  if (!channel) {
    return null;
  }

  const message = await channel.send(createSetupPanel());

  try {
    await guildConfigService.setOnboardingPanel(guild.id, channel.id, message.id);
  } catch (error) {
    await message.delete?.().catch(() => {});
    throw error;
  }

  return message;
}

async function ensureSetupPanels(readyClient, guildConfigService) {
  const guilds = readyClient.guilds?.cache;

  if (!guildConfigService || !guilds || typeof guilds.values !== 'function') {
    return [];
  }

  const results = [];

  for (const guild of guilds.values()) {
    try {
      results.push(await ensureGuildSetupPanel(guild, guildConfigService));
    } catch {
      console.error(`Unable to reconcile AI setup panel for guild ${guild.id}`);
      results.push(null);
    }
  }

  return results;
}

function createGuildCreateHandler(dependencies = {}) {
  const guildConfigService = dependencies.guildConfigService;

  return async function handleGuildCreate(guild) {
    if (!guildConfigService) {
      return null;
    }

    try {
      return await ensureGuildSetupPanel(guild, guildConfigService);
    } catch {
      console.error(`Unable to reconcile AI setup panel for guild ${guild.id}`);
      return null;
    }
  };
}

function createReadyHandler(dependencies = {}) {
  const accessPolicy = dependencies.accessPolicy;
  const guildConfigService = dependencies.guildConfigService;

  return async function handleReady(readyClient) {
    setReadyPresence(readyClient);

    const connectedApplicationId = String(readyClient.application?.id || '').trim();
    const configuredApplicationId = String(dependencies.discordApplicationId || '').trim();
    if (configuredApplicationId
      && connectedApplicationId
      && configuredApplicationId !== connectedApplicationId) {
      (dependencies.logger || console).error(
        `DISCORD_APPLICATION_ID does not match the application authenticated by DISCORD_TOKEN `
        + `(configured=${configuredApplicationId}, connected=${connectedApplicationId}). `
        + 'Slash commands may be registered on a different bot application.',
      );
    }

    try {
      const commandManager = readyClient.application?.commands;
      const createCommand = commandManager?.create?.bind(commandManager);
      const existingCommands = typeof commandManager?.fetch === 'function'
        ? await commandManager.fetch()
        : [];
      await upsertOwnedCommands(createCommand, undefined, existingCommands);
    } catch (error) {
      const errorClass = String(error?.name || 'Error');
      const status = Number.isInteger(error?.status) ? ` status=${error.status}` : '';
      (dependencies.logger || console).error(
        `Unable to upsert owned global Discord commands (${errorClass}${status}); continuing bot startup.`,
      );
    }

    await ensureSetupPanels(readyClient, guildConfigService);

    if (accessPolicy) {
      await startGuildIdleChatterTimers(readyClient, accessPolicy.isChannelEligible);
    }

    console.log(`Logged in as ${readyClient.user.tag}`);
  };
}

const handleReady = createReadyHandler();

module.exports = {
  canPostSetupPanel,
  createGuildCreateHandler,
  createReadyHandler,
  ensureGuildSetupPanel,
  ensureSetupPanels,
  findSetupChannel,
  handleReady,
};
