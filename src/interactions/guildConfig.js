const { randomBytes } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { resetGuildConversations } = require('../state/conversations');

const IDS = Object.freeze({
  setup: 'ai-setup:api',
  setupWebEnabled: 'ai-setup:api:web:on',
  setupWebDisabled: 'ai-setup:api:web:off',
  modalPrefix: 'ai-setup:api:modal:',
  resetPrefix: 'ai-setup:reset:',
});
const MODAL_TTL_MS = 10 * 60 * 1000;
const blockedAllowedMentions = Object.freeze({ parse: [], users: [], roles: [], repliedUser: false });

function ephemeral(content, components = []) {
  return {
    content,
    components,
    flags: MessageFlags.Ephemeral,
    allowedMentions: blockedAllowedMentions,
  };
}

function createSetupPanel() {
  return {
    content: 'AI setup is required for this server. An administrator can use the button below or run `/ai-setup api`.',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.setup)
        .setLabel('Set up AI')
        .setStyle(ButtonStyle.Primary),
    )],
    allowedMentions: blockedAllowedMentions,
  };
}

function createWebChoiceResponse() {
  return ephemeral('Should the AI use Brave web search in this server?', [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.setupWebEnabled)
        .setLabel('Enable web search')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(IDS.setupWebDisabled)
        .setLabel('Keep web search disabled')
        .setStyle(ButtonStyle.Secondary),
    ),
  ]);
}

function addSecretInput(modal, customId, label) {
  return modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(200),
  ));
}

function getProviderLabel(provider) {
  if (provider === 'gemma4') return 'Gemma 4 (Gemini API)';
  if (provider === 'qwen') return 'Qwen';
  return 'DeepSeek';
}

function getProviderSecretField(provider) {
  if (provider === 'gemma4') return 'gemini-key';
  if (provider === 'qwen') return 'qwen-key';
  return 'deepseek-key';
}

function createSetupModal(customId, provider, webSearchEnabled) {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Configure AI');
  addSecretInput(
    modal,
    getProviderSecretField(provider),
    provider === 'gemma4' ? 'Gemini API key for Gemma 4' : `${getProviderLabel(provider)} API key`,
  );

  if (webSearchEnabled) {
    addSecretInput(modal, 'brave-key', 'Brave Search API key');
  }

  return modal;
}

function createSecretModal(customId, field) {
  const provider = field === 'deepseek'
    ? 'DeepSeek'
    : field === 'gemini'
      ? 'Gemini'
      : field === 'qwen'
        ? 'Qwen'
        : 'Brave Search';
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(`Rotate ${provider} key`);
  return addSecretInput(modal, 'secret-key', `${provider} API key`);
}

function createStatusMessage(status) {
  const list = (values) => values.length ? values.map((value) => `\`${value}\``).join(', ') : 'none';
  return [
    `Configuration: **${status.configured ? 'configured' : 'not configured'}** (${status.source})`,
    `Active AI: **${getProviderLabel(status.aiProvider)}**`,
    `DeepSeek key stored: **${status.hasDeepseekKey ? 'yes' : 'no'}**`,
    `Gemini key stored: **${status.hasGeminiKey ? 'yes' : 'no'}**`,
    `Qwen key stored: **${status.hasQwenKey ? 'yes' : 'no'}**`,
    `Web search: **${status.webSearchEnabled ? 'enabled' : 'disabled'}**`,
    `Brave key stored: **${status.hasBraveKey ? 'yes' : 'no'}**`,
    `Allowed channels: ${list(status.access.allowedChannelIds)}`,
    `Ignored channels: ${list(status.access.ignoredChannelIds)}`,
    `Allowed roles: ${list(status.access.allowedRoleIds)}`,
    `Ignored roles: ${list(status.access.ignoredRoleIds)}`,
  ].join('\n');
}

function createGuildConfigInteractionHandler(dependencies = {}) {
  const { guildConfigService } = dependencies;
  const validators = dependencies.credentialValidators || {};
  const now = dependencies.now || Date.now;
  const pending = new Map();

  if (!guildConfigService) {
    throw new TypeError('guildConfigService is required');
  }

  function createPending(interaction, operation) {
    const currentTime = now();

    for (const [nonce, state] of pending) {
      if (state.expiresAt < currentTime) {
        pending.delete(nonce);
      }
    }

    const nonce = randomBytes(9).toString('base64url');
    pending.set(nonce, {
      ...operation,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      expiresAt: currentTime + MODAL_TTL_MS,
    });
    return nonce;
  }

  function consumePending(interaction, nonce) {
    const state = pending.get(nonce);

    if (!state) {
      return null;
    }

    if (state.expiresAt < now()) {
      pending.delete(nonce);
      return null;
    }

    if (state.guildId !== interaction.guildId || state.userId !== interaction.user.id) {
      return null;
    }

    pending.delete(nonce);
    return state;
  }

  function isAdministrator(interaction) {
    return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
  }

  async function rejectIfUnauthorized(interaction) {
    if (!interaction.inGuild?.() || !interaction.guildId) {
      await interaction.reply(ephemeral('This configuration command only works in a server.'));
      return true;
    }

    if (!isAdministrator(interaction)) {
      await interaction.reply(ephemeral('Only server administrators can configure the AI.'));
      return true;
    }

    return false;
  }

  async function rejectIfNotConfigured(interaction, requireStored = true) {
    const status = await guildConfigService.getStatus(interaction.guildId);

    if (!status.configured) {
      await interaction.reply(ephemeral('The AI is not configured for this server. Run `/ai-setup api` first.'));
      return true;
    }

    if (requireStored && status.source !== 'stored') {
      await interaction.reply(ephemeral('This server is using legacy environment configuration. Run `/ai-setup api` before using per-server administration.'));
      return true;
    }

    return false;
  }

  async function showSetupChoice(interaction) {
    await interaction.reply(createWebChoiceResponse());
  }

  async function handleSetupChoice(interaction, provider, enabled) {
    const nonce = createPending(interaction, {
      operation: 'setup',
      provider,
      webSearchEnabled: enabled,
    });
    await interaction.showModal(createSetupModal(
      `${IDS.modalPrefix}${nonce}`,
      provider,
      enabled,
    ));
  }

  async function handleModal(interaction) {
    const nonce = interaction.customId.slice(IDS.modalPrefix.length);
    const state = consumePending(interaction, nonce);

    if (!state) {
      await interaction.reply(ephemeral('This configuration form expired or does not belong to you. Start again.'));
      return;
    }

    if (state.operation !== 'setup' && await rejectIfNotConfigured(interaction)) {
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (state.operation === 'setup') {
        const deepseekApiKey = state.provider === 'deepseek'
          ? interaction.fields.getTextInputValue('deepseek-key').trim()
          : '';
        const geminiApiKey = state.provider === 'gemma4'
          ? interaction.fields.getTextInputValue('gemini-key').trim()
          : '';
        const qwenApiKey = state.provider === 'qwen'
          ? interaction.fields.getTextInputValue('qwen-key').trim()
          : '';
        const braveApiKey = state.webSearchEnabled
          ? interaction.fields.getTextInputValue('brave-key').trim()
          : '';

        if (state.provider === 'gemma4') {
          await validators.validateGeminiKey(geminiApiKey);
        } else if (state.provider === 'qwen') {
          await validators.validateQwenKey(qwenApiKey);
        } else {
          await validators.validateDeepseekKey(deepseekApiKey);
        }

        if (state.webSearchEnabled) {
          await validators.validateBraveKey(braveApiKey);
        }

        await guildConfigService.configureGuild(interaction.guildId, {
          configuredByUserId: interaction.user.id,
          setupChannelId: interaction.channelId,
          aiProvider: state.provider,
          deepseekApiKey,
          geminiApiKey,
          qwenApiKey,
          webSearchEnabled: state.webSearchEnabled,
          braveApiKey,
        });
        await interaction.editReply({
          content: 'The AI is configured. This channel is initially allowed; use `/ai-setup channel`, `/ai-setup role`, and `/ai-setup status` for ongoing administration.',
          allowedMentions: blockedAllowedMentions,
        });
        return;
      }

      const secret = interaction.fields.getTextInputValue('secret-key').trim();

      if (state.field === 'deepseek') {
        await validators.validateDeepseekKey(secret);
      } else if (state.field === 'gemini') {
        await validators.validateGeminiKey(secret);
      } else if (state.field === 'qwen') {
        await validators.validateQwenKey(secret);
      } else {
        await validators.validateBraveKey(secret);
      }

      if (state.operation === 'web-enable') {
        await guildConfigService.setWebSearch(interaction.guildId, true, secret);
      } else {
        await guildConfigService.rotateSecret(interaction.guildId, state.field, secret);
      }

      await interaction.editReply({
        content: state.operation === 'web-enable'
          ? 'Web search is enabled.'
          : `${state.field === 'deepseek' ? 'DeepSeek' : state.field === 'gemini' ? 'Gemini' : state.field === 'qwen' ? 'Qwen' : 'Brave Search'} key rotated.`,
        allowedMentions: blockedAllowedMentions,
      });
    } catch {
      await interaction.editReply({
        content: 'The credentials could not be validated or saved. The previous configuration was not changed.',
        allowedMentions: blockedAllowedMentions,
      });
    }
  }

  async function handleCommand(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'setup') {
      await showSetupChoice(interaction);
      return;
    }

    if (subcommand === 'status') {
      const status = await guildConfigService.getStatus(interaction.guildId);
      await interaction.reply(ephemeral(createStatusMessage(status)));
      return;
    }

    if (subcommand === 'channel' || subcommand === 'role') {
      if (await rejectIfNotConfigured(interaction)) {
        return;
      }

      const action = interaction.options.getString('action', true);
      const target = subcommand === 'channel'
        ? interaction.options.getChannel('channel', true)
        : interaction.options.getRole('role', true);
      await guildConfigService.moveAccessEntry(interaction.guildId, subcommand, action, target.id);
      await interaction.reply(ephemeral(`${subcommand === 'channel' ? 'Channel' : 'Role'} access updated.`));
      return;
    }

    if (subcommand === 'web') {
      if (await rejectIfNotConfigured(interaction)) {
        return;
      }

      const action = interaction.options.getString('action', true);

      if (action === 'disable') {
        await guildConfigService.setWebSearch(interaction.guildId, false);
        await interaction.reply(ephemeral('Web search is disabled.'));
        return;
      }

      const status = await guildConfigService.getStatus(interaction.guildId);

      if (status.hasBraveKey) {
        await guildConfigService.setWebSearch(interaction.guildId, true);
        await interaction.reply(ephemeral('Web search is enabled.'));
        return;
      }

      const nonce = createPending(interaction, { operation: 'web-enable', field: 'brave' });
      await interaction.showModal(createSecretModal(`${IDS.modalPrefix}${nonce}`, 'brave'));
      return;
    }

    if (subcommand === 'secret') {
      if (await rejectIfNotConfigured(interaction)) {
        return;
      }

      const field = interaction.options.getString('field', true);
      const nonce = createPending(interaction, { operation: 'rotate', field });
      await interaction.showModal(createSecretModal(`${IDS.modalPrefix}${nonce}`, field));
      return;
    }

    if (await rejectIfNotConfigured(interaction, false)) {
      return;
    }

    const nonce = createPending(interaction, { operation: 'reset' });
    await interaction.reply(ephemeral('Reset removes provider keys, access rules, prompts, and the custom trigger, immediately disabling the AI for this server.', [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${IDS.resetPrefix}${nonce}`)
          .setLabel('Confirm reset')
          .setStyle(ButtonStyle.Danger),
      ),
    ]));
  }

  async function handle(interaction) {
    const isButton = interaction.isButton?.()
      && (interaction.customId === IDS.setup
        || interaction.customId === IDS.setupWebEnabled
        || interaction.customId === IDS.setupWebDisabled
        || interaction.customId.startsWith(IDS.resetPrefix));
    const isModal = interaction.isModalSubmit?.()
      && interaction.customId.startsWith(IDS.modalPrefix);

    if (!isButton && !isModal) {
      return;
    }

    if (await rejectIfUnauthorized(interaction)) {
      return;
    }

    try {
      if (isModal) {
        await handleModal(interaction);
      } else if (interaction.customId === IDS.setup) {
        await showSetupChoice(interaction);
      } else if (interaction.customId === IDS.setupWebEnabled) {
        await handleSetupChoice(interaction, 'deepseek', true);
      } else if (interaction.customId === IDS.setupWebDisabled) {
        await handleSetupChoice(interaction, 'deepseek', false);
      } else {
        const nonce = interaction.customId.slice(IDS.resetPrefix.length);
        const state = consumePending(interaction, nonce);

        if (!state || state.operation !== 'reset') {
          await interaction.reply(ephemeral('This reset confirmation expired or does not belong to you.'));
          return;
        }

        if (await rejectIfNotConfigured(interaction, false)) {
          return;
        }

        await guildConfigService.resetGuild(interaction.guildId, interaction.user.id);
        resetGuildConversations(interaction.guildId);
        await interaction.reply(ephemeral('AI configuration was reset. Run `/ai-setup api` to configure it again.'));
      }
    } catch {
      const response = ephemeral('The configuration action could not be completed. No secret information was exposed.');

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: response.content, allowedMentions: response.allowedMentions });
      } else {
        await interaction.reply(response);
      }
    }
  }

  handle.handleCommand = async (interaction) => {
    if (await rejectIfUnauthorized(interaction)) {
      return;
    }
    try {
      await handleCommand(interaction);
    } catch {
      const response = ephemeral('The configuration action could not be completed. No secret information was exposed.');
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: response.content, allowedMentions: response.allowedMentions });
      } else {
        await interaction.reply(response);
      }
    }
  };
  handle.handleApi = async (interaction, provider, webSearchEnabled) => {
    if (await rejectIfUnauthorized(interaction)) {
      return;
    }
    await handleSetupChoice(interaction, provider, webSearchEnabled);
  };

  return handle;
}

module.exports = {
  IDS,
  MODAL_TTL_MS,
  createGuildConfigInteractionHandler,
  createSetupPanel,
  createStatusMessage,
  createWebChoiceResponse,
};
