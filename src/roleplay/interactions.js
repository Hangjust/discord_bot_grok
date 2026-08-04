const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle } = require('discord.js');
const { blockedAllowedMentions } = require('../config/constants');
const { sanitizeDiscordMentions } = require('../discord/mentions');
const { closeRoleplayTicketChannel } = require('./close');
const { buildRoleplayModalCustomId, buildRoleplayPromptButtonCustomId, getRoleplayLevel, getRoleplayPrompt, normalizeRoleplayImprovedAiInput, normalizeRoleplayLevelInput, normalizeRoleplayPromptInput, parseRoleplayModalCustomId, parseRoleplayPromptButtonCustomId, roleplayCloseCommand, roleplayCustomIds, roleplayCustomPromptId, roleplayDefaultLevelId, roleplayPrompts, roleplayTicketParentChannelId } = require('./config');
const { buildRoleplayOpeningUserText, generateRoleplayReply } = require('./deepseek');
const { getRoleplayCreationRateLimitMessage, getRoleplayTicketReopenCooldownMessage, isRoleplayTicketCreationRateLimited, isRoleplayTicketReopenCooldownActive, isRoleplayTicketReopenCooldownEnabled, recordRoleplayTicketCreation } = require('./rateLimit');
const { maxRoleplayResponseCharacters, sendRoleplayChunks } = require('./replies');
const { appendRoleplayAssistantMessage, getRoleplaySession, getRoleplaySessionKey, resetRoleplaySession } = require('./sessions');
const { buildRoleplayTicketTopic, canRegisterRoleplayTicket, createRoleplayTicketMetadata, getOpenRoleplayTicketForUser, recognizeRoleplayTicketChannel, registerRoleplayTicket } = require('./tickets');
const { logRoleplayError } = require('./logging');
function buildRoleplayCloseButtonRow() { return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(roleplayCustomIds.closeButton).setLabel('Close RP').setStyle(ButtonStyle.Danger)); }
function buildRoleplayPromptChoiceMessage() {
  const promptButtons = roleplayPrompts.map((prompt) => new ButtonBuilder().setCustomId(buildRoleplayPromptButtonCustomId(prompt.id)).setLabel(prompt.label).setStyle(ButtonStyle.Secondary));
  const customButton = new ButtonBuilder().setCustomId(buildRoleplayPromptButtonCustomId(roleplayCustomPromptId)).setLabel('Custom').setStyle(ButtonStyle.Primary);
  return { content: `RP prompt: ${roleplayPrompts.map((prompt) => prompt.label).join(', ')}, or Custom`, components: [new ActionRowBuilder().addComponents(...promptButtons, customButton)], allowedMentions: blockedAllowedMentions, ephemeral: true };
}
function buildRoleplayOpenModal(promptId = roleplayCustomPromptId) {
  const prompt = getRoleplayPrompt(promptId);
  const title = prompt ? `Open ${prompt.label} RP` : 'Open Custom RP';
  const personInput = new TextInputBuilder().setCustomId(roleplayCustomIds.personNameInput).setLabel('Name of the person').setPlaceholder('Who should the AI roleplay as?').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100);
  const promptInput = new TextInputBuilder().setCustomId(roleplayCustomIds.promptInput).setLabel('Custom roleplay idea').setPlaceholder('Describe your custom setup').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500);
  const contextInput = new TextInputBuilder().setCustomId(roleplayCustomIds.promptInput).setLabel('Add context').setPlaceholder('Optional scenery, vibe, situation, or details').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500);
  const improvedAiInput = new TextInputBuilder().setCustomId(roleplayCustomIds.improvedAiInput).setLabel('Improved AI (yes/no)').setPlaceholder('Type yes to expand custom ideas into richer RP setups').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10);
  const levelInput = new TextInputBuilder().setCustomId(roleplayCustomIds.levelInput).setLabel('RP level').setPlaceholder('Cozy, Adventure, or Dramatic').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20);
  const rows = [new ActionRowBuilder().addComponents(personInput)];
  if (prompt) rows.push(new ActionRowBuilder().addComponents(contextInput));
  else rows.push(new ActionRowBuilder().addComponents(promptInput), new ActionRowBuilder().addComponents(improvedAiInput), new ActionRowBuilder().addComponents(levelInput));
  return new ModalBuilder().setCustomId(buildRoleplayModalCustomId(promptId)).setTitle(title).addComponents(...rows);
}
function buildRoleplayClosePanelMessage(ticket, level) {
  const personName = sanitizeDiscordMentions(ticket.personName || 'your partner');
  const promptText = sanitizeDiscordMentions(ticket.promptText || 'custom RP');
  const levelText = ticket.promptId === roleplayCustomPromptId ? ` (${level.label})` : '';
  return {
    content: sanitizeDiscordMentions(`Welcome to RP with ${personName}. Prompt: ${promptText}${levelText}. Start roleplaying here. Use \`${roleplayCloseCommand}\` or the button below when you want me to stop in this ticket.`),
    embeds: [new EmbedBuilder().setTitle('Close RP').setDescription('Press the button below to stop the RP bot in this ticket and mark the ticket closed.').setColor(0xe74c3c)],
    components: [buildRoleplayCloseButtonRow()],
    allowedMentions: blockedAllowedMentions,
  };
}
function buildTicketChannelName(user) { const baseName = String(user?.username ?? user?.globalName ?? 'player').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'player'; return `roleplay-${baseName}`; }
function getModalTextInput(interaction, customId) { return String(interaction.fields?.getTextInputValue?.(customId) ?? '').trim(); }
function formatRoleplayTextBlock(lines) {
  const content = lines.map(([label, value]) => `${label}: ${String(value || 'None').replace(/```/g, '``\u200b`')}`).join('\n');
  return { content: sanitizeDiscordMentions(`\`\`\`text\n${content}\n\`\`\``), allowedMentions: blockedAllowedMentions };
}
async function sendRoleplayTextBlockChunks(sendChunk, content) {
  const sourceContent = String(content || 'None').replace(/```/g, '``\u200b`');
  const boundedContent = sourceContent.length > maxRoleplayResponseCharacters
    ? `${sourceContent.slice(0, maxRoleplayResponseCharacters - 1)}…`
    : sourceContent;
  const safeContent = sanitizeDiscordMentions(boundedContent);
  const maxChunkLength = 2000 - '```text\n\n```'.length;
  let remaining = safeContent;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, maxChunkLength);
    await sendChunk({ content: `\`\`\`text\n${chunk}\n\`\`\``, allowedMentions: blockedAllowedMentions });
    remaining = remaining.slice(maxChunkLength);
  }
}
function buildRoleplaySetupEchoMessage(ticket, level, addContext = '') {
  if (ticket.promptId === roleplayCustomPromptId) return formatRoleplayTextBlock([['Name', ticket.personName], ['Custom roleplay idea', ticket.promptText], ['Improved AI', ticket.improvedAi ? 'Yes' : 'No'], ['RP level', level.label]]);
  return formatRoleplayTextBlock([['Name', ticket.personName], ['Add context', addContext]]);
}
function buildRoleplayTicketPermissionOverwrites(guild, openerUserId, botUserId) {
  const allow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
  return [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }, { id: openerUserId, allow }, { id: botUserId, allow: [...allow, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.PinMessages] }];
}
function canCreateRoleplayTicket(interaction) { const botMember = interaction.guild?.members?.me; return Boolean(botMember?.permissions?.has?.(PermissionFlagsBits.ManageChannels) && botMember?.permissions?.has?.(PermissionFlagsBits.ManageMessages)); }
async function handleRoleplayInteraction(interaction, options = {}) {
  if (interaction.isButton?.() && interaction.customId === roleplayCustomIds.openButton) {
    await interaction.reply(buildRoleplayPromptChoiceMessage());
    return true;
  }
  if (interaction.isButton?.()) {
    const promptId = parseRoleplayPromptButtonCustomId(interaction.customId);
    if (promptId) { await interaction.showModal(buildRoleplayOpenModal(promptId)); return true; }
  }
  if (interaction.isModalSubmit?.() && parseRoleplayModalCustomId(interaction.customId)) { await createRoleplayTicketFromInteraction(interaction, options); return true; }
  if (interaction.isButton?.() && interaction.customId === roleplayCustomIds.closeButton) { await closeRoleplayTicketFromInteraction(interaction); return true; }
  return false;
}
async function createRoleplayTicketFromInteraction(interaction, options = {}) {
  const selectedPromptId = parseRoleplayModalCustomId(interaction.customId);
  if (!selectedPromptId) { await interaction.reply({ content: 'That roleplay prompt is not available.', ephemeral: true, allowedMentions: blockedAllowedMentions }); return null; }
  const selectedPrompt = getRoleplayPrompt(selectedPromptId);
  const personName = getModalTextInput(interaction, roleplayCustomIds.personNameInput).slice(0, 100);
  const promptInput = getModalTextInput(interaction, roleplayCustomIds.promptInput).slice(0, 500);
  const customPrompt = selectedPrompt ? null : normalizeRoleplayPromptInput(promptInput);
  const promptId = selectedPrompt?.id ?? roleplayCustomPromptId;
  const promptText = selectedPrompt ? [selectedPrompt.label, promptInput ? `Additional context: ${promptInput}` : ''].filter(Boolean).join('\n') : customPrompt.promptText;
  const improvedAi = selectedPrompt ? false : normalizeRoleplayImprovedAiInput(getModalTextInput(interaction, roleplayCustomIds.improvedAiInput));
  const levelId = selectedPrompt ? roleplayDefaultLevelId : normalizeRoleplayLevelInput(getModalTextInput(interaction, roleplayCustomIds.levelInput));
  const level = getRoleplayLevel(levelId);
  if (!interaction.guild) { await interaction.reply({ content: 'That roleplay selection is not available.', ephemeral: true, allowedMentions: blockedAllowedMentions }); return null; }
  if (!level) { await interaction.reply({ content: 'Please choose one RP level: Cozy, Adventure, or Dramatic.', ephemeral: true, allowedMentions: blockedAllowedMentions }); return null; }
  if (!personName || !promptText) { await interaction.reply({ content: selectedPrompt ? 'Please include the person name.' : 'Please include both the person name and custom roleplay prompt.', ephemeral: true, allowedMentions: blockedAllowedMentions }); return null; }
  if (!canCreateRoleplayTicket(interaction)) { await interaction.reply({ content: 'I need Manage Channels and Manage Messages to create private roleplay tickets.', ephemeral: true, allowedMentions: blockedAllowedMentions }); return null; }
  await interaction.deferReply({ ephemeral: true });
  const existingTicket = getOpenRoleplayTicketForUser(interaction.guild.id, interaction.user.id);
  if (existingTicket) { await interaction.editReply({ content: sanitizeDiscordMentions(`You already have an open roleplay ticket here: <#${existingTicket.channelId}>`), allowedMentions: blockedAllowedMentions }); return existingTicket; }
  const creationKey = `${interaction.guild.id}:${interaction.user.id}`;
  if (isRoleplayTicketReopenCooldownEnabled(interaction.guild.id) && isRoleplayTicketReopenCooldownActive(creationKey)) { await interaction.editReply({ content: getRoleplayTicketReopenCooldownMessage(), allowedMentions: blockedAllowedMentions }); return null; }
  if (isRoleplayTicketCreationRateLimited(creationKey)) { await interaction.editReply({ content: getRoleplayCreationRateLimitMessage(), allowedMentions: blockedAllowedMentions }); return null; }
  if (!canRegisterRoleplayTicket(interaction.guild.id)) { await interaction.editReply({ content: 'Roleplay ticket capacity is full right now. Try again later.', allowedMentions: blockedAllowedMentions }); return null; }
  recordRoleplayTicketCreation(creationKey);
  const provisionalTicket = createRoleplayTicketMetadata({ channelId: '', guildId: interaction.guild.id, openerUserId: interaction.user.id, promptId, levelId, personName, promptText, improvedAi });
  let channel;
  try {
    const channelCache = interaction.guild.channels?.cache;
    const configuredParentExists = typeof channelCache?.has !== 'function'
      || channelCache.has(roleplayTicketParentChannelId);
    channel = await interaction.guild.channels.create({
      name: buildTicketChannelName(interaction.user),
      type: ChannelType.GuildText,
      ...(configuredParentExists ? { parent: roleplayTicketParentChannelId } : {}),
      topic: buildRoleplayTicketTopic(provisionalTicket),
      permissionOverwrites: buildRoleplayTicketPermissionOverwrites(
        interaction.guild,
        interaction.user.id,
        interaction.client.user.id,
      ),
    });
  } catch (error) {
    logRoleplayError('Roleplay ticket creation failed.', error, { guildId: interaction.guildId });
    await interaction.editReply({ content: 'I could not create your roleplay ticket channel. Check my channel permissions and the RP parent category.', allowedMentions: blockedAllowedMentions });
    return null;
  }
  let ticket;
  try {
    ticket = registerRoleplayTicket({ ...provisionalTicket, channelId: channel.id });
  } catch (error) {
    logRoleplayError('Roleplay ticket registration failed.', error, { guildId: interaction.guildId, channelId: channel.id });
    await channel.delete?.('Roleplay ticket capacity reached').catch?.(() => null);
    await interaction.editReply({ content: 'Roleplay ticket capacity is full right now. Try again later.', allowedMentions: blockedAllowedMentions });
    return null;
  }
  try {
    if (channel.setTopic) await channel.setTopic(buildRoleplayTicketTopic(ticket));
  } catch (error) {
    logRoleplayError('Roleplay ticket topic update failed.', error, { guildId: interaction.guildId, channelId: channel.id });
  }
  try {
    const openingMessage = await channel.send(buildRoleplayClosePanelMessage(ticket, level));
    try {
      await openingMessage.pin();
    } catch (error) {
      logRoleplayError('Roleplay opening message pin failed.', error, { guildId: interaction.guildId, channelId: channel.id });
    }
  } catch (error) {
    logRoleplayError('Roleplay setup panel delivery failed.', error, { guildId: interaction.guildId, channelId: channel.id });
    await interaction.editReply({ content: sanitizeDiscordMentions(`Your roleplay ticket was created, but I could not post the setup panel. Use this channel to start: <#${channel.id}>`), allowedMentions: blockedAllowedMentions });
    return ticket;
  }
  await channel.send(buildRoleplaySetupEchoMessage(ticket, level, promptInput));
  await interaction.editReply({ content: sanitizeDiscordMentions(`Your roleplay ticket is ready: <#${channel.id}>`), allowedMentions: blockedAllowedMentions });
  const generateOpeningReply = Object.prototype.hasOwnProperty.call(options, 'generateOpeningReply')
    ? options.generateOpeningReply
    : options.apiKey
      ? (text, activeTicket, activeSession) => generateRoleplayReply(
        text,
        activeTicket,
        activeSession,
        options,
      )
      : null;
  if (generateOpeningReply) {
    try {
      const sessionKey = getRoleplaySessionKey({ guildId: ticket.guildId, channelId: ticket.channelId, userId: ticket.openerUserId, ticketId: ticket.ticketId });
      resetRoleplaySession(sessionKey);
      const session = getRoleplaySession(sessionKey);
      const safeReply = sanitizeDiscordMentions(await generateOpeningReply(buildRoleplayOpeningUserText(), ticket, session));
      if (ticket.promptId === roleplayCustomPromptId && ticket.improvedAi) await sendRoleplayTextBlockChunks((messageOptions) => channel.send(messageOptions), safeReply);
      await sendRoleplayChunks((messageOptions) => channel.send(messageOptions), safeReply);
      appendRoleplayAssistantMessage(session, safeReply);
    } catch (error) {
      logRoleplayError('Roleplay opening generation failed.', error, { guildId: interaction.guildId, channelId: channel.id });
      await channel.send({
        content: 'The roleplay narrator could not start yet. An owner or administrator can check the API key with `!setup`, then you can send a message here to try again.',
        allowedMentions: blockedAllowedMentions,
      }).catch(() => null);
    }
  }
  return ticket;
}
async function closeRoleplayTicketFromInteraction(interaction) {
  const recognition = recognizeRoleplayTicketChannel(interaction.channel);
  if (recognition.kind !== 'registered') { await interaction.reply({ content: 'This roleplay ticket needs to be reset after a bot restart. Please make a new ticket.', ephemeral: true, allowedMentions: blockedAllowedMentions }); return null; }
  if (interaction.user?.id !== recognition.ticket.openerUserId) { await interaction.reply({ content: 'Only the player who opened this roleplay ticket can close it.', ephemeral: true, allowedMentions: blockedAllowedMentions }); return null; }
  await interaction.reply({ content: 'Roleplay ticket closed.', allowedMentions: blockedAllowedMentions });
  return closeRoleplayTicketChannel({ channel: interaction.channel, channelId: interaction.channelId, userId: interaction.user.id });
}
function createInteractionCreateHandler(options = {}) {
    return async function handleInteractionCreate(interaction) {
      try { await handleRoleplayInteraction(interaction, options); } catch (error) {
      logRoleplayError('Roleplay interaction failed.', error, { guildId: interaction.guildId, channelId: interaction.channelId });
      const response = { content: 'Roleplay interaction failed. Try again.', ephemeral: true, allowedMentions: blockedAllowedMentions };
      if (interaction.deferred || interaction.replied) await interaction.editReply(response); else await interaction.reply(response);
    }
  };
}
module.exports = { buildRoleplayCloseButtonRow, buildRoleplayClosePanelMessage, buildRoleplayOpenModal, buildRoleplayPromptChoiceMessage, buildRoleplayTicketPermissionOverwrites, buildTicketChannelName, canCreateRoleplayTicket, createInteractionCreateHandler, createRoleplayTicketFromInteraction, handleRoleplayInteraction };
