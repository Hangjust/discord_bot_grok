const { blockedAllowedMentions } = require('../config/constants');
const { canReplyInChannel } = require('./channel');

function getMentionText(content, botUserId) {
  return content
    .replace(new RegExp(`<@!?${botUserId}>`, 'g'), '')
    .trim();
}

function sanitizeDiscordMentions(content) {
  return String(content).replace(/@(?!\u200b)/g, '@\u200b');
}

function buildSafeReplyOptions(content) {
  return {
    content: sanitizeDiscordMentions(content),
    allowedMentions: blockedAllowedMentions,
  };
}

async function replySafely(message, content) {
  if (!canReplyInChannel(message.channelId)) {
    return null;
  }

  const safeContent = sanitizeDiscordMentions(content);

  if (safeContent.length <= 2000) {
    return message.reply({ content: safeContent, allowedMentions: blockedAllowedMentions });
  }

  const chunks = [];
  let currentString = safeContent;

  while (currentString.length > 0) {
    if (currentString.length <= 2000) {
      chunks.push(currentString);
      break;
    }

    let splitIndex = currentString.lastIndexOf('\n', 2000);
    if (splitIndex === -1) {
      splitIndex = currentString.lastIndexOf(' ', 2000);
    }
    if (splitIndex === -1) {
      splitIndex = 2000;
    }

    chunks.push(currentString.slice(0, splitIndex));
    currentString = currentString.slice(splitIndex).trimStart();
  }

  let lastReply = null;
  for (const chunk of chunks) {
    const options = { content: chunk, allowedMentions: blockedAllowedMentions };
    if (!lastReply) {
      lastReply = await message.reply(options);
    } else {
      lastReply = await lastReply.reply(options);
    }
  }

  return lastReply;
}

module.exports = {
  buildSafeReplyOptions,
  getMentionText,
  replySafely,
  sanitizeDiscordMentions,
};
