const { randomBytes } = require('node:crypto');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { blockedAllowedMentions } = require('../config/constants');
const {
  resetChannelConversation,
  resetGuildConversations,
} = require('../state/conversations');
const {
  AgentBehaviorInputError,
  resolveAgentBehaviorInput,
} = require('./agentBehaviorInput');
const {
  AGENT_BEHAVIOR_MAX_LENGTH,
  AI_SETUP_COMMAND_NAME,
} = require('./commandDefinitions');

const AGENT_MODAL_TTL_MS = 10 * 60 * 1000;
const AGENT_IDS = Object.freeze({
  modalPrefix: 'ai-setup:prompt:modal:',
  textInput: 'behavior',
});

function ephemeral(content) {
  return {
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: blockedAllowedMentions,
  };
}

function isAiPromptInteraction(interaction) {
  return Boolean(
    (interaction?.isChatInputCommand?.()
      && interaction.commandName === AI_SETUP_COMMAND_NAME
      && interaction.options?.getSubcommand?.() === 'prompt')
    || (interaction?.isModalSubmit?.()
      && String(interaction.customId || '').startsWith(AGENT_IDS.modalPrefix)),
  );
}

function createBehaviorModal(customId, scope) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(`Set ${scope} AI behavior`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(AGENT_IDS.textInput)
          .setLabel('AGENTS.md behavior')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(AGENT_BEHAVIOR_MAX_LENGTH),
      ),
    );
}

function createAgentStatusMessage(status) {
  const target = status.scope === 'channel' ? `channel \`${status.channelId}\`` : 'server';
  return [
    `Behavior target: **${target}**`,
    `Effective source: **${status.source}**`,
    `Characters: **${status.characterCount}**`,
    `Revision: **${status.revision}**`,
  ].join('\n');
}

function createAiPromptInteractionHandler(dependencies = {}) {
  const { guildConfigService } = dependencies;
  const fetchImpl = dependencies.fetchImpl;
  const now = dependencies.now || Date.now;
  const pending = new Map();

  if (!guildConfigService) {
    throw new TypeError('guildConfigService is required');
  }

  function targetFor(interaction, scope) {
    if (scope === 'server') {
      return null;
    }
    return interaction.options?.getChannel?.('channel')?.id || interaction.channelId;
  }

  function createPending(interaction, operation) {
    const currentTime = now();
    for (const [nonce, state] of pending) {
      if (state.expiresAt <= currentTime) {
        pending.delete(nonce);
      }
    }

    const nonce = randomBytes(16).toString('hex');
    pending.set(nonce, {
      ...operation,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      expiresAt: currentTime + AGENT_MODAL_TTL_MS,
    });
    return nonce;
  }

  function consumePending(interaction) {
    const nonce = String(interaction.customId).slice(AGENT_IDS.modalPrefix.length);
    const state = pending.get(nonce);
    if (!state
      || state.expiresAt <= now()
      || state.guildId !== interaction.guildId
      || state.userId !== interaction.user.id) {
      if (state?.expiresAt <= now()) {
        pending.delete(nonce);
      }
      return null;
    }

    pending.delete(nonce);
    return state;
  }

  async function rejectIfUnauthorized(interaction) {
    if (!interaction.inGuild?.() || !interaction.guildId) {
      await interaction.reply(ephemeral('AI prompt setup only works in a server.'));
      return true;
    }
    if (!interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)) {
      await interaction.reply(ephemeral('Only server administrators can manage AI behavior.'));
      return true;
    }
    return false;
  }

  function invalidate(result) {
    if (!(result.effectiveChanged ?? result.changed)) {
      return;
    }
    if (result.scope === 'channel') {
      resetChannelConversation(result.guildId, result.channelId);
      return;
    }
    resetGuildConversations(result.guildId, new Set(result.channelOverrideIds));
  }

  async function editError(interaction, error) {
    const content = error instanceof AgentBehaviorInputError
      ? error.message
      : 'The behavior action could not be completed. No submitted text or secrets were exposed.';
    await interaction.editReply({
      content,
      allowedMentions: blockedAllowedMentions,
    });
  }

  async function persistSet(interaction, state, input) {
    const resolved = await resolveAgentBehaviorInput(input, { fetchImpl });
    const result = await guildConfigService.setAgentBehavior(interaction.guildId, {
      scope: state.scope,
      ...(state.channelId ? { channelId: state.channelId } : {}),
      content: resolved.content,
      updatedByUserId: interaction.user.id,
    });
    invalidate(result);
    await interaction.editReply({
      content: result.changed
        ? `Behavior updated. Effective source: **${result.source}**; revision: **${result.revision}**.`
        : `Behavior was already identical. Revision remains **${result.revision}**.`,
      allowedMentions: blockedAllowedMentions,
    });
  }

  async function handleCommand(interaction) {
    const scope = interaction.options.getString('scope', true);
    const operation = interaction.options.getString('action', true);
    const channelId = targetFor(interaction, scope);
    const request = {
      scope,
      ...(channelId ? { channelId } : {}),
    };

    if (operation === 'set') {
      const text = interaction.options.getString('text');
      const attachment = interaction.options.getAttachment('file');

      if (text == null && attachment == null) {
        const nonce = createPending(interaction, { operation: 'set', ...request });
        await interaction.showModal(createBehaviorModal(
          `${AGENT_IDS.modalPrefix}${nonce}`,
          scope,
        ));
        return;
      }

      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
        allowedMentions: blockedAllowedMentions,
      });
      await persistSet(interaction, request, { text, attachment });
      return;
    }

    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
      allowedMentions: blockedAllowedMentions,
    });

    if (operation === 'status') {
      const status = await guildConfigService.getAgentBehaviorStatus(interaction.guildId, request);
      await interaction.editReply({
        content: createAgentStatusMessage(status),
        allowedMentions: blockedAllowedMentions,
      });
      return;
    }

    if (operation === 'export') {
      const exported = await guildConfigService.exportAgentBehavior(interaction.guildId, request);
      await interaction.editReply({
        content: `Exported effective **${exported.source}** behavior for ${exported.scope === 'channel' ? `channel \`${exported.channelId}\`` : 'the server'}.`,
        files: [new AttachmentBuilder(Buffer.from(exported.content, 'utf8'), { name: 'AGENTS.md' })],
        allowedMentions: blockedAllowedMentions,
      });
      return;
    }

    const result = await guildConfigService.clearAgentBehavior(interaction.guildId, request);
    invalidate(result);
    await interaction.editReply({
      content: result.changed
        ? `Behavior cleared. Effective source is now **${result.source}**; revision: **${result.revision}**.`
        : `There was no behavior document to clear. Revision remains **${result.revision}**.`,
      allowedMentions: blockedAllowedMentions,
    });
  }

  async function handleModal(interaction) {
    const state = consumePending(interaction);
    if (!state || state.operation !== 'set') {
      await interaction.reply(ephemeral('This behavior form expired or does not belong to you. Start again.'));
      return;
    }

    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
      allowedMentions: blockedAllowedMentions,
    });
    await persistSet(interaction, state, {
      text: interaction.fields.getTextInputValue(AGENT_IDS.textInput),
      textSource: 'modal',
    });
  }

  async function handleAiPrompt(interaction) {
    if (!isAiPromptInteraction(interaction)) {
      return false;
    }
    if (await rejectIfUnauthorized(interaction)) {
      return true;
    }

    try {
      if (interaction.isModalSubmit?.()) {
        await handleModal(interaction);
      } else {
        await handleCommand(interaction);
      }
    } catch (error) {
      if (interaction.deferred || interaction.replied) {
        await editError(interaction, error);
      } else {
        const content = error instanceof AgentBehaviorInputError
          ? error.message
          : 'The behavior action could not be completed. No submitted text or secrets were exposed.';
        await interaction.reply(ephemeral(content));
      }
    }
    return true;
  }

  handleAiPrompt.handleCommand = async (interaction) => {
    if (await rejectIfUnauthorized(interaction)) {
      return;
    }
    try {
      await handleCommand(interaction);
    } catch (error) {
      if (interaction.deferred || interaction.replied) {
        await editError(interaction, error);
      } else {
        const content = error instanceof AgentBehaviorInputError
          ? error.message
          : 'The behavior action could not be completed. No submitted text or secrets were exposed.';
        await interaction.reply(ephemeral(content));
      }
    }
  };

  return handleAiPrompt;
}

module.exports = {
  AGENT_IDS,
  AGENT_MODAL_TTL_MS,
  createAgentStatusMessage,
  createBehaviorModal,
  createAiPromptInteractionHandler,
  isAiPromptInteraction,
};
