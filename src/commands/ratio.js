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
  const channelPermissions = member && typeof message.channel?.permissionsFor === 'function'
    ? message.channel.permissionsFor(member)
    : null;
  const permissions = channelPermissions ?? member?.permissions;

  return Boolean(permissions?.has(permission));
}

function getRatioValidationError(message, botMember) {
  if (!message.guild) {
    return 'This one only works in a server, not in DMs.';
  }

  if (!message.reference?.messageId) {
    return getRatioUsageMessage();
  }

  const requesterMember = message.member ?? null;
  const requesterId = requesterMember?.id ?? message.author?.id;
  const requesterIsOwner = Boolean(requesterId && requesterId === message.guild.ownerId);

  if (
    !requesterIsOwner
    && !memberHasPermissionInMessage(
      message,
      requesterMember,
      PermissionFlagsBits.ManageMessages,
    )
  ) {
    return 'You need Manage Messages to use this command.';
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

  const sendPermission = message.channel?.isThread?.()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  if (!memberHasPermissionInMessage(message, botMember, sendPermission)) {
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
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= reactions.length) return;
      const reaction = reactions[index];
      if (typeof reaction.users?.remove === 'function') {
        // Discord's delete-reaction endpoint is idempotent, so a direct delete
        // avoids fetching and retaining every reaction's user collection.
        await reaction.users.remove(userId);
        removedCount += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, reactions.length) }, worker));

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
    targetMessage = typeof message.channel?.messages?.fetch === 'function'
      ? await message.channel.messages.fetch({ message: message.reference.messageId, force: true })
      : await message.fetchReference();
  } catch {
    console.error('Ratio command could not fetch its referenced message.', {
      guildId: message.guildId ?? message.guild?.id ?? 'unknown',
    });
    await replySafely(message, 'I could not find the message to ratio.');
    return null;
  }

  try {
    const ratioReply = await targetMessage.reply({ content: 'ratio', allowedMentions: blockedAllowedMentions });
    await Promise.all([
      ratioReply.react(ratioCheckEmoji),
      removeUserReactionsFromMessage(targetMessage, message.author.id),
    ]);
    return ratioReply;
  } catch {
    console.error('Ratio command failed while updating Discord messages.', {
      guildId: message.guildId ?? message.guild?.id ?? 'unknown',
    });
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
