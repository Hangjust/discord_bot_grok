const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { blockedAllowedMentions } = require('../config/constants');
const { resetGuildConversationQueues } = require('../chat/conversationQueue');
const { resetGuildConversations } = require('../state/conversations');
const { deleteGuildIdleChatterState } = require('../state/idleChatter');
const { DeepSeekApiError, validateApiKeyBalance } = require('../services/deepseek');
const { isWebSearchConfigured } = require('../services/webSearch');
const { ConfigEncryptionError } = require('../storage/guildConfigStore');
const { personaLimits, setupCustomIds } = require('./constants');
const {
  createSetupDraft,
  deleteSetupDraft,
  getSetupDraft,
  updateSetupDraft,
} = require('./drafts');
const { refreshSetupPanel } = require('./panel');
const { isGuildOwnerOrAdministrator } = require('./permissions');

const draftTypes = Object.freeze({
  persona: 'persona',
  access: 'access',
  advanced: 'advanced',
});

const apiKeyOperations = new Map();
const apiKeyValidationAttemptsByGuild = new Map();
const apiKeyValidationGlobalAttempts = [];
let apiKeyValidationsInFlight = 0;
const apiKeyValidationWindowMs = 60 * 1000;
const apiKeyValidationGuildMax = 5;
const apiKeyValidationGlobalMax = 100;
const apiKeyValidationGlobalConcurrent = 5;

function beginApiKeyOperation(guildId) {
  const token = Symbol('api-key-operation');
  apiKeyOperations.set(String(guildId), token);
  return token;
}

function isCurrentApiKeyOperation(guildId, token) {
  return apiKeyOperations.get(String(guildId)) === token;
}

function finishApiKeyOperation(guildId, token) {
  if (isCurrentApiKeyOperation(guildId, token)) {
    apiKeyOperations.delete(String(guildId));
  }
}

function cancelGuildApiKeyOperation(guildId) {
  const guildKey = String(guildId);
  apiKeyValidationAttemptsByGuild.delete(guildKey);
  return apiKeyOperations.delete(guildKey);
}

function pruneApiKeyValidationAttempts(now) {
  while (apiKeyValidationGlobalAttempts.length
    && now - apiKeyValidationGlobalAttempts[0] >= apiKeyValidationWindowMs) {
    apiKeyValidationGlobalAttempts.shift();
  }
  for (const [guildId, timestamps] of apiKeyValidationAttemptsByGuild.entries()) {
    while (timestamps.length && now - timestamps[0] >= apiKeyValidationWindowMs) timestamps.shift();
    if (timestamps.length === 0) apiKeyValidationAttemptsByGuild.delete(guildId);
  }
}

function reserveApiKeyValidation(guildId, now = Date.now()) {
  const guildKey = String(guildId);
  pruneApiKeyValidationAttempts(now);
  if (apiKeyOperations.has(guildKey)) return { allowed: false, reason: 'in_flight' };
  if (apiKeyValidationsInFlight >= apiKeyValidationGlobalConcurrent) {
    return { allowed: false, reason: 'global_concurrent' };
  }
  const guildAttempts = apiKeyValidationAttemptsByGuild.get(guildKey) ?? [];
  if (guildAttempts.length >= apiKeyValidationGuildMax
    || apiKeyValidationGlobalAttempts.length >= apiKeyValidationGlobalMax) {
    return { allowed: false, reason: 'rate_limited' };
  }

  guildAttempts.push(now);
  apiKeyValidationGlobalAttempts.push(now);
  apiKeyValidationAttemptsByGuild.set(guildKey, guildAttempts);
  apiKeyValidationsInFlight += 1;
  return { allowed: true, token: beginApiKeyOperation(guildKey), guildId: guildKey };
}

function releaseApiKeyValidation(reservation) {
  if (!reservation?.allowed) return;
  apiKeyValidationsInFlight = Math.max(0, apiKeyValidationsInFlight - 1);
  finishApiKeyOperation(reservation.guildId, reservation.token);
}

function resetApiKeyValidationState() {
  apiKeyOperations.clear();
  apiKeyValidationAttemptsByGuild.clear();
  apiKeyValidationGlobalAttempts.splice(0, apiKeyValidationGlobalAttempts.length);
  apiKeyValidationsInFlight = 0;
}

const personaOptions = Object.freeze({
  profanity: Object.freeze([
    { label: 'Very strict', value: 'strict', description: 'No profanity or slurs.' },
    { label: 'Casual', value: 'casual', description: 'Natural swearing, but no slurs.' },
    { label: 'Let it rip', value: 'unfiltered', description: 'Strong language, with a no-targeted-hate floor.' },
  ]),
  textStyle: Object.freeze([
    { label: 'Normal text', value: 'normal', description: 'No whole-message wrapper.' },
    { label: 'Bold', value: 'bold', description: 'Thicker Discord text.' },
    { label: 'Italic', value: 'italic', description: 'Slanted Discord text.' },
    { label: 'Underline', value: 'underline', description: 'Underlined Discord text.' },
    { label: 'Strikethrough', value: 'strikethrough', description: 'Crossed-out Discord text.' },
    { label: 'Spoiler', value: 'spoiler', description: 'Hidden until clicked.' },
    { label: 'Code block', value: 'codeblock', description: 'Monospaced text in a block.' },
  ]),
  responseFormat: Object.freeze([
    { label: 'Normal message', value: 'text', description: 'Send regular Discord messages.' },
    { label: 'Embed', value: 'embed', description: 'Send responses in an embed.' },
  ]),
});

const advancedOptions = Object.freeze({
  webSearchMode: Object.freeze([
    { label: 'Off', value: 'off', description: 'Never search the web.' },
    { label: 'Only when asked', value: 'on_request', description: 'Search only for explicit requests.' },
    { label: 'Automatic', value: 'automatic', description: 'Also search for current or time-sensitive questions.' },
  ]),
  responseLength: Object.freeze([
    { label: 'Brief', value: 'brief', description: 'Compact answers.' },
    { label: 'Balanced', value: 'balanced', description: 'Normal conversational detail.' },
    { label: 'Detailed', value: 'detailed', description: 'Longer, more thorough answers.' },
  ]),
  contextMessages: Object.freeze([
    { label: 'No passive context', value: '0', description: 'Only the current request is sent.' },
    { label: '5 messages', value: '5', description: 'Very short channel memory.' },
    { label: '10 messages', value: '10', description: 'Balanced channel memory.' },
    { label: '20 messages', value: '20', description: 'More continuity and token usage.' },
  ]),
  cooldownSeconds: Object.freeze([
    { label: 'No extra cooldown', value: '0', description: 'Hard anti-abuse limits still apply.' },
    { label: '5 seconds', value: '5', description: 'Recommended for most servers.' },
    { label: '15 seconds', value: '15', description: 'Lower API usage.' },
    { label: '30 seconds', value: '30', description: 'Strict per-user pacing.' },
  ]),
});

function withSelectedOption(options, selectedValue) {
  return options.map((option) => ({
    ...option,
    default: option.value === String(selectedValue),
  }));
}

function buildSaveCancelRow(saveId, cancelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(saveId).setLabel('Save').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
}

function setTextInputValue(input, value) {
  const text = String(value ?? '');
  if (text) {
    input.setValue(text);
  }
  return input;
}

function buildPersonaModal(config) {
  const persona = config?.persona ?? {};
  const characterInput = setTextInputValue(
    new TextInputBuilder()
      .setCustomId(setupCustomIds.personaCharacter)
      .setLabel('Who should I role-play as?')
      .setPlaceholder('Type a character name, or type ai')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(personaLimits.characterNameMin)
      .setMaxLength(personaLimits.characterNameMax),
    persona.characterName,
  );
  const behaviorInput = setTextInputValue(
    new TextInputBuilder()
      .setCustomId(setupCustomIds.personaBehavior)
      .setLabel('Character behavior (100+ characters)')
      .setPlaceholder('Describe voice, attitude, honesty, humor, boundaries, and conversational style.')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMinLength(personaLimits.behaviorMin)
      .setMaxLength(personaLimits.behaviorMax),
    persona.behavior,
  );
  const promptInput = setTextInputValue(
    new TextInputBuilder()
      .setCustomId(setupCustomIds.personaPrompt)
      .setLabel('Custom prompt (optional)')
      .setPlaceholder('Add any other server-specific instructions.')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(personaLimits.customPromptMax),
    persona.customPrompt,
  );
  const triggerInput = setTextInputValue(
    new TextInputBuilder()
      .setCustomId(setupCustomIds.personaTrigger)
      .setLabel('Wake word')
      .setPlaceholder('ai')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(personaLimits.triggerWordMin)
      .setMaxLength(personaLimits.triggerWordMax),
    persona.triggerWord || 'ai',
  );

  return new ModalBuilder()
    .setCustomId(setupCustomIds.personaModal)
    .setTitle('Configure the AI persona')
    .addComponents(
      new ActionRowBuilder().addComponents(characterInput),
      new ActionRowBuilder().addComponents(behaviorInput),
      new ActionRowBuilder().addComponents(promptInput),
      new ActionRowBuilder().addComponents(triggerInput),
    );
}

function buildPersonaOptionsMessage(values, notice = '') {
  const profanity = new StringSelectMenuBuilder()
    .setCustomId(setupCustomIds.personaProfanity)
    .setPlaceholder('Choose profanity behavior')
    .setMinValues(1)
    .setMaxValues(1)
    .setOptions(withSelectedOption(personaOptions.profanity, values.profanity));
  const textStyle = new StringSelectMenuBuilder()
    .setCustomId(setupCustomIds.personaStyle)
    .setPlaceholder('Choose a Discord text style')
    .setMinValues(1)
    .setMaxValues(1)
    .setOptions(withSelectedOption(personaOptions.textStyle, values.textStyle));
  const responseFormat = new StringSelectMenuBuilder()
    .setCustomId(setupCustomIds.personaFormat)
    .setPlaceholder('Choose normal messages or embeds')
    .setMinValues(1)
    .setMaxValues(1)
    .setOptions(withSelectedOption(personaOptions.responseFormat, values.responseFormat));

  return {
    content: [
      notice,
      '**Persona details are ready.** Choose how language and replies should look, then save.',
      '“Let it rip” permits strong language, but the bot will still avoid targeted hate, threats, and protected-class slurs.',
    ].filter(Boolean).join('\n'),
    embeds: [],
    components: [
      new ActionRowBuilder().addComponents(profanity),
      new ActionRowBuilder().addComponents(textStyle),
      new ActionRowBuilder().addComponents(responseFormat),
      buildSaveCancelRow(setupCustomIds.personaSave, setupCustomIds.personaCancel),
    ],
    allowedMentions: blockedAllowedMentions,
  };
}

function buildAccessMessage(values, notice = '') {
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(setupCustomIds.accessChannels)
    .setPlaceholder('Channels where the bot can read and reply')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(1)
    .setMaxValues(25);
  if (values.channelIds?.length) {
    channelSelect.setDefaultChannels(...values.channelIds.slice(0, 25));
  }

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(setupCustomIds.accessRoles)
    .setPlaceholder('Roles allowed to use the bot (empty = everyone)')
    .setMinValues(0)
    .setMaxValues(25);
  if (values.allowedRoleIds?.length) {
    roleSelect.setDefaultRoles(...values.allowedRoleIds.slice(0, 25));
  }

  const blockedRoleSelect = new RoleSelectMenuBuilder()
    .setCustomId(setupCustomIds.accessBlockedRoles)
    .setPlaceholder('Roles the bot must ignore (empty = none)')
    .setMinValues(0)
    .setMaxValues(25);
  if (values.blockedRoleIds?.length) {
    blockedRoleSelect.setDefaultRoles(...values.blockedRoleIds.slice(0, 25));
  }

  return {
    content: [
      notice,
      '**Choose where and for whom I work.** Blocked roles always override allowed roles.',
      'I completely ignore other channels and blocked members, including for conversation context.',
    ].filter(Boolean).join('\n'),
    embeds: [],
    components: [
      new ActionRowBuilder().addComponents(channelSelect),
      new ActionRowBuilder().addComponents(roleSelect),
      new ActionRowBuilder().addComponents(blockedRoleSelect),
      buildSaveCancelRow(setupCustomIds.accessSave, setupCustomIds.accessCancel),
    ],
    allowedMentions: blockedAllowedMentions,
  };
}

function buildApiKeyInstructionsMessage(hasApiKey = false) {
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('Bring your API key')
    .setDescription([
      '1. Open the API console and add a balance.',
      '2. Create or copy an API key.',
      '3. Return here and press **Paste API key**.',
      '',
      'Your key is submitted privately, encrypted immediately, and never shown again. Discord modal inputs are not masked, so do not share screenshots.',
      hasApiKey ? '\n✅ This server already has a stored key. Pasting another one replaces it only after validation.' : '',
    ].filter(Boolean).join('\n'));
  const buttons = [
    new ButtonBuilder()
      .setLabel('Open API console')
      .setStyle(ButtonStyle.Link)
      .setURL('https://platform.deepseek.com/api_keys'),
    new ButtonBuilder()
      .setCustomId(setupCustomIds.apiKeyPaste)
      .setLabel(hasApiKey ? 'Replace API key' : 'Paste API key')
      .setStyle(ButtonStyle.Success),
  ];
  if (hasApiKey) {
    buttons.push(new ButtonBuilder()
      .setCustomId(setupCustomIds.apiKeyRemove)
      .setLabel('Remove stored key')
      .setStyle(ButtonStyle.Danger));
  }

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(...buttons)],
    allowedMentions: blockedAllowedMentions,
    ephemeral: true,
  };
}

function buildApiKeyModal() {
  const keyInput = new TextInputBuilder()
    .setCustomId(setupCustomIds.apiKeyValue)
    .setLabel('API key (never shown again)')
    .setPlaceholder('sk-...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(20)
    .setMaxLength(256);
  return new ModalBuilder()
    .setCustomId(setupCustomIds.apiKeyModal)
    .setTitle('Connect your API key')
    .addComponents(new ActionRowBuilder().addComponents(keyInput));
}

function buildAdvancedMessage(values, searchAvailable = isWebSearchConfigured(), notice = '') {
  const webSearch = new StringSelectMenuBuilder()
    .setCustomId(setupCustomIds.advancedWebSearch)
    .setPlaceholder('Choose web-search behavior')
    .setMinValues(1)
    .setMaxValues(1)
    .setOptions(withSelectedOption(advancedOptions.webSearchMode, values.webSearchMode));
  const responseLength = new StringSelectMenuBuilder()
    .setCustomId(setupCustomIds.advancedLength)
    .setPlaceholder('Choose answer length')
    .setMinValues(1)
    .setMaxValues(1)
    .setOptions(withSelectedOption(advancedOptions.responseLength, values.responseLength));
  const context = new StringSelectMenuBuilder()
    .setCustomId(setupCustomIds.advancedContext)
    .setPlaceholder('Choose channel-context depth')
    .setMinValues(1)
    .setMaxValues(1)
    .setOptions(withSelectedOption(advancedOptions.contextMessages, values.contextMessages));
  const cooldown = new StringSelectMenuBuilder()
    .setCustomId(setupCustomIds.advancedCooldown)
    .setPlaceholder('Choose a per-user cooldown')
    .setMinValues(1)
    .setMaxValues(1)
    .setOptions(withSelectedOption(advancedOptions.cooldownSeconds, values.cooldownSeconds));

  return {
    content: [
      notice,
      '**More settings**',
      searchAvailable
        ? 'Web search is available through the bot host’s fixed, allowlisted provider.'
        : 'Web search is not configured by the bot host yet; keep it Off for now.',
      'No guild-provided MCP URLs are accepted, which prevents arbitrary network or tool access.',
    ].filter(Boolean).join('\n'),
    embeds: [],
    components: [
      new ActionRowBuilder().addComponents(webSearch),
      new ActionRowBuilder().addComponents(responseLength),
      new ActionRowBuilder().addComponents(context),
      new ActionRowBuilder().addComponents(cooldown),
      buildSaveCancelRow(setupCustomIds.advancedSave, setupCustomIds.advancedCancel),
    ],
    allowedMentions: blockedAllowedMentions,
  };
}

function getModalValue(interaction, customId) {
  return String(interaction.fields.getTextInputValue(customId) ?? '').trim();
}

function getPersonaValidationError(values) {
  if (values.characterName.length < personaLimits.characterNameMin || values.characterName.length > personaLimits.characterNameMax) {
    return `The character name must be ${personaLimits.characterNameMin}-${personaLimits.characterNameMax} characters.`;
  }
  if (values.behavior.length < personaLimits.behaviorMin || values.behavior.length > personaLimits.behaviorMax) {
    return `Character behavior must be ${personaLimits.behaviorMin}-${personaLimits.behaviorMax} characters.`;
  }
  if (values.customPrompt.length > personaLimits.customPromptMax) {
    return `The custom prompt cannot exceed ${personaLimits.customPromptMax} characters.`;
  }
  if (values.triggerWord.length < personaLimits.triggerWordMin || values.triggerWord.length > personaLimits.triggerWordMax) {
    return `The wake word must be ${personaLimits.triggerWordMin}-${personaLimits.triggerWordMax} characters.`;
  }
  if (/\r|\n|<@|<#|@everyone|@here/i.test(values.triggerWord)) {
    return 'The wake word cannot contain line breaks, mentions, @everyone, or @here.';
  }
  return '';
}

function isAllowedOption(options, value) {
  return options.some((option) => option.value === String(value));
}

function getDraftForInteraction(interaction, type) {
  return getSetupDraft(type, interaction.guildId, interaction.user.id);
}

async function expireDraftInteraction(interaction) {
  await interaction.update({
    content: 'This setup form expired. Open the setup panel and try again.',
    embeds: [],
    components: [],
    allowedMentions: blockedAllowedMentions,
  });
}

function getRoleIdsFromDraft(values, field) {
  return [...new Set((values?.[field] ?? []).map(String))].slice(0, 25);
}

function validateAccessDraft(interaction, values) {
  const channelIds = getRoleIdsFromDraft(values, 'channelIds');
  const allowedRoleIds = getRoleIdsFromDraft(values, 'allowedRoleIds');
  const blockedRoleIds = getRoleIdsFromDraft(values, 'blockedRoleIds');
  if (channelIds.length === 0) {
    return { error: 'Select at least one channel.' };
  }

  const botMember = interaction.guild.members?.me;
  for (const channelId of channelIds) {
    const channel = interaction.guild.channels?.cache?.get?.(channelId);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
      return { error: 'One of the selected channels no longer exists or is not a text channel.' };
    }
    const permissions = botMember && channel.permissionsFor?.(botMember);
    if (!permissions?.has?.([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.EmbedLinks,
    ])) {
      return { error: `I need View Channel, Send Messages, Read Message History, and Embed Links in #${channel.name}.` };
    }
  }

  for (const roleId of [...allowedRoleIds, ...blockedRoleIds]) {
    if (!interaction.guild.roles?.cache?.has?.(roleId)) {
      return { error: 'One of the selected roles no longer exists.' };
    }
  }
  if (blockedRoleIds.includes(interaction.guild.id)) {
    return { error: 'The @everyone role cannot be blocked. Remove channel access instead if you want to disable the bot.' };
  }

  return {
    values: {
      channelIds,
      allowedRoleIds: allowedRoleIds.includes(interaction.guild.id) ? [] : allowedRoleIds,
      blockedRoleIds,
    },
  };
}

async function updatePanelWithoutLeakingErrors(interaction, store) {
  try {
    await refreshSetupPanel(interaction.guild, store);
  } catch (error) {
    console.error('Could not refresh setup panel.', {
      name: error?.name,
      message: error?.message,
      guildId: interaction.guildId,
    });
  }
}

async function denySetupInteraction(interaction) {
  const options = {
    content: 'Only the server owner or an administrator can change this bot’s setup.',
    ephemeral: true,
    allowedMentions: blockedAllowedMentions,
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(options);
  } else {
    await interaction.reply(options);
  }
}

function isSetupInteraction(interaction) {
  return typeof interaction?.customId === 'string' && interaction.customId.startsWith('setup:');
}

async function handlePersonaInteraction(interaction, store) {
  const id = interaction.customId;
  if (id === setupCustomIds.personaOpen && interaction.isButton?.()) {
    await interaction.showModal(buildPersonaModal(await store.get(interaction.guildId)));
    return true;
  }

  if (id === setupCustomIds.personaModal && interaction.isModalSubmit?.()) {
    const existing = (await store.get(interaction.guildId)).persona;
    const values = {
      ...existing,
      characterName: getModalValue(interaction, setupCustomIds.personaCharacter),
      behavior: getModalValue(interaction, setupCustomIds.personaBehavior),
      customPrompt: getModalValue(interaction, setupCustomIds.personaPrompt),
      triggerWord: getModalValue(interaction, setupCustomIds.personaTrigger),
    };
    const validationError = getPersonaValidationError(values);
    if (validationError) {
      await interaction.reply({ content: validationError, ephemeral: true, allowedMentions: blockedAllowedMentions });
      return true;
    }
    createSetupDraft(draftTypes.persona, interaction.guildId, interaction.user.id, values);
    await interaction.reply({ ...buildPersonaOptionsMessage(values), ephemeral: true });
    return true;
  }

  const personaSelectMap = {
    [setupCustomIds.personaProfanity]: ['profanity', personaOptions.profanity],
    [setupCustomIds.personaStyle]: ['textStyle', personaOptions.textStyle],
    [setupCustomIds.personaFormat]: ['responseFormat', personaOptions.responseFormat],
  };
  if (personaSelectMap[id] && interaction.isStringSelectMenu?.()) {
    const draft = getDraftForInteraction(interaction, draftTypes.persona);
    if (!draft) {
      await expireDraftInteraction(interaction);
      return true;
    }
    const [field, options] = personaSelectMap[id];
    const value = interaction.values?.[0];
    if (!isAllowedOption(options, value)) {
      await interaction.reply({ content: 'That option is not valid.', ephemeral: true, allowedMentions: blockedAllowedMentions });
      return true;
    }
    const updated = updateSetupDraft(draftTypes.persona, interaction.guildId, interaction.user.id, { [field]: value });
    await interaction.update(buildPersonaOptionsMessage(updated.values, 'Selection updated.'));
    return true;
  }

  if (id === setupCustomIds.personaSave && interaction.isButton?.()) {
    const draft = getDraftForInteraction(interaction, draftTypes.persona);
    if (!draft) {
      await expireDraftInteraction(interaction);
      return true;
    }
    const validationError = getPersonaValidationError(draft.values);
    if (validationError) {
      await interaction.update(buildPersonaOptionsMessage(draft.values, validationError));
      return true;
    }
    await store.update(interaction.guildId, (config) => ({ ...config, persona: draft.values }), interaction.user.id);
    resetGuildConversations(interaction.guildId);
    resetGuildConversationQueues(interaction.guildId);
    deleteSetupDraft(draftTypes.persona, interaction.guildId, interaction.user.id);
    await interaction.update({ content: '✅ Persona settings saved.', embeds: [], components: [], allowedMentions: blockedAllowedMentions });
    await updatePanelWithoutLeakingErrors(interaction, store);
    return true;
  }

  if (id === setupCustomIds.personaCancel && interaction.isButton?.()) {
    deleteSetupDraft(draftTypes.persona, interaction.guildId, interaction.user.id);
    await interaction.update({ content: 'Persona changes cancelled.', embeds: [], components: [], allowedMentions: blockedAllowedMentions });
    return true;
  }

  return false;
}

async function handleAccessInteraction(interaction, store) {
  const id = interaction.customId;
  if (id === setupCustomIds.accessOpen && interaction.isButton?.()) {
    const savedAccess = (await store.get(interaction.guildId)).access;
    const values = {
      channelIds: savedAccess.channelIds.filter((channelId) => interaction.guild.channels?.cache?.has?.(channelId)),
      allowedRoleIds: savedAccess.allowedRoleIds.filter((roleId) => interaction.guild.roles?.cache?.has?.(roleId)),
      blockedRoleIds: savedAccess.blockedRoleIds.filter((roleId) => interaction.guild.roles?.cache?.has?.(roleId)),
    };
    createSetupDraft(draftTypes.access, interaction.guildId, interaction.user.id, values);
    await interaction.reply({ ...buildAccessMessage(values), ephemeral: true });
    return true;
  }

  const accessSelectMap = {
    [setupCustomIds.accessChannels]: 'channelIds',
    [setupCustomIds.accessRoles]: 'allowedRoleIds',
    [setupCustomIds.accessBlockedRoles]: 'blockedRoleIds',
  };
  if (accessSelectMap[id] && (interaction.isChannelSelectMenu?.() || interaction.isRoleSelectMenu?.())) {
    const draft = getDraftForInteraction(interaction, draftTypes.access);
    if (!draft) {
      await expireDraftInteraction(interaction);
      return true;
    }
    const field = accessSelectMap[id];
    const values = [...new Set((interaction.values ?? []).map(String))].slice(0, 25);
    const updated = updateSetupDraft(draftTypes.access, interaction.guildId, interaction.user.id, { [field]: values });
    await interaction.update(buildAccessMessage(updated.values, 'Selection updated.'));
    return true;
  }

  if (id === setupCustomIds.accessSave && interaction.isButton?.()) {
    const draft = getDraftForInteraction(interaction, draftTypes.access);
    if (!draft) {
      await expireDraftInteraction(interaction);
      return true;
    }
    const validation = validateAccessDraft(interaction, draft.values);
    if (validation.error) {
      await interaction.update(buildAccessMessage(draft.values, validation.error));
      return true;
    }
    await store.update(interaction.guildId, (config) => ({ ...config, access: validation.values }), interaction.user.id);
    resetGuildConversations(interaction.guildId);
    resetGuildConversationQueues(interaction.guildId);
    deleteGuildIdleChatterState(interaction.guildId);
    deleteSetupDraft(draftTypes.access, interaction.guildId, interaction.user.id);
    await interaction.update({ content: '✅ Channel and role access saved. Old channel context was cleared.', embeds: [], components: [], allowedMentions: blockedAllowedMentions });
    await updatePanelWithoutLeakingErrors(interaction, store);
    return true;
  }

  if (id === setupCustomIds.accessCancel && interaction.isButton?.()) {
    deleteSetupDraft(draftTypes.access, interaction.guildId, interaction.user.id);
    await interaction.update({ content: 'Channel and role changes cancelled.', embeds: [], components: [], allowedMentions: blockedAllowedMentions });
    return true;
  }

  return false;
}

async function handleApiKeyInteraction(interaction, store, dependencies = {}) {
  const id = interaction.customId;
  if (id === setupCustomIds.apiKeyOpen && interaction.isButton?.()) {
    await interaction.reply(buildApiKeyInstructionsMessage(await store.hasApiKey(interaction.guildId)));
    return true;
  }

  if (id === setupCustomIds.apiKeyPaste && interaction.isButton?.()) {
    await interaction.showModal(buildApiKeyModal());
    return true;
  }

  if (id === setupCustomIds.apiKeyRemove && interaction.isButton?.()) {
    const operationToken = beginApiKeyOperation(interaction.guildId);
    try {
      await store.clearApiKey(interaction.guildId, interaction.user.id);
      resetGuildConversationQueues(interaction.guildId);
      await interaction.update({ content: 'The stored API key was removed.', embeds: [], components: [], allowedMentions: blockedAllowedMentions });
      await updatePanelWithoutLeakingErrors(interaction, store);
    } finally {
      finishApiKeyOperation(interaction.guildId, operationToken);
    }
    return true;
  }

  if (id === setupCustomIds.apiKeyModal && interaction.isModalSubmit?.()) {
    const apiKey = getModalValue(interaction, setupCustomIds.apiKeyValue);
    if (!/^sk-[!-~]{17,252}$/.test(apiKey) || /\s/.test(apiKey)) {
      await interaction.reply({ content: 'That API key format is invalid. Copy a fresh key from the API console and try again.', ephemeral: true, allowedMentions: blockedAllowedMentions });
      return true;
    }

    const validationReservation = reserveApiKeyValidation(interaction.guildId);
    if (!validationReservation.allowed) {
      await interaction.reply({
        content: validationReservation.reason === 'in_flight'
          ? 'An API key is already being checked for this server. Wait for it to finish.'
          : 'Too many API keys are being checked right now. Please try again shortly.',
        ephemeral: true,
        allowedMentions: blockedAllowedMentions,
      });
      return true;
    }

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (error) {
      releaseApiKeyValidation(validationReservation);
      throw error;
    }
    const operationToken = validationReservation.token;
    let keyWasStored = false;
    try {
      const result = await (dependencies.validateApiKeyBalance ?? validateApiKeyBalance)(apiKey, {
        fetchImpl: dependencies.fetchImpl,
      });
      if (!isCurrentApiKeyOperation(interaction.guildId, operationToken)) {
        await interaction.editReply({ content: 'A newer API key change replaced this request, so this key was not stored.', allowedMentions: blockedAllowedMentions });
        return true;
      }
      const keyStatus = result.hasBalance ? 'valid' : 'no_balance';
      await store.setApiKey(interaction.guildId, apiKey, keyStatus, interaction.user.id);
      resetGuildConversationQueues(interaction.guildId);
      keyWasStored = true;
      if (result.hasBalance) {
        await interaction.editReply({ content: '✅ API key connected. If the other required sections are complete, you can start chatting now.', allowedMentions: blockedAllowedMentions });
      } else {
        await interaction.editReply({ content: 'My bot has no balance. Please add your balance to the API console.', allowedMentions: blockedAllowedMentions });
      }
      await updatePanelWithoutLeakingErrors(interaction, store);
    } catch (error) {
      if (keyWasStored) {
        throw error;
      }
      if (!isCurrentApiKeyOperation(interaction.guildId, operationToken)) {
        await interaction.editReply({ content: 'A newer API key change replaced this request, so this key was not stored.', allowedMentions: blockedAllowedMentions });
        return true;
      }
      if (error instanceof ConfigEncryptionError) {
        await interaction.editReply({ content: 'Secure key storage is not configured on this bot host. Ask the bot operator to set CONFIG_ENCRYPTION_KEY and restart it.', allowedMentions: blockedAllowedMentions });
      } else if (error instanceof DeepSeekApiError && error.status === 401) {
        await interaction.editReply({ content: 'That API key is invalid. Copy a fresh key from the API console and try again.', allowedMentions: blockedAllowedMentions });
      } else {
        await interaction.editReply({ content: 'I could not validate that key right now, so I did not store it. Please try again shortly.', allowedMentions: blockedAllowedMentions });
      }
    } finally {
      releaseApiKeyValidation(validationReservation);
    }
    return true;
  }

  return false;
}

async function handleAdvancedInteraction(interaction, store) {
  const id = interaction.customId;
  if (id === setupCustomIds.advancedOpen && interaction.isButton?.()) {
    const values = (await store.get(interaction.guildId)).advanced;
    createSetupDraft(draftTypes.advanced, interaction.guildId, interaction.user.id, values);
    await interaction.reply({ ...buildAdvancedMessage(values), ephemeral: true });
    return true;
  }

  const advancedSelectMap = {
    [setupCustomIds.advancedWebSearch]: ['webSearchMode', advancedOptions.webSearchMode, String],
    [setupCustomIds.advancedLength]: ['responseLength', advancedOptions.responseLength, String],
    [setupCustomIds.advancedContext]: ['contextMessages', advancedOptions.contextMessages, Number],
    [setupCustomIds.advancedCooldown]: ['cooldownSeconds', advancedOptions.cooldownSeconds, Number],
  };
  if (advancedSelectMap[id] && interaction.isStringSelectMenu?.()) {
    const draft = getDraftForInteraction(interaction, draftTypes.advanced);
    if (!draft) {
      await expireDraftInteraction(interaction);
      return true;
    }
    const [field, options, convert] = advancedSelectMap[id];
    const rawValue = interaction.values?.[0];
    if (!isAllowedOption(options, rawValue)) {
      await interaction.reply({ content: 'That option is not valid.', ephemeral: true, allowedMentions: blockedAllowedMentions });
      return true;
    }
    const updated = updateSetupDraft(draftTypes.advanced, interaction.guildId, interaction.user.id, { [field]: convert(rawValue) });
    await interaction.update(buildAdvancedMessage(updated.values, isWebSearchConfigured(), 'Selection updated.'));
    return true;
  }

  if (id === setupCustomIds.advancedSave && interaction.isButton?.()) {
    const draft = getDraftForInteraction(interaction, draftTypes.advanced);
    if (!draft) {
      await expireDraftInteraction(interaction);
      return true;
    }
    if (draft.values.webSearchMode !== 'off' && !isWebSearchConfigured()) {
      await interaction.update(buildAdvancedMessage(draft.values, false, 'Web search is not available on this bot host yet. Choose Off before saving.'));
      return true;
    }
    const previousAdvanced = (await store.get(interaction.guildId)).advanced;
    await store.update(interaction.guildId, (config) => ({ ...config, advanced: draft.values }), interaction.user.id);
    if (previousAdvanced.contextMessages !== draft.values.contextMessages) {
      resetGuildConversations(interaction.guildId);
      resetGuildConversationQueues(interaction.guildId);
    }
    deleteSetupDraft(draftTypes.advanced, interaction.guildId, interaction.user.id);
    await interaction.update({ content: '✅ Advanced settings saved.', embeds: [], components: [], allowedMentions: blockedAllowedMentions });
    await updatePanelWithoutLeakingErrors(interaction, store);
    return true;
  }

  if (id === setupCustomIds.advancedCancel && interaction.isButton?.()) {
    deleteSetupDraft(draftTypes.advanced, interaction.guildId, interaction.user.id);
    await interaction.update({ content: 'Advanced changes cancelled.', embeds: [], components: [], allowedMentions: blockedAllowedMentions });
    return true;
  }

  return false;
}

async function handleSetupInteraction(interaction, store, dependencies = {}) {
  if (!isSetupInteraction(interaction)) {
    return false;
  }
  if (!isGuildOwnerOrAdministrator(interaction)) {
    await denySetupInteraction(interaction);
    return true;
  }

  if (await handlePersonaInteraction(interaction, store)) return true;
  if (await handleAccessInteraction(interaction, store)) return true;
  if (await handleApiKeyInteraction(interaction, store, dependencies)) return true;
  if (await handleAdvancedInteraction(interaction, store)) return true;

  await interaction.reply({ content: 'That setup control is no longer valid. Open the latest setup panel and try again.', ephemeral: true, allowedMentions: blockedAllowedMentions });
  return true;
}

function createSetupInteractionHandler(store, dependencies = {}) {
  return async function onInteractionCreate(interaction) {
    if (!isSetupInteraction(interaction)) {
      return;
    }
    try {
      await handleSetupInteraction(interaction, store, dependencies);
    } catch (error) {
      console.error('Setup interaction failed.', {
        name: error?.name,
        message: error?.message,
        guildId: interaction.guildId,
        customId: interaction.customId,
      });
      const options = {
        content: 'Something went wrong while saving that setting. No API key or private input was logged.',
        ephemeral: true,
        allowedMentions: blockedAllowedMentions,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(options).catch(() => null);
      } else {
        await interaction.reply(options).catch(() => null);
      }
    }
  };
}

module.exports = {
  advancedOptions,
  beginApiKeyOperation,
  cancelGuildApiKeyOperation,
  buildAccessMessage,
  buildAdvancedMessage,
  buildApiKeyInstructionsMessage,
  buildApiKeyModal,
  buildPersonaModal,
  buildPersonaOptionsMessage,
  createSetupInteractionHandler,
  draftTypes,
  getPersonaValidationError,
  handleSetupInteraction,
  isSetupInteraction,
  isCurrentApiKeyOperation,
  personaOptions,
  releaseApiKeyValidation,
  resetApiKeyValidationState,
  reserveApiKeyValidation,
  validateAccessDraft,
};
