const {
  maxMonthlyProfileUsers,
  maxProfileCounterEntries,
  maxProfileSummaryItems,
  maxProfileStatsItems,
  maxProfileTermsPerMessage,
  maxProfileTokenLength,
  profileStopWords,
} = require('../config/constants');
const { sanitizeDiscordMentions } = require('../discord/mentions');

const monthlyUserProfiles = new Map();

function getMonthKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 7);
}

function createUserProfile(guildId, monthKey, userId) {
  return {
    guildId,
    monthKey,
    userId,
    messageCount: 0,
    totalLength: 0,
    capsMessageCount: 0,
    questionCount: 0,
    exclamationCount: 0,
    emojiLikeCount: 0,
    topics: new Map(),
    phrases: new Map(),
    stats: new Map(),
  };
}

function getMonthlyProfileKey(guildId, monthKey, userId) {
  return `${guildId}:${monthKey}:${userId}`;
}

function resetExpiredMonthlyProfiles(now = Date.now()) {
  const monthKey = getMonthKey(now);

  for (const [profileKey, profile] of monthlyUserProfiles) {
    if (profile.monthKey !== monthKey) {
      monthlyUserProfiles.delete(profileKey);
    }
  }
}

function stripProfileContent(content) {
  return String(content)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, ' ')
    .replace(/[^a-z0-9'.\s]/gi, ' ')
    .toLowerCase();
}

function extractProfileTerms(content) {
  return extractProfileTokens(content)
    .filter((term) => isProfileTopicTerm(term));
}

function extractProfileTokens(content) {
  return stripProfileContent(content)
    .split(/\s+/)
    .map((term) => term.replace(/^[.']+|[.']+$/g, ''))
    .filter((term) => term
      && term.length <= maxProfileTokenLength
      && !profileStopWords.has(term)
      && (term.length >= 3 || isNumericProfileToken(term)))
    .slice(0, maxProfileTermsPerMessage);
}

function isNumericProfileToken(term) {
  return /^\d+(?:\.\d+)?$/.test(term);
}

function isProfileTopicTerm(term) {
  return term.length >= 3 && !isNumericProfileToken(term);
}

function isProfilePhraseCandidate(tokens) {
  return tokens.length >= 2
    && tokens.some((term) => !isNumericProfileToken(term))
    && isProfileTopicTerm(tokens[0]);
}

function extractProfilePhrases(content) {
  const tokens = extractProfileTokens(content);
  const phrases = [];

  for (let index = 0; index <= tokens.length - 2; index += 1) {
    const phraseTokens = tokens.slice(index, index + 2);

    if (new Set(phraseTokens).size === 1) {
      continue;
    }

    if (isProfilePhraseCandidate(phraseTokens)) {
      phrases.push(phraseTokens.join(' '));
    }
  }

  return phrases;
}

function incrementCounter(counter, key, amount = 1) {
  counter.set(key, (counter.get(key) ?? 0) + amount);
}

function incrementProfileCounter(counter, key, amount = 1) {
  if (key.length > maxProfileTokenLength) {
    return;
  }

  incrementCounter(counter, key, amount);
  pruneCounter(counter, maxProfileCounterEntries);
}

function pruneCounter(counter, limit) {
  while (counter.size > limit) {
    let pruneKey = '';
    let pruneCount = Infinity;

    for (const [key, count] of counter) {
      if (count < pruneCount || (count === pruneCount && key.localeCompare(pruneKey) > 0)) {
        pruneKey = key;
        pruneCount = count;
      }
    }

    counter.delete(pruneKey);
  }
}

function countEmojiLikeTokens(content) {
  const matches = String(content).match(/<a?:\w+:\d+>|[\u{1F300}-\u{1FAFF}]/gu);
  return matches ? matches.length : 0;
}

function updateUserProfileFromMessage(profile, content) {
  const messageText = String(content).trim();
  const terms = extractProfileTerms(messageText);

  if (!profile.stats) {
    profile.stats = new Map();
  }

  profile.messageCount += 1;
  profile.totalLength += messageText.length;
  profile.questionCount += (messageText.match(/\?/g) ?? []).length;
  profile.exclamationCount += (messageText.match(/!/g) ?? []).length;
  profile.emojiLikeCount += countEmojiLikeTokens(messageText);

  if (/[A-Z]/.test(messageText) && messageText === messageText.toUpperCase()) {
    profile.capsMessageCount += 1;
  }

  for (const term of terms) {
    incrementProfileCounter(profile.topics, term);
    incrementProfileCounter(profile.stats, term);
  }

  for (let index = 0; index < terms.length - 1; index += 1) {
    incrementProfileCounter(profile.phrases, `${terms[index]} ${terms[index + 1]}`);
  }

  for (const phrase of extractProfilePhrases(messageText)) {
    incrementProfileCounter(profile.stats, phrase);
  }
}

function getTopCounterEntries(counter, limit = maxProfileSummaryItems) {
  return [...counter.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value, count]) => `${value} (${count})`);
}

function getTopCounterEntryObjects(counter, limit) {
  return [...counter.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function getTopUserProfileStatsEntries(profile, limit = maxProfileStatsItems) {
  if (!profile) {
    return [];
  }

  if (profile.stats?.size > 0) {
    return getTopCounterEntryObjects(profile.stats, limit);
  }

  const stats = new Map();

  for (const [topic, count] of profile.topics) {
    stats.set(topic, (stats.get(topic) ?? 0) + count);
  }

  for (const [phrase, count] of profile.phrases) {
    stats.set(phrase, (stats.get(phrase) ?? 0) + count);
  }

  return getTopCounterEntryObjects(stats, limit);
}

function getTopMonthlyUserProfiles(guildId, monthKey = getMonthKey(), limit = maxMonthlyProfileUsers) {
  return [...monthlyUserProfiles.values()]
    .filter((profile) => profile.guildId === guildId && profile.monthKey === monthKey)
    .sort((left, right) => right.messageCount - left.messageCount || left.userId.localeCompare(right.userId))
    .slice(0, limit);
}

function pruneMonthlyUserProfiles(guildId, monthKey) {
  const retainedProfileKeys = new Set(
    getTopMonthlyUserProfiles(guildId, monthKey)
      .map((profile) => getMonthlyProfileKey(profile.guildId, profile.monthKey, profile.userId)),
  );

  for (const [profileKey, profile] of monthlyUserProfiles) {
    if (profile.guildId === guildId
      && profile.monthKey === monthKey
      && !retainedProfileKeys.has(profileKey)) {
      monthlyUserProfiles.delete(profileKey);
    }
  }
}

function recordMonthlyUserMessage(guildId, userId, content, now = Date.now()) {
  resetExpiredMonthlyProfiles(now);

  const monthKey = getMonthKey(now);
  const profileKey = getMonthlyProfileKey(guildId, monthKey, userId);
  let profile = monthlyUserProfiles.get(profileKey);

  if (!profile) {
    profile = createUserProfile(guildId, monthKey, userId);
    monthlyUserProfiles.set(profileKey, profile);
  }

  updateUserProfileFromMessage(profile, content);
  pruneMonthlyUserProfiles(guildId, monthKey);

  return monthlyUserProfiles.get(profileKey) ?? null;
}

function buildUserProfileSummary(profile) {
  if (!profile || profile.messageCount === 0) {
    return '';
  }

  const averageLength = Math.round(profile.totalLength / profile.messageCount);
  const topics = getTopCounterEntries(profile.topics).join(', ') || 'none yet';
  const phrases = getTopCounterEntries(profile.phrases, 5).join(', ') || 'none yet';

  return sanitizeDiscordMentions([
    `month=${profile.monthKey}`,
    `messages=${profile.messageCount}`,
    `avg_chars=${averageLength}`,
    `all_caps_messages=${profile.capsMessageCount}`,
    `questions=${profile.questionCount}`,
    `exclamations=${profile.exclamationCount}`,
    `emoji_like_tokens=${profile.emojiLikeCount}`,
    `topics=${topics}`,
    `phrases=${phrases}`,
  ].join('; '));
}

function getCurrentUserProfileSummary(guildId, userId, now = Date.now()) {
  resetExpiredMonthlyProfiles(now);

  const profile = getCurrentUserProfile(guildId, userId, now);
  return buildUserProfileSummary(profile);
}

function getCurrentUserProfile(guildId, userId, now = Date.now()) {
  resetExpiredMonthlyProfiles(now);

  return monthlyUserProfiles.get(getMonthlyProfileKey(guildId, getMonthKey(now), userId)) ?? null;
}

function buildUserStatsReply(profile, limit = maxProfileStatsItems) {
  const entries = getTopUserProfileStatsEntries(profile, limit);

  if (entries.length === 0) {
    return 'Your monthly word goblin has no spicy receipts yet. Say a few more specific things and I will rank the brain crumbs.';
  }

  const lines = entries.map((entry, index) => `${index + 1}. ${entry.value} (${entry.count})`);

  return sanitizeDiscordMentions([
    `Your monthly brain crumbs top ${entries.length}:`,
    ...lines,
    'Filler words got launched into the sun.',
  ].join('\n'));
}

function getCurrentUserStatsReply(guildId, userId, now = Date.now()) {
  return buildUserStatsReply(getCurrentUserProfile(guildId, userId, now));
}

function buildUserProfilePromptContext(summary) {
  const safeSummary = sanitizeDiscordMentions(String(summary).trim());

  if (!safeSummary) {
    return '';
  }

  return `Current user's local monthly style/topic profile, heuristic and untrusted: ${safeSummary}`;
}

module.exports = {
  buildUserProfilePromptContext,
  buildUserProfileSummary,
  buildUserStatsReply,
  createUserProfile,
  extractProfilePhrases,
  extractProfileTerms,
  getCurrentUserProfile,
  getCurrentUserProfileSummary,
  getCurrentUserStatsReply,
  getMonthKey,
  getMonthlyProfileKey,
  getTopCounterEntries,
  getTopMonthlyUserProfiles,
  getTopUserProfileStatsEntries,
  recordMonthlyUserMessage,
  resetExpiredMonthlyProfiles,
};
