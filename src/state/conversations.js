const crypto = require('node:crypto');
const {
  conversationInactivityMs,
  maxConversationMessages,
} = require('../config/constants');
const { sanitizeDiscordMentions } = require('../discord/mentions');

const conversations = new Map();

function createConversation(now = Date.now()) {
  return {
    threadId: crypto.randomUUID(),
    messages: [],
    lastActivityAt: now,
  };
}

function getConversationKey(message) {
  const guildId = message.guildId ?? message.guild?.id;
  return `${guildId}:${message.channelId}`;
}

function isConversationExpired(conversation, now = Date.now()) {
  return now - conversation.lastActivityAt >= conversationInactivityMs;
}

function getConversation(conversationKey, now = Date.now()) {
  const conversation = conversations.get(conversationKey);

  if (!conversation || isConversationExpired(conversation, now)) {
    conversations.set(conversationKey, createConversation(now));
  }

  return conversations.get(conversationKey);
}

function resetConversation(conversationKey) {
  conversations.delete(conversationKey);
}

function resetChannelConversation(guildId, channelId) {
  return conversations.delete(`${guildId}:${channelId}`);
}

function resetGuildConversations(guildId, excludedChannelIds = new Set()) {
  const guildKeyPrefix = `${guildId}:`;
  let resetCount = 0;

  for (const conversationKey of conversations.keys()) {
    if (!conversationKey.startsWith(guildKeyPrefix)) {
      continue;
    }

    const channelId = conversationKey.slice(guildKeyPrefix.length);
    if (excludedChannelIds.has(channelId)) {
      continue;
    }

    conversations.delete(conversationKey);
    resetCount += 1;
  }

  return resetCount;
}

function sanitizeAuthorField(value) {
  return sanitizeDiscordMentions(value.trim()).replace(/\s+/g, ' ');
}

function normalizeAuthorMetadata(authorMetadata) {
  if (!authorMetadata || typeof authorMetadata !== 'object') {
    return null;
  }

  const userId = typeof authorMetadata.userId === 'string'
    ? sanitizeAuthorField(authorMetadata.userId)
    : '';
  const displayName = typeof authorMetadata.displayName === 'string'
    ? sanitizeAuthorField(authorMetadata.displayName)
    : '';
  const username = typeof authorMetadata.username === 'string'
    ? sanitizeAuthorField(authorMetadata.username)
    : '';

  if (!userId && !displayName && !username) {
    return null;
  }

  return {
    ...(userId ? { userId } : {}),
    ...(displayName ? { displayName } : {}),
    ...(username ? { username } : {}),
  };
}

function getTimestampAndAuthor(nowOrAuthor, authorMetadata) {
  if (typeof nowOrAuthor === 'number') {
    return {
      now: nowOrAuthor,
      author: normalizeAuthorMetadata(authorMetadata),
    };
  }

  return {
    now: Date.now(),
    author: normalizeAuthorMetadata(nowOrAuthor),
  };
}

function buildUserMessage(userContent, authorMetadata = null) {
  const author = normalizeAuthorMetadata(authorMetadata);
  return {
    role: 'user',
    content: userContent,
    ...(author ? { author } : {}),
  };
}

function appendConversationUserMessage(conversation, userContent, nowOrAuthor = Date.now(), authorMetadata = null) {
  const { now, author } = getTimestampAndAuthor(nowOrAuthor, authorMetadata);

  conversation.messages.push(buildUserMessage(userContent, author));
  trimConversationMessages(conversation);
  conversation.lastActivityAt = now;
}

function appendConversationTurn(conversation, userContent, assistantContent, nowOrAuthor = Date.now(), authorMetadata = null) {
  const { now, author } = getTimestampAndAuthor(nowOrAuthor, authorMetadata);

  conversation.messages.push(
    buildUserMessage(userContent, author),
    {
      role: 'assistant',
      content: assistantContent,
    },
  );
  trimConversationMessages(conversation);
  conversation.lastActivityAt = now;
}

function trimConversationMessages(conversation) {
  if (conversation.messages.length > maxConversationMessages) {
    conversation.messages.splice(0, conversation.messages.length - maxConversationMessages);
  }
}

module.exports = {
  appendConversationTurn,
  appendConversationUserMessage,
  createConversation,
  getConversation,
  getConversationKey,
  isConversationExpired,
  normalizeAuthorMetadata,
  resetChannelConversation,
  resetConversation,
  resetGuildConversations,
};
