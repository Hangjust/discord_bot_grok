const wakeWordExpressionCache = new Map();
const wakeWordExpressionCacheLimit = 256;
const botMentionExpressionCache = new Map();

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeWakeWord(wakeWord) {
  return String(wakeWord ?? '').trim();
}

function buildWakeWordRegExp(wakeWord) {
  const normalized = normalizeWakeWord(wakeWord);
  if (!normalized) return null;

  const cached = wakeWordExpressionCache.get(normalized);
  if (cached) return cached;

  // A Unicode letter, number, or underscore after the configured literal means
  // it is part of a larger word (for example, "AI" must not match "airplane").
  const expression = new RegExp(`^\\s*${escapeRegExp(normalized)}(?=$|[^\\p{L}\\p{N}_])`, 'iu');
  if (wakeWordExpressionCache.size >= wakeWordExpressionCacheLimit) {
    wakeWordExpressionCache.delete(wakeWordExpressionCache.keys().next().value);
  }
  wakeWordExpressionCache.set(normalized, expression);
  return expression;
}

function matchesWakeWord(content, wakeWord) {
  const expression = buildWakeWordRegExp(wakeWord);
  return expression ? expression.test(String(content ?? '')) : false;
}

function extractWakeWordRequest(content, wakeWord) {
  const source = String(content ?? '');
  const expression = buildWakeWordRegExp(wakeWord);
  if (!expression) return source.trim();

  const match = source.match(expression);
  if (!match) return source.trim();

  return source
    .slice(match[0].length)
    .replace(/^[\s!?.,:;\-\u2013\u2014]+/u, '')
    .trim();
}

function isBotMentioned(messageOrContent, botUserId) {
  if (!botUserId) return false;

  if (messageOrContent?.mentions?.users?.has?.(botUserId)) return true;

  const content = typeof messageOrContent === 'string'
    ? messageOrContent
    : messageOrContent?.content;
  if (typeof content !== 'string') return false;

  const normalizedBotUserId = String(botUserId);
  let expression = botMentionExpressionCache.get(normalizedBotUserId);
  if (!expression) {
    expression = new RegExp(`<@!?${escapeRegExp(normalizedBotUserId)}>`);
    botMentionExpressionCache.clear();
    botMentionExpressionCache.set(normalizedBotUserId, expression);
  }
  return expression.test(content);
}

function getReferencedAuthorId(message, referencedAuthorId) {
  if (referencedAuthorId != null) return String(referencedAuthorId);
  return message?.referencedAuthorId
    ?? message?.reference?.authorId
    ?? message?.mentions?.repliedUser?.id
    ?? message?.referencedMessage?.author?.id
    ?? null;
}

function isReplyToBot(messageOrReferencedAuthorId, botUserId, referencedAuthorId) {
  if (!botUserId) return false;

  if (typeof messageOrReferencedAuthorId === 'string' || typeof messageOrReferencedAuthorId === 'number') {
    return String(messageOrReferencedAuthorId) === String(botUserId);
  }

  const message = messageOrReferencedAuthorId;
  if (!message?.reference && !message?.referencedMessage && referencedAuthorId == null && message?.referencedAuthorId == null) {
    return false;
  }

  const authorId = getReferencedAuthorId(message, referencedAuthorId);
  return authorId != null && String(authorId) === String(botUserId);
}

function shouldTrigger(options = {}, wakeWordArg, mentionsBotArg = false, isReplyToBotArg = false) {
  if (typeof options === 'string') {
    return matchesWakeWord(options, wakeWordArg) || Boolean(mentionsBotArg) || Boolean(isReplyToBotArg);
  }

  const content = options.content ?? options.message?.content ?? '';
  const wakeWord = options.triggerWord ?? options.wakeWord;
  const mentioned = options.mentionsBot
    ?? isBotMentioned(options.message ?? content, options.botUserId);
  const replied = options.isReplyToBot
    ?? isReplyToBot(options.message, options.botUserId, options.referencedAuthorId);

  return Boolean(mentioned || replied || matchesWakeWord(content, wakeWord));
}

module.exports = {
  buildWakeWordRegExp,
  escapeRegExp,
  extractWakeWordRequest,
  getReferencedAuthorId,
  isBotMentioned,
  isReplyToBot,
  matchesWakeWord,
  shouldTrigger,
};
