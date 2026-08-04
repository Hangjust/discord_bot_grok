const crypto = require('node:crypto');
const {
  conversationInactivityMs,
  maxConversationMessages,
} = require('../config/constants');
const { sanitizeDiscordMentions } = require('../discord/mentions');

const conversations = new Map();
const conversationCountsByGuild = new Map();
const conversationCharacterCounts = new Map();
const conversationCharactersByGuild = new Map();
const conversationKeys = new WeakMap();
const maxConversations = 2000;
const maxConversationsPerGuild = 200;
const maxStoredMessageCharacters = 16_384;
const maxStoredConversationCharacters = maxConversationMessages * maxStoredMessageCharacters;
const maxStoredCharactersPerGuild = 1_500_000;
const maxStoredCharactersGlobal = 12_000_000;
let storedConversationCharacters = 0;
let lastGlobalPurgeAt = Number.NEGATIVE_INFINITY;

function getGuildIdFromConversationKey(key) {
  const normalizedKey = String(key);
  const separatorIndex = normalizedKey.indexOf(':');
  return separatorIndex < 0 ? normalizedKey : normalizedKey.slice(0, separatorIndex);
}

function deleteConversationByKey(key) {
  if (!conversations.delete(key)) return false;
  const guildId = getGuildIdFromConversationKey(key);
  const count = conversationCountsByGuild.get(guildId) ?? 0;
  if (count <= 1) conversationCountsByGuild.delete(guildId);
  else conversationCountsByGuild.set(guildId, count - 1);
  updateConversationCharacterCount(key, 0);
  return true;
}

function updateConversationCharacterCount(key, nextCount) {
  const guildId = getGuildIdFromConversationKey(key);
  const previousCount = conversationCharacterCounts.get(key) ?? 0;
  const normalizedCount = Math.max(0, Number(nextCount) || 0);
  const difference = normalizedCount - previousCount;
  if (difference === 0) return;

  if (normalizedCount === 0) conversationCharacterCounts.delete(key);
  else conversationCharacterCounts.set(key, normalizedCount);
  storedConversationCharacters = Math.max(0, storedConversationCharacters + difference);

  const guildCount = Math.max(0, (conversationCharactersByGuild.get(guildId) ?? 0) + difference);
  if (guildCount === 0) conversationCharactersByGuild.delete(guildId);
  else conversationCharactersByGuild.set(guildId, guildCount);
}

function setNewConversation(key, conversation) {
  conversations.set(key, conversation);
  conversationKeys.set(conversation, key);
  const guildId = getGuildIdFromConversationKey(key);
  conversationCountsByGuild.set(guildId, (conversationCountsByGuild.get(guildId) ?? 0) + 1);
}

function evictOldestConversation(guildId = null, excludedKey = null) {
  const prefix = guildId == null ? null : `${guildId}:`;
  let oldestKey = null;
  let oldestActivity = Number.POSITIVE_INFINITY;
  for (const [key, conversation] of conversations) {
    if (key === excludedKey) continue;
    if (prefix && !key.startsWith(prefix)) continue;
    const activity = Number(conversation?.lastActivityAt);
    if (activity < oldestActivity) {
      oldestActivity = activity;
      oldestKey = key;
    }
  }
  return oldestKey == null ? false : deleteConversationByKey(oldestKey);
}

function getConversationCharacterCount(conversation) {
  return (conversation?.messages ?? []).reduce(
    (total, message) => total + String(message?.content ?? '').length,
    0,
  );
}

function enforceConversationCharacterCapacity(currentKey) {
  const guildId = getGuildIdFromConversationKey(currentKey);
  while ((conversationCharactersByGuild.get(guildId) ?? 0) > maxStoredCharactersPerGuild) {
    if (!evictOldestConversation(guildId, currentKey)) break;
  }
  while (storedConversationCharacters > maxStoredCharactersGlobal) {
    if (!evictOldestConversation(null, currentKey)) break;
  }
}

function trackConversationCharacters(conversation) {
  const key = conversationKeys.get(conversation);
  if (!key || conversations.get(key) !== conversation) return;
  updateConversationCharacterCount(key, getConversationCharacterCount(conversation));
  enforceConversationCharacterCapacity(key);
}

function enforceConversationCapacity(key) {
  const guildId = getGuildIdFromConversationKey(key);
  while ((conversationCountsByGuild.get(guildId) ?? 0) >= maxConversationsPerGuild) {
    if (!evictOldestConversation(guildId)) break;
  }
  while (conversations.size >= maxConversations) {
    if (!evictOldestConversation()) break;
  }
}

function createConversation(now = Date.now()) {
  return {
    threadId: crypto.randomUUID(),
    messages: [],
    lastActivityAt: now,
    goblinMode: false,
  };
}

function requireIdentifier(value, label) {
  const identifier = String(value ?? '').trim();

  if (!identifier) {
    throw new TypeError(`${label} is required to identify a conversation.`);
  }

  return identifier;
}

function getConversationKey(messageOrGuildId, channelId) {
  const isMessage = messageOrGuildId && typeof messageOrGuildId === 'object';
  const guildId = isMessage
    ? messageOrGuildId.guildId ?? messageOrGuildId.guild?.id
    : messageOrGuildId;
  const resolvedChannelId = isMessage
    ? messageOrGuildId.channelId ?? messageOrGuildId.channel?.id
    : channelId;

  return `${requireIdentifier(guildId, 'guildId')}:${requireIdentifier(resolvedChannelId, 'channelId')}`;
}

function isConversationExpired(conversation, now = Date.now(), inactivityMs = conversationInactivityMs) {
  if (!conversation || !Number.isFinite(conversation.lastActivityAt)) {
    return true;
  }

  const expiryMs = Number.isFinite(inactivityMs) && inactivityMs >= 0
    ? inactivityMs
    : conversationInactivityMs;

  return now - conversation.lastActivityAt >= expiryMs;
}

function getConversation(conversationKey, now = Date.now()) {
  if (now < lastGlobalPurgeAt || now - lastGlobalPurgeAt >= 5 * 60 * 1000) {
    purgeExpiredConversations(now);
    lastGlobalPurgeAt = now;
  }
  const key = typeof conversationKey === 'object'
    ? getConversationKey(conversationKey)
    : requireIdentifier(conversationKey, 'conversationKey');
  const conversation = conversations.get(key);

  if (!conversation || isConversationExpired(conversation, now)) {
    const freshConversation = createConversation(now);
    if (conversation) {
      updateConversationCharacterCount(key, 0);
      conversations.set(key, freshConversation);
      conversationKeys.set(freshConversation, key);
    } else {
      enforceConversationCapacity(key);
      setNewConversation(key, freshConversation);
    }
    return freshConversation;
  }

  return conversation;
}

function resetConversation(conversationKey) {
  const key = typeof conversationKey === 'object'
    ? getConversationKey(conversationKey)
    : requireIdentifier(conversationKey, 'conversationKey');

  return deleteConversationByKey(key);
}

function resetConversationIfCurrent(conversationKey, expectedConversation) {
  const key = typeof conversationKey === 'object'
    ? getConversationKey(conversationKey)
    : requireIdentifier(conversationKey, 'conversationKey');
  const current = conversations.get(key);
  if (!current || current !== expectedConversation) {
    return false;
  }
  return deleteConversationByKey(key);
}

function resetGuildConversations(guildId) {
  const guildPrefix = `${requireIdentifier(guildId, 'guildId')}:`;
  let removedCount = 0;

  for (const key of conversations.keys()) {
    if (key.startsWith(guildPrefix) && deleteConversationByKey(key)) {
      removedCount += 1;
    }
  }

  return removedCount;
}

function purgeExpiredConversations(now = Date.now(), inactivityMs = conversationInactivityMs) {
  let removedCount = 0;

  for (const [key, conversation] of conversations) {
    if (isConversationExpired(conversation, now, inactivityMs) && deleteConversationByKey(key)) {
      removedCount += 1;
    }
  }

  return removedCount;
}

function clearConversations() {
  const removedCount = conversations.size;
  conversations.clear();
  conversationCountsByGuild.clear();
  conversationCharacterCounts.clear();
  conversationCharactersByGuild.clear();
  storedConversationCharacters = 0;
  lastGlobalPurgeAt = Number.NEGATIVE_INFINITY;
  return removedCount;
}

function sanitizeAuthorField(value) {
  return sanitizeDiscordMentions(String(value ?? '').trim()).replace(/\s+/g, ' ');
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

function normalizeMessageLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isInteger(parsed)) {
    return maxConversationMessages;
  }

  return Math.min(Math.max(parsed, 0), maxConversationMessages);
}

function getAppendOptions(nowOrAuthor, authorMetadata, messageLimit) {
  if (typeof nowOrAuthor === 'number') {
    return {
      now: nowOrAuthor,
      author: normalizeAuthorMetadata(authorMetadata),
      messageLimit: normalizeMessageLimit(messageLimit),
    };
  }

  const isOptionsObject = nowOrAuthor
    && typeof nowOrAuthor === 'object'
    && ('now' in nowOrAuthor || 'author' in nowOrAuthor || 'maxMessages' in nowOrAuthor);

  if (isOptionsObject) {
    return {
      now: Number.isFinite(nowOrAuthor.now) ? nowOrAuthor.now : Date.now(),
      author: normalizeAuthorMetadata(nowOrAuthor.author),
      messageLimit: normalizeMessageLimit(nowOrAuthor.maxMessages),
    };
  }

  return {
    now: Date.now(),
    author: normalizeAuthorMetadata(nowOrAuthor),
    messageLimit: normalizeMessageLimit(
      typeof authorMetadata === 'number' ? authorMetadata : messageLimit,
    ),
  };
}

function buildUserMessage(userContent, authorMetadata = null) {
  const author = normalizeAuthorMetadata(authorMetadata);

  return {
    role: 'user',
    content: normalizeStoredMessageContent(userContent),
    ...(author ? { author } : {}),
  };
}

function normalizeStoredMessageContent(value) {
  const content = String(value ?? '');
  if (content.length <= maxStoredMessageCharacters) return content;
  return `${content.slice(0, maxStoredMessageCharacters - 1)}…`;
}

function trimConversationMessages(conversation, messageLimit = maxConversationMessages) {
  if (!conversation || !Array.isArray(conversation.messages)) {
    throw new TypeError('A conversation with a messages array is required.');
  }

  const limit = normalizeMessageLimit(messageLimit);

  if (conversation.messages.length > limit) {
    conversation.messages.splice(0, conversation.messages.length - limit);
  }

  return conversation.messages;
}

const conversationCleanupTimer = setInterval(() => {
  const now = Date.now();
  purgeExpiredConversations(now);
  lastGlobalPurgeAt = now;
}, 5 * 60 * 1000);
conversationCleanupTimer.unref?.();

function appendConversationUserMessage(
  conversation,
  userContent,
  nowOrAuthor = Date.now(),
  authorMetadata = null,
  messageLimit = maxConversationMessages,
) {
  const options = getAppendOptions(nowOrAuthor, authorMetadata, messageLimit);

  conversation.messages.push(buildUserMessage(userContent, options.author));
  trimConversationMessages(conversation, options.messageLimit);
  conversation.lastActivityAt = options.now;
  trackConversationCharacters(conversation);
}

function appendConversationTurn(
  conversation,
  userContent,
  assistantContent,
  nowOrAuthor = Date.now(),
  authorMetadata = null,
  messageLimit = maxConversationMessages,
) {
  const options = getAppendOptions(nowOrAuthor, authorMetadata, messageLimit);

  conversation.messages.push(
    buildUserMessage(userContent, options.author),
    {
      role: 'assistant',
      content: normalizeStoredMessageContent(assistantContent),
    },
  );
  trimConversationMessages(conversation, options.messageLimit);
  conversation.lastActivityAt = options.now;
  trackConversationCharacters(conversation);
}

module.exports = {
  appendConversationTurn,
  appendConversationUserMessage,
  buildUserMessage,
  clearConversations,
  createConversation,
  getConversation,
  getConversationKey,
  isConversationExpired,
  maxConversations,
  maxConversationsPerGuild,
  maxStoredCharactersGlobal,
  maxStoredCharactersPerGuild,
  maxStoredConversationCharacters,
  maxStoredMessageCharacters,
  normalizeAuthorMetadata,
  purgeExpiredConversations,
  resetConversation,
  resetConversationIfCurrent,
  resetGuildConversations,
  trimConversationMessages,
};
