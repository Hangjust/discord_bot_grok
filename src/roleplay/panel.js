const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { blockedAllowedMentions } = require('../config/constants');
const { isRoleplayPanelCommand, parseRoleplayCooldownCommand, roleplayCooldownCommand, roleplayCustomIds, roleplayPanelAliasCommand, roleplayPanelCommand } = require('./config');
const { setRoleplayTicketReopenCooldownEnabled } = require('./rateLimit');
function canManageRoleplayPanels(member) { return Boolean(member?.permissions?.has?.(PermissionFlagsBits.ManageChannels) || member?.permissions?.has?.(PermissionFlagsBits.Administrator)); }
function canManageRoleplayCooldown(message) { return Boolean(message?.guild && message?.member && (message.guild.ownerId === message.author.id || message.member.permissions?.has?.(PermissionFlagsBits.Administrator) || message.member.permissions?.has?.(PermissionFlagsBits.ManageGuild))); }
function buildRoleplayPanelEmbed() {
  return new EmbedBuilder().setTitle('Welcome to RP').setDescription('Ready to start roleplay? Click the button below to open your private RP channel, then choose Fantasy, Naughty, Dark/Humor, or a custom idea.').setColor(0x2ecc71);
}
function buildRoleplayOpenButtonRow() {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(roleplayCustomIds.openButton).setLabel('Open RP').setStyle(ButtonStyle.Success));
}
function buildRoleplayPanelMessage() { return { embeds: [buildRoleplayPanelEmbed()], components: [buildRoleplayOpenButtonRow()], allowedMentions: blockedAllowedMentions }; }
async function replyToRoleplayPanelCommand(message, content) {
  try {
    await message.reply({ content, allowedMentions: blockedAllowedMentions });
  } catch (error) {
    console.error(error);
  }
}
async function handleRoleplayPanelCommand(message) {
  if (!isRoleplayPanelCommand(message.content)) return false;
  if (!message.guild || !message.member) { await replyToRoleplayPanelCommand(message, 'Roleplay panels can only be posted in a server.'); return true; }
  if (!canManageRoleplayPanels(message.member)) { await replyToRoleplayPanelCommand(message, `You need Manage Channels or Administrator to post a roleplay panel. Usage: \`${roleplayPanelCommand}\` or \`${roleplayPanelAliasCommand}\``); return true; }
  try {
    await message.channel.send(buildRoleplayPanelMessage());
    await replyToRoleplayPanelCommand(message, 'Roleplay panel posted.');
  } catch (error) {
    console.error(error);
    await replyToRoleplayPanelCommand(message, 'I could not post the roleplay panel here. Check my Send Messages and Embed Links permissions.');
  }
  return true;
}
async function handleRoleplayCooldownCommand(message) {
  const parsedStatus = parseRoleplayCooldownCommand(message.content);
  if (parsedStatus == null) return false;
  if (!message.guild || !message.member) { await message.reply({ content: 'Roleplay cooldown commands can only be used in a server.', allowedMentions: blockedAllowedMentions }); return true; }
  if (parsedStatus === '') { await message.reply({ content: `Usage: \`${roleplayCooldownCommand} on\` or \`${roleplayCooldownCommand} off\`.`, allowedMentions: blockedAllowedMentions }); return true; }
  if (!canManageRoleplayCooldown(message)) { await message.reply({ content: 'Only the server owner or members with Administrator or Manage Guild can change the roleplay cooldown.', allowedMentions: blockedAllowedMentions }); return true; }
  setRoleplayTicketReopenCooldownEnabled(message.guild.id, parsedStatus === 'on');
  await message.reply({ content: parsedStatus === 'on' ? 'Roleplay ticket reopen cooldown is now on.' : 'Roleplay ticket reopen cooldown is now off.', allowedMentions: blockedAllowedMentions });
  return true;
}
module.exports = { buildRoleplayOpenButtonRow, buildRoleplayPanelEmbed, buildRoleplayPanelMessage, canManageRoleplayCooldown, canManageRoleplayPanels, handleRoleplayCooldownCommand, handleRoleplayPanelCommand, replyToRoleplayPanelCommand };
