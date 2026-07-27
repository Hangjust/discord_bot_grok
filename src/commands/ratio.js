const { PermissionFlagsBits } = require('discord.js');
const {
  blockedAllowedMentions,
  ratioCheckEmoji,
  ratioCommandName,
} = require('../config/constants');
const { replySafely } = require('../discord/mentions');

function isRatioCommand(content) {
  return String(content).trim().toLowerCase() === ratioCommandName;
}

function getRatioUsageMessage() {
  return 'Reply to a message with `!ratio`.';
}

function memberHasPermissionInMessage(message, member, permission) {
  const channelPermissions = typeof message.channel?.permissionsFor === 'function'
    ? message.channel.permissionsFor(member)
    : null;
  const permissions = channelPermissions ?? member.permissions;

  return Boolean(permissions?.has(permission));
}

function getRatioValidationError(message, botMember) {
  if (!message.guild) {
    return 'This one only works in a server, not in DMs.';
  }

  if (!message.reference?.messageId) {
    return getRatioUsageMessage();
  }

  if (!botMember) {
    return 'I could not find my guild member entry.';
  }

  if (!memberHasPermissionInMessage(message, botMember, PermissionFlagsBits.ViewChannel)) {
    return 'I need View Channel to ratio anyone.';
  }

  if (!memberHasPermissionInMessage(message, botMember, PermissionFlagsBits.ReadMessageHistory)) {
    return 'I need Read Message History to ratio anyone.';
  }

  if (!memberHasPermissionInMessage(message, botMember, PermissionFlagsBits.SendMessages)) {
    return 'I need Send Messages to ratio anyone.';
  }

  if (!memberHasPermissionInMessage(message, botMember, PermissionFlagsBits.AddReactions)) {
    return 'I need Add Reactions to ratio anyone.';
  }

  if (!memberHasPermissionInMessage(message, botMember, PermissionFlagsBits.ManageMessages)) {
    return 'I need Manage Messages to remove their reactions.';
  }

  return null;
}

async function removeUserReactionsFromMessage(targetMessage, userId) {
  const reactions = Array.from(targetMessage.reactions?.cache?.values?.() ?? []);
  let removedCount = 0;

  for (const reaction of reactions) {
    let shouldRemove = true;

    if (typeof reaction.users?.cache?.has === 'function') {
      shouldRemove = reaction.users.cache.has(userId);
    }

    if (!shouldRemove && typeof reaction.users?.fetch === 'function') {
      const users = await reaction.users.fetch();
      shouldRemove = Boolean(users?.has?.(userId));
    }

    if (shouldRemove && typeof reaction.users?.remove === 'function') {
      await reaction.users.remove(userId);
      removedCount += 1;
    }
  }

  return removedCount;
}

async function handleRatioCommand(message) {
  const botMember = message.guild?.members?.me ?? null;
  const validationError = getRatioValidationError(message, botMember);

  if (validationError) {
    await replySafely(message, validationError);
    return null;
  }

  let targetMessage;

  try {
    targetMessage = await message.fetchReference();
  } catch (error) {
    console.error(error);
    await replySafely(message, 'I could not find the message to ratio.');
    return null;
  }

  try {
    const ratioReply = await targetMessage.reply({ content: 'ratio', allowedMentions: blockedAllowedMentions });
    await ratioReply.react(ratioCheckEmoji);
    await removeUserReactionsFromMessage(targetMessage, message.author.id);
    return ratioReply;
  } catch (error) {
    console.error(error);
    await replySafely(message, 'I tried to ratio them, but Discord threw a tantrum.');
    return null;
  }
}

module.exports = {
  getRatioUsageMessage,
  getRatioValidationError,
  handleRatioCommand,
  isRatioCommand,
  removeUserReactionsFromMessage,
};
