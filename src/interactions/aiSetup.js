const {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const { blockedAllowedMentions } = require('../config/constants');
const {
  AI_SETUP_COMMAND_NAME,
} = require('./commandDefinitions');

const SETUP_COLOR = 0x57F287;

function ephemeral(content) {
  return {
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: blockedAllowedMentions,
  };
}

function isAiSetupInteraction(interaction) {
  return Boolean(
    interaction?.isChatInputCommand?.()
    && interaction.commandName === AI_SETUP_COMMAND_NAME,
  );
}

function createSetupStatusEmbed(status, behavior) {
  const access = status.access || {};
  const activeProviderHasKey = status.aiProvider === 'gemma4'
    ? status.hasGeminiKey === true
    : status.hasDeepseekKey === true;
  const nextActions = [
    ...(!activeProviderHasKey ? ['`/ai-setup api` · credentials'] : []),
    '`/ai-setup channel` · channel access',
    '`/ai-setup prompt` · custom prompt',
    '`/ai-setup trigger` · invocation word',
  ];
  return new EmbedBuilder()
    .setColor(status.configured ? SETUP_COLOR : 0xFEE75C)
    .setTitle('⚙️ AI Server Setup')
    .setDescription(status.configured
      ? 'This server is configured. Sensitive values are intentionally hidden.'
      : 'Setup is incomplete. Start with `/ai-setup api`.')
    .addFields(
      {
        name: '🔐 API providers',
        value: [
          `Active AI: **${status.aiProvider === 'gemma4' ? 'Gemma 4 (Gemini API)' : 'DeepSeek'}**`,
          `DeepSeek key: **${status.hasDeepseekKey ? 'configured' : 'missing'}**`,
          `Gemini key: **${status.hasGeminiKey ? 'configured' : 'missing'}**`,
          `Brave key: **${status.hasBraveKey ? 'configured' : 'missing'}**`,
          `Web search: **${status.webSearchEnabled ? 'enabled' : 'disabled'}**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '📣 Invocation',
        value: [
          `Trigger word: **\`${status.triggerWord || 'AI'}\`**`,
          `Text example: \`${status.triggerWord || 'AI'} help\``,
          'Mentioning the bot also works.',
        ].join('\n'),
        inline: true,
      },
      {
        name: '🧠 Custom prompt',
        value: [
          `Effective source: **${behavior?.source || 'built-in'}**`,
          `Characters: **${behavior?.characterCount || 0}**`,
          'Full prompt text is never shown in status.',
        ].join('\n'),
        inline: false,
      },
      {
        name: '🚪 Access policy',
        value: [
          `Allowed channels: **${access.allowedChannelIds?.length || 0}**`,
          `Allowed roles: **${access.allowedRoleIds?.length || 0}**`,
          `Ignored roles: **${access.ignoredRoleIds?.length || 0}**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '🧭 Next actions',
        value: nextActions.join('\n'),
        inline: true,
      },
    )
    .setFooter({ text: `Configuration revision ${status.revision || 0}` })
    .setTimestamp();
}

function createAiSetupInteractionHandler(dependencies = {}) {
  const {
    guildConfigService,
    configActions,
    promptActions,
  } = dependencies;

  if (!guildConfigService
    || typeof configActions?.handleCommand !== 'function'
    || typeof configActions?.handleApi !== 'function'
    || typeof promptActions?.handleCommand !== 'function') {
    throw new TypeError('AI setup dependencies are required');
  }

  async function rejectIfUnauthorized(interaction, statusOnly = false) {
    if (!interaction.inGuild?.() || !interaction.guildId) {
      await interaction.reply(ephemeral('`/ai-setup` only works in a server.'));
      return true;
    }
    const isAdministrator = interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator);
    const canManageMessages = interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageMessages);
    if (statusOnly ? !(canManageMessages || isAdministrator) : !isAdministrator) {
      await interaction.reply(ephemeral(statusOnly
        ? 'You need the Manage Messages permission to view AI setup status.'
        : 'Only server administrators can change AI setup.'));
      return true;
    }
    return false;
  }

  async function handleStatus(interaction) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
      allowedMentions: blockedAllowedMentions,
    });
    const [status, behavior] = await Promise.all([
      guildConfigService.getStatus(interaction.guildId),
      guildConfigService.resolveAgentBehavior(interaction.guildId, interaction.channelId),
    ]);
    await interaction.editReply({
      embeds: [createSetupStatusEmbed(status, behavior)],
      allowedMentions: blockedAllowedMentions,
    });
  }

  async function handleTrigger(interaction) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
      allowedMentions: blockedAllowedMentions,
    });
    const result = await guildConfigService.setTriggerWord(
      interaction.guildId,
      interaction.options.getString('value', true),
      interaction.user.id,
    );
    await interaction.editReply({
      content: result.changed
        ? `Trigger updated to **\`${result.triggerWord}\`**. Try \`${result.triggerWord} help\`.`
        : `The trigger is already **\`${result.triggerWord}\`**.`,
      allowedMentions: blockedAllowedMentions,
    });
  }

  async function handleApi(interaction) {
    const provider = interaction.options.getString('provider', true);
    const webSearch = interaction.options.getBoolean('web-search') === true;
    await configActions.handleApi(interaction, provider, webSearch);
  }

  return async function handleAiSetup(interaction) {
    if (!isAiSetupInteraction(interaction)) {
      return false;
    }

    try {
      const subcommand = interaction.options.getSubcommand();
      if (await rejectIfUnauthorized(interaction, subcommand === 'status')) {
        return true;
      }
      if (subcommand === 'status') {
        await handleStatus(interaction);
      } else if (subcommand === 'api') {
        await handleApi(interaction);
      } else if (subcommand === 'prompt') {
        await promptActions.handleCommand(interaction);
      } else if (subcommand === 'trigger') {
        await handleTrigger(interaction);
      } else {
        await configActions.handleCommand(interaction);
      }
    } catch {
      const response = ephemeral('The AI setup action could not be completed. No API key or custom prompt was exposed.');
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: response.content,
          embeds: [],
          components: [],
          allowedMentions: response.allowedMentions,
        });
      } else {
        await interaction.reply(response);
      }
    }
    return true;
  };
}

module.exports = {
  SETUP_COLOR,
  createAiSetupInteractionHandler,
  createSetupStatusEmbed,
  isAiSetupInteraction,
};
