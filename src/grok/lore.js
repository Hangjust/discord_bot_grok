const { maxConversationMessages, maxProfileSummaryItems } = require('../config/constants');
const { sanitizeDiscordMentions } = require('../discord/mentions');
const {
  extractProfileTerms,
  getTopCounterEntries,
} = require('../state/userProfiles');

function isGrokLoreCommand(text) {
  return /^lore\b/i.test(String(text).trim());
}

function isGrokStatsCommand(text) {
  return /^stats\b/i.test(String(text).trim());
}

function parseGrokWhoIsTarget(text) {
  const match = String(text).trim().match(/^who\s+is\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function isGrokWhoIsCommand(text) {
  return Boolean(parseGrokWhoIsTarget(text));
}

function getRecentConversationTopicTerms(conversation, limit = maxProfileSummaryItems) {
  const terms = new Map();

  for (const message of conversation?.messages?.slice(-maxConversationMessages) ?? []) {
    if (message.role !== 'user') {
      continue;
    }

    for (const term of extractProfileTerms(message.content)) {
      incrementCounter(terms, term);
    }
  }

  return getTopCounterEntries(terms, limit);
}

function incrementCounter(counter, key, amount = 1) {
  counter.set(key, (counter.get(key) ?? 0) + amount);
}

function buildLoreContext(conversation, now = Date.now()) {
  const recentTopics = getRecentConversationTopicTerms(conversation);
  const contextLines = [];

  if (recentTopics.length > 0) {
    contextLines.push(`recent channel topics: ${recentTopics.join(', ')}`);
  }

  return sanitizeDiscordMentions(contextLines.join('\n'));
}

function buildLoreReply(conversation, now = Date.now()) {
  const recentTopics = getRecentConversationTopicTerms(conversation);

  if (recentTopics.length === 0) {
    return 'Server lore is empty right now. The archive goblin has dust, vibes, and zero receipts.';
  }

  const topics = getSummaryListItems(recentTopics.join(', '));
  const topicText = formatNaturalList(topics);

  return `Channel lore says ${topicText} are the current sacred artifacts everyone keeps tripping over. The recurring bit is becoming less of a joke and more of a tiny local religion. Final reading: this channel has dangerous sitcom energy and should not be left unattended near a whiteboard.`;
}

function getMentionedUserId(message) {
  const mentionedUser = message.mentions?.users?.first?.();

  if (mentionedUser?.id) {
    return mentionedUser.id;
  }

  const match = String(message.content).match(/<@!?(\d+)>/);
  return match ? match[1] : '';
}

function getDisplayNameForUser(message, userId, fallbackText = 'that creature') {
  const member = message.mentions?.members?.get?.(userId) ?? message.mentions?.members?.first?.();
  const user = message.mentions?.users?.get?.(userId) ?? message.mentions?.users?.first?.();
  const displayName = member?.displayName ?? member?.user?.username ?? user?.globalName ?? user?.username ?? fallbackText;
  return sanitizeDiscordMentions(displayName);
}

function parseProfileSummary(summary) {
  const fields = {};

  for (const part of String(summary).split(';')) {
    const separatorIndex = part.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();

    if (key) {
      fields[key] = value;
    }
  }

  return fields;
}

function parseSummaryInteger(fields, key) {
  const value = Number.parseInt(fields[key], 10);
  return Number.isFinite(value) ? value : 0;
}

function getSummaryListItems(value, limit = 3) {
  const safeValue = sanitizeDiscordMentions(String(value || '').trim());

  if (!safeValue || safeValue === 'none yet') {
    return [];
  }

  return safeValue
    .split(',')
    .map((item) => item.trim().replace(/\s*\(\d+\)\s*$/, '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function formatNaturalList(items) {
  if (items.length === 0) {
    return '';
  }

  if (items.length === 1) {
    return items[0];
  }

  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }

  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function getProfileCreature(messageCount, averageLength) {
  if (messageCount >= 40 && averageLength <= 35) {
    return 'a rapid-fire goblin with drive-by lore energy';
  }

  if (messageCount >= 40) {
    return 'a certified channel regular with sitcom side-character energy';
  }

  if (averageLength >= 100) {
    return 'a paragraph warlock pretending this is casual';
  }

  if (averageLength <= 35) {
    return 'a short-message gremlin doing hit-and-run lore drops';
  }

  if (messageCount >= 10) {
    return 'a recurring side quest in human clothing';
  }

  return 'a low-sample cryptid still forming in the fog';
}

function getProfileTraitPhrases(fields) {
  const traits = [];
  const capsMessages = parseSummaryInteger(fields, 'all_caps_messages');
  const questions = parseSummaryInteger(fields, 'questions');
  const exclamations = parseSummaryInteger(fields, 'exclamations');
  const emojiLikeTokens = parseSummaryInteger(fields, 'emoji_like_tokens');

  if (capsMessages > 0) {
    traits.push('caps-lock prophecy bursts');
  }

  if (questions >= 3) {
    traits.push('detective questions with no badge');
  } else if (questions > 0) {
    traits.push('suspicious little questions');
  }

  if (exclamations >= 3) {
    traits.push('alarm-bell punctuation');
  } else if (exclamations > 0) {
    traits.push('tiny panic punctuation');
  }

  if (emojiLikeTokens >= 3) {
    traits.push('emoji confetti at the crime scene');
  } else if (emojiLikeTokens > 0) {
    traits.push('emoji crumbs in their pockets');
  }

  return traits.slice(0, 2);
}

function buildProfileBehaviorSentence(fields) {
  const traits = getProfileTraitPhrases(fields);

  if (traits.length === 0) {
    return 'Their behavior is low-noise lore mist, which somehow makes the goblin file more suspicious.';
  }

  return `Their signature move is ${formatNaturalList(traits)}.`;
}

function buildWhoIsReply(targetName, userProfileSummary) {
  const safeName = sanitizeDiscordMentions(targetName || 'that creature');

  if (!userProfileSummary) {
    return `${safeName} is still undocumented wildlife. I need more monthly chatter before I can roast the file cabinet accurately.`;
  }

  const fields = parseProfileSummary(userProfileSummary);
  const messageCount = parseSummaryInteger(fields, 'messages');
  const averageLength = parseSummaryInteger(fields, 'avg_chars');
  const creature = getProfileCreature(messageCount, averageLength);
  const topics = getSummaryListItems(fields.topics);
  const phrases = getSummaryListItems(fields.phrases, 1);
  const topicText = topics.length > 0
    ? ` who keeps orbiting ${formatNaturalList(topics)} like those words owe them rent`
    : ' with a suspiciously foggy topic trail';
  const catchphraseText = phrases.length > 0
    ? ` Their recurring spell is "${phrases[0]}", so I am classifying them as a sentient side quest with catchphrase damage.`
    : ' Final classification: sentient side quest with suspiciously specific lore.';

  return `${safeName} is ${creature}${topicText}. ${buildProfileBehaviorSentence(fields)}${catchphraseText}`;
}

module.exports = {
  buildLoreContext,
  buildLoreReply,
  buildWhoIsReply,
  getDisplayNameForUser,
  getMentionedUserId,
  getRecentConversationTopicTerms,
  isGrokLoreCommand,
  isGrokStatsCommand,
  isGrokWhoIsCommand,
  parseGrokWhoIsTarget,
};
