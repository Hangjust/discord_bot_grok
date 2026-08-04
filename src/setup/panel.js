const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const { blockedAllowedMentions } = require('../config/constants');
const { sanitizeDiscordMentions } = require('../discord/mentions');
const { isNormalizedGuildConfigReady } = require('../storage/guildConfigStore');
const { setupCustomIds } = require('./constants');

const panelOperations = new Map();

function isMissingPanelError(error) {
  const code = Number(error?.code);
  return [10003, 10008, 50001, 50013].includes(code);
}

function formatListCount(values, emptyText) {
  const count = Array.isArray(values) ? values.length : 0;
  return count === 0 ? emptyText : `${count} selected`;
}

function getPersonaStatus(config) {
  const persona = config?.persona ?? {};
  if (!persona.characterName || String(persona.behavior ?? '').trim().length < 100) {
    return '❌ Not configured';
  }

  const identity = String(persona.characterName).trim().toLowerCase() === 'ai'
    ? 'General AI'
    : sanitizeDiscordMentions(String(persona.characterName).trim());
  return [
    `✅ ${identity}`,
    `Wake word: \`${sanitizeDiscordMentions(persona.triggerWord || 'ai')}\``,
    `Language: ${persona.profanity || 'strict'}`,
    `Output: ${persona.textStyle || 'normal'} / ${persona.responseFormat || 'text'}`,
  ].join('\n');
}

function getAccessStatus(config) {
  const access = config?.access ?? {};
  return [
    `${Array.isArray(access.channelIds) && access.channelIds.length ? '✅' : '❌'} Channels: ${formatListCount(access.channelIds, 'none')}`,
    `Allowed roles: ${formatListCount(access.allowedRoleIds, 'everyone')}`,
    `Blocked roles: ${formatListCount(access.blockedRoleIds, 'none')}`,
  ].join('\n');
}

function getProviderStatus(config) {
  if (!config?.provider?.encryptedKey) {
    return '❌ No API key stored';
  }

  if (config.provider.keyStatus === 'no_balance') {
    return '⚠️ Key stored, but no balance is available';
  }

  if (config.provider.keyStatus === 'valid') {
    return '✅ API key connected';
  }

  return '⚠️ API key stored; balance not verified';
}

function getAdvancedStatus(config) {
  const advanced = config?.advanced ?? {};
  return [
    `Web search: ${advanced.webSearchMode || 'off'}`,
    `Answer length: ${advanced.responseLength || 'balanced'}`,
    `Context: ${Number(advanced.contextMessages ?? 10)} messages`,
    `User cooldown: ${Number(advanced.cooldownSeconds ?? 5)} seconds`,
  ].join('\n');
}

function buildSetupEmbed(config) {
  const configured = isNormalizedGuildConfigReady(config);
  const hasNoBalance = configured && config?.provider?.keyStatus === 'no_balance';
  return new EmbedBuilder()
    .setColor(hasNoBalance ? 0xfee75c : configured ? 0x57f287 : 0x5865f2)
    .setTitle('Set me up')
    .setDescription(hasNoBalance
      ? 'Setup is complete, but the connected API account needs balance before I can answer.'
      : configured
        ? 'I am ready. Server owners and administrators can use the controls below to update me at any time.'
        : 'Finish the required sections below, then mention me, reply to me, or begin a message with your wake word.')
    .addFields(
      { name: '1. Persona', value: getPersonaStatus(config), inline: true },
      { name: '2. Channels & roles', value: getAccessStatus(config), inline: true },
      { name: '3. API key', value: getProviderStatus(config), inline: true },
      { name: '4. More settings', value: getAdvancedStatus(config), inline: false },
    )
    .setFooter({ text: 'Only the server owner or an administrator can change these settings.' })
    .setTimestamp(new Date(config?.updatedAt || Date.now()));
}

function buildSetupButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(setupCustomIds.personaOpen)
      .setLabel('Configure persona')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(setupCustomIds.accessOpen)
      .setLabel('Channels & roles')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(setupCustomIds.apiKeyOpen)
      .setLabel('Bring your API key')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(setupCustomIds.advancedOpen)
      .setLabel('More settings')
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildSetupPanelMessage(config) {
  return {
    embeds: [buildSetupEmbed(config)],
    components: [buildSetupButtonRow()],
    allowedMentions: blockedAllowedMentions,
  };
}

function canPostSetupPanel(channel, guild) {
  if (!channel || !guild || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    return false;
  }

  const botMember = guild.members?.me;
  const permissions = botMember && channel.permissionsFor?.(botMember);
  return Boolean(permissions?.has?.([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ]));
}

function findSetupChannel(guild) {
  if (canPostSetupPanel(guild?.systemChannel, guild)) {
    return guild.systemChannel;
  }

  let firstUsableChannel = null;
  for (const channel of guild?.channels?.cache?.values?.() ?? []) {
    if (!canPostSetupPanel(channel, guild)) continue;
    if (!firstUsableChannel
      || (channel.rawPosition ?? 0) < (firstUsableChannel.rawPosition ?? 0)) {
      firstUsableChannel = channel;
    }
  }
  return firstUsableChannel;
}

async function getPersistedSetupMessage(guild, config) {
  const channelId = config?.setup?.channelId;
  const messageId = config?.setup?.messageId;
  if (!channelId || !messageId) {
    return null;
  }

  try {
    const channel = guild.channels?.cache?.get?.(channelId) ?? await guild.channels?.fetch?.(channelId);
    if (!channel?.messages?.fetch) {
      return null;
    }
    return channel.messages.cache?.get?.(messageId) ?? await channel.messages.fetch(messageId);
  } catch (error) {
    if (isMissingPanelError(error)) return null;
    throw error;
  }
}

async function editPersistedSetupMessage(guild, config) {
  const channelId = config?.setup?.channelId;
  const messageId = config?.setup?.messageId;
  if (!channelId || !messageId) {
    return null;
  }

  try {
    const channel = guild.channels?.cache?.get?.(channelId) ?? await guild.channels?.fetch?.(channelId);
    const cachedMessage = channel?.messages?.cache?.get?.(messageId);
    if (cachedMessage?.edit) {
      return await cachedMessage.edit(buildSetupPanelMessage(config));
    }
    if (channel?.messages?.edit) {
      return await channel.messages.edit(messageId, buildSetupPanelMessage(config));
    }
    const fetchedMessage = await getPersistedSetupMessage(guild, config);
    return fetchedMessage ? fetchedMessage.edit(buildSetupPanelMessage(config)) : null;
  } catch (error) {
    if (isMissingPanelError(error)) return null;
    throw error;
  }
}

async function runPanelOperation(guildId, operation) {
  const previous = panelOperations.get(guildId) ?? Promise.resolve();
  const current = previous.catch(() => null).then(operation);
  panelOperations.set(guildId, current);

  try {
    return await current;
  } finally {
    if (panelOperations.get(guildId) === current) {
      panelOperations.delete(guildId);
    }
  }
}

async function ensureSetupPanel(guild, store, options = {}) {
  if (!guild?.id || !store) {
    return null;
  }

  return runPanelOperation(guild.id, async () => {
    const config = await store.get(guild.id);
    if (!options.force) {
      const existing = options.refresh === false
        ? await getPersistedSetupMessage(guild, config)
        : await editPersistedSetupMessage(guild, config);
      if (existing) {
        return existing;
      }
    }

    const channel = canPostSetupPanel(options.channel, guild)
      ? options.channel
      : findSetupChannel(guild);
    if (!channel) {
      return null;
    }

    const message = await channel.send(buildSetupPanelMessage(config));
    await store.setSetupMessage(guild.id, channel.id, message.id);
    return message;
  });
}

async function refreshSetupPanel(guild, store) {
  if (!guild?.id || !store) {
    return null;
  }

  return runPanelOperation(guild.id, async () => {
    const config = await store.get(guild.id);
    const message = await editPersistedSetupMessage(guild, config);
    if (message) {
      return message;
    }

    const channel = findSetupChannel(guild);
    if (!channel) {
      return null;
    }
    const newMessage = await channel.send(buildSetupPanelMessage(config));
    await store.setSetupMessage(guild.id, channel.id, newMessage.id);
    return newMessage;
  });
}

module.exports = {
  buildSetupButtonRow,
  buildSetupEmbed,
  buildSetupPanelMessage,
  canPostSetupPanel,
  ensureSetupPanel,
  editPersistedSetupMessage,
  findSetupChannel,
  getPersistedSetupMessage,
  isMissingPanelError,
  refreshSetupPanel,
};
