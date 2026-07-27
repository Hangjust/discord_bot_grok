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
const { GUILD_CONFIG_COMMAND_NAME } = require('./commandDefinitions');
const {
  invalidateGuildIdleChatter,
  recordGuildIdleChatterChannel,
} = require('../state/idleChatter');

const IDS = Object.freeze({
  setup: 'grok-config:setup',
  setupWebEnabled: 'grok-config:setup:web:on',
  setupWebDisabled: 'grok-config:setup:web:off',
  modalPrefix: 'grok-config:modal:',
  resetPrefix: 'grok-config:reset:',
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
    content: 'Grok setup is required for this server. An administrator can use the button below or run `/grok-config setup`.',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.setup)
        .setLabel('Set up Grok')
        .setStyle(ButtonStyle.Primary),
    )],
    allowedMentions: blockedAllowedMentions,
  };
}

function createWebChoiceResponse() {
  return ephemeral('Should Grok use Brave web search in this server?', [
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

function createSetupModal(customId, webSearchEnabled) {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Configure Grok');
  addSecretInput(modal, 'deepseek-key', 'DeepSeek API key');

  if (webSearchEnabled) {
    addSecretInput(modal, 'brave-key', 'Brave Search API key');
  }

  return modal;
}

function createSecretModal(customId, field) {
  const provider = field === 'deepseek' ? 'DeepSeek' : 'Brave Search';
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(`Rotate ${provider} key`);
  return addSecretInput(modal, 'secret-key', `${provider} API key`);
}

function createStatusMessage(status) {
  const list = (values) => values.length ? values.map((value) => `\`${value}\``).join(', ') : 'none';
  return [
    `Configuration: **${status.configured ? 'configured' : 'not configured'}** (${status.source})`,
    `DeepSeek key stored: **${status.hasDeepseekKey ? 'yes' : 'no'}**`,
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
      await interaction.reply(ephemeral('Only server administrators can configure Grok.'));
      return true;
    }

    return false;
  }

  async function rejectIfNotConfigured(interaction, requireStored = true) {
    const status = await guildConfigService.getStatus(interaction.guildId);

    if (!status.configured) {
      await interaction.reply(ephemeral('Grok is not configured for this server. Run `/grok-config setup` first.'));
      return true;
    }

    if (requireStored && status.source !== 'stored') {
      await interaction.reply(ephemeral('This server is using legacy environment configuration. Run `/grok-config setup` before using per-server administration.'));
      return true;
    }

    return false;
  }

  async function invalidate(guildId, interaction) {
    invalidateGuildIdleChatter(guildId);

    if (dependencies.accessPolicy && interaction?.channel) {
      await recordGuildIdleChatterChannel(
        interaction.channel,
        now(),
        setTimeout,
        dependencies.accessPolicy.isChannelEligible,
      );
    }
  }

  async function showSetupChoice(interaction) {
    await interaction.reply(createWebChoiceResponse());
  }

  async function handleSetupChoice(interaction, enabled) {
    const nonce = createPending(interaction, { operation: 'setup', webSearchEnabled: enabled });
    await interaction.showModal(createSetupModal(`${IDS.modalPrefix}${nonce}`, enabled));
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
        const deepseekApiKey = interaction.fields.getTextInputValue('deepseek-key').trim();
        const braveApiKey = state.webSearchEnabled
          ? interaction.fields.getTextInputValue('brave-key').trim()
          : '';

        await validators.validateDeepseekKey(deepseekApiKey);

        if (state.webSearchEnabled) {
          await validators.validateBraveKey(braveApiKey);
        }

        await guildConfigService.configureGuild(interaction.guildId, {
          configuredByUserId: interaction.user.id,
          setupChannelId: interaction.channelId,
          deepseekApiKey,
          webSearchEnabled: state.webSearchEnabled,
          braveApiKey,
        });
        await invalidate(interaction.guildId, interaction);
        await interaction.editReply({
          content: 'Grok is configured. This channel is initially allowed; use `/grok-config channel`, `/grok-config role`, and `/grok-config status` for ongoing administration.',
          allowedMentions: blockedAllowedMentions,
        });
        return;
      }

      const secret = interaction.fields.getTextInputValue('secret-key').trim();

      if (state.field === 'deepseek') {
        await validators.validateDeepseekKey(secret);
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
          : `${state.field === 'deepseek' ? 'DeepSeek' : 'Brave Search'} key rotated.`,
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
      await invalidate(interaction.guildId);
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
    await interaction.reply(ephemeral('Reset removes both provider keys and immediately disables Grok for this server.', [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${IDS.resetPrefix}${nonce}`)
          .setLabel('Confirm reset')
          .setStyle(ButtonStyle.Danger),
      ),
    ]));
  }

  async function handle(interaction) {
    const isCommand = interaction.isChatInputCommand?.()
      && interaction.commandName === GUILD_CONFIG_COMMAND_NAME;
    const isButton = interaction.isButton?.()
      && (interaction.customId === IDS.setup
        || interaction.customId === IDS.setupWebEnabled
        || interaction.customId === IDS.setupWebDisabled
        || interaction.customId.startsWith(IDS.resetPrefix));
    const isModal = interaction.isModalSubmit?.()
      && interaction.customId.startsWith(IDS.modalPrefix);

    if (!isCommand && !isButton && !isModal) {
      return;
    }

    if (await rejectIfUnauthorized(interaction)) {
      return;
    }

    try {
      if (isCommand) {
        await handleCommand(interaction);
      } else if (isModal) {
        await handleModal(interaction);
      } else if (interaction.customId === IDS.setup) {
        await showSetupChoice(interaction);
      } else if (interaction.customId === IDS.setupWebEnabled) {
        await handleSetupChoice(interaction, true);
      } else if (interaction.customId === IDS.setupWebDisabled) {
        await handleSetupChoice(interaction, false);
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
        invalidateGuildIdleChatter(interaction.guildId);
        await interaction.reply(ephemeral('Grok configuration was reset. Run `/grok-config setup` to configure it again.'));
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
