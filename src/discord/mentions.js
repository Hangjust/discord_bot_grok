const { blockedAllowedMentions } = require('../config/constants');

const discordMessageLimit = 2000;

function getMentionText(content, botUserId) {
  const escapedBotUserId = String(botUserId ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (!escapedBotUserId) {
    return String(content ?? '').trim();
  }

  return String(content ?? '')
    .replace(new RegExp(`<@!?${escapedBotUserId}>`, 'g'), '')
    .trim();
}

function sanitizeDiscordMentions(content) {
  return String(content ?? '').replace(/@(?!\u200b)/g, '@\u200b');
}

function buildSafeReplyOptions(content, extraOptions = {}) {
  return {
    ...extraOptions,
    content: sanitizeDiscordMentions(content),
    allowedMentions: blockedAllowedMentions,
  };
}

function getPreferredSplitIndex(content, maxLength) {
  const breakCharacters = ['\n', ' '];

  for (const breakCharacter of breakCharacters) {
    const index = content.lastIndexOf(breakCharacter, maxLength);

    if (index > 0) {
      return index;
    }
  }

  let index = maxLength;
  const previousCodeUnit = content.charCodeAt(index - 1);
  const nextCodeUnit = content.charCodeAt(index);

  if (
    previousCodeUnit >= 0xD800
    && previousCodeUnit <= 0xDBFF
    && nextCodeUnit >= 0xDC00
    && nextCodeUnit <= 0xDFFF
  ) {
    index -= 1;
  }

  return Math.max(index, 1);
}

function splitDiscordMessage(content, maxLength = discordMessageLimit) {
  const limit = Number.isInteger(maxLength) && maxLength > 0
    ? Math.min(maxLength, discordMessageLimit)
    : discordMessageLimit;
  const chunks = [];
  let remaining = String(content ?? '').trim();

  while (remaining.length > limit) {
    const splitIndex = getPreferredSplitIndex(remaining, limit);
    const chunk = remaining.slice(0, splitIndex).trimEnd();

    if (chunk) {
      chunks.push(chunk);
    }

    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

async function sendSafeMessageChunks(content, sendChunk, maxLength = discordMessageLimit) {
  if (typeof sendChunk !== 'function') {
    throw new TypeError('sendChunk must be a function.');
  }

  const safeContent = sanitizeDiscordMentions(content);
  const chunks = splitDiscordMessage(safeContent, maxLength);
  let lastMessage = null;

  for (let index = 0; index < chunks.length; index += 1) {
    lastMessage = await sendChunk(buildSafeReplyOptions(chunks[index]), index, lastMessage);
  }

  return lastMessage;
}

async function replySafely(message, content) {
  if (!message || typeof message.reply !== 'function') {
    throw new TypeError('A Discord message with a reply method is required.');
  }

  return sendSafeMessageChunks(content, async (options, index) => {
    if (index === 0 || typeof message.channel?.send !== 'function') {
      return message.reply(options);
    }

    return message.channel.send(options);
  });
}

module.exports = {
  buildSafeReplyOptions,
  discordMessageLimit,
  getMentionText,
  replySafely,
  sanitizeDiscordMentions,
  sendSafeMessageChunks,
  splitDiscordMessage,
};
