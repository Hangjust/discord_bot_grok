const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const { blockedAllowedMentions } = require('../config/constants');
const { getHelpEmbedPages } = require('../commands/help');
const {
  AI_HELP_COMMAND_NAME,
} = require('./commandDefinitions');

function isAiHelpInteraction(interaction) {
  return Boolean(
    interaction?.isChatInputCommand?.()
    && interaction.commandName === AI_HELP_COMMAND_NAME,
  );
}

function privateHelpPage(embed) {
  return {
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
    allowedMentions: blockedAllowedMentions,
  };
}

function createAiHelpInteractionHandler(dependencies = {}) {
  const guildConfigService = dependencies.guildConfigService;

  return async function handleAiHelp(interaction) {
    if (!isAiHelpInteraction(interaction)) {
      return false;
    }

    if (!interaction.inGuild?.() || !interaction.guildId) {
      await interaction.reply({
        content: '`/ai-help` only works in a server.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: blockedAllowedMentions,
      });
      return true;
    }

    const canManageMessages = interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageMessages)
      || interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator);
    if (!canManageMessages) {
      await interaction.reply({
        content: 'You need the Manage Messages permission to use AI help.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: blockedAllowedMentions,
      });
      return true;
    }

    let status = null;
    let promptSource = 'built-in';
    try {
      status = await guildConfigService?.getStatus?.(interaction.guildId);
      const behavior = await guildConfigService?.resolveAgentBehavior?.(
        interaction.guildId,
        interaction.channelId,
      );
      promptSource = behavior?.source || promptSource;
    } catch {
      // Help remains available with safe defaults if configuration is unavailable.
    }

    const [firstPage, ...remainingPages] = getHelpEmbedPages({
      triggerWord: status?.triggerWord,
      configured: status?.configured,
      webSearchEnabled: status?.webSearchEnabled,
      promptSource,
      guildName: interaction.guild?.name,
      avatarUrl: interaction.client?.user?.displayAvatarURL?.(),
    });
    await interaction.reply(privateHelpPage(firstPage));
    for (const page of remainingPages) {
      await interaction.followUp(privateHelpPage(page));
    }
    return true;
  };
}

module.exports = {
  createAiHelpInteractionHandler,
  isAiHelpInteraction,
  privateHelpPage,
};
