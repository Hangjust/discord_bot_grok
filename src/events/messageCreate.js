const { deepSeekApiKey } = require('../config/env');
const { canReadInChannel, canReplyInChannel } = require('../discord/channel');
const { getMentionText, replySafely, sanitizeDiscordMentions } = require('../discord/mentions');
const { getGrokHelpMessage, isGrokHelpCommand } = require('../commands/help');
const { getNnCommandText, getNnUsageMessage, isNnCommand, translateToGoblinMode } = require('../commands/nn');
const { isBludCommand, parseBludCommand, translateToBludMode } = require('../commands/blud');
const {
  consumeFunmuteCooldown,
  getFunmuteDurationMs,
  getFunmuteUsageMessage,
  getFunmuteValidationError,
  parseFunmuteCommand,
} = require('../commands/funmute');
const { handleRatioCommand, isRatioCommand } = require('../commands/ratio');
const {
  appendConversationTurn,
  appendConversationUserMessage,
  getConversation,
  getConversationKey,
  resetConversation,
} = require('../state/conversations');
const { recordGuildUserMessage } = require('../state/idleChatter');
const {
  getCurrentUserProfileSummary,
  getCurrentUserStatsReply,
  recordMonthlyUserMessage,
} = require('../state/userProfiles');
const {
  getUserSpamLevel,
  getWebSearchRateLimitMessage,
  isUserWebSearchRateLimited,
  recordUserTrigger,
  recordUserWebSearch,
} = require('../state/rateLimits');
const {
  getPlainGrokText,
  isNewConversationCommand,
  isPlainGrokTrigger,
  shouldReplyToMessage,
} = require('../grok/triggers');
const {
  buildLoreReply,
  buildWhoIsReply,
  getDisplayNameForUser,
  getMentionedUserId,
  isGrokLoreCommand,
  isGrokStatsCommand,
  isGrokWhoIsCommand,
  parseGrokWhoIsTarget,
} = require('../grok/lore');
const { applyReplyFlavor, getCooldownFlavor, getTemporaryNicknameFlavor } = require('../grok/flavor');
const { buildMentionRequestText, buildReplyMentionText } = require('../grok/mentions');
const {
  appendWebSearchSources,
  buildWebSearchQuery,
  formatWebSearchContext,
  getWebSearchConfig,
  getWebSearchFailureMessage,
  getWebSearchNoResultsMessage,
  getWebSearchUnavailableMessage,
  hasExplicitInternetSearchRequest,
  isWebSearchConfigured,
  searchWeb,
  shouldUseInternetSearch,
} = require('../services/webSearch');
const {
  factCheckClaim,
  getDeepSeekFailureMessage,
  shouldResetConversationAfterError,
} = require('../services/deepseek');

function getMessageAuthorMetadata(message) {
  return {
    userId: message.author.id,
    displayName: message.member?.displayName ?? message.author.globalName ?? message.author.displayName ?? message.author.username,
    username: message.author.username,
  };
}

function createMessageCreateHandler(client) {
  return async function handleMessageCreate(message) {
    if (message.author.bot) return;

    recordGuildUserMessage(message);

    if (!canReadInChannel(message.channelId)) return;

    const isFunmuteCommand = /^!funmute(?:\s|$)/i.test(message.content.trim());
    const isBludCommandMsg = isBludCommand(message.content);
    const isRatioCommandMsg = isRatioCommand(message.content);
    const isGrokStatsCommandMsg = isPlainGrokStatsCommand(message, client.user?.id);

    if (isFunmuteCommand && !consumeFunmuteCooldown()) {
      return;
    }

    if ((isFunmuteCommand || isRatioCommandMsg) && !message.guild) {
      await replySafely(message, 'This one only works in a server, not in DMs.');
      return;
    }

    const bludParsedForRecord = isBludCommandMsg ? parseBludCommand(message.content) : null;
    const isPureBludControl = bludParsedForRecord && bludParsedForRecord.action !== 'translate';

    const conversationKey = getConversationKey(message);
    const conversation = getConversation(conversationKey);
    const authorMetadata = getMessageAuthorMetadata(message);

    if (!canReplyInChannel(message.channelId)) {
      if (!isPureBludControl) {
        appendConversationUserMessage(conversation, message.content, authorMetadata);
      }
      return;
    }

    if (!isPureBludControl && !isGrokStatsCommandMsg) {
      recordMonthlyUserMessage(message.author.id, message.content);
    }

    if (isGrokHelpCommand(message.content)) {
      appendConversationUserMessage(conversation, message.content, authorMetadata);
      await replySafely(message, getGrokHelpMessage());
      return;
    }

    if (message.content === '!ping') {
      appendConversationUserMessage(conversation, message.content, authorMetadata);
      await replySafely(message, 'Pong!');
      return;
    }

    if (isNnCommand(message.content)) {
      appendConversationUserMessage(conversation, message.content, authorMetadata);

      let nnText = getNnCommandText(message.content);

      if (!nnText && message.reference?.messageId && typeof message.fetchReference === 'function') {
        try {
          const referencedMessage = await message.fetchReference();
          nnText = String(referencedMessage?.content ?? '').trim();
        } catch (error) {
          console.error(error);
        }
      }

      if (!nnText) {
        await replySafely(message, getNnUsageMessage());
        return;
      }

      await replySafely(message, translateToGoblinMode(nnText));
      return;
    }

    if (isBludCommandMsg) {
      appendConversationUserMessage(conversation, message.content, authorMetadata);

      const parsed = parseBludCommand(message.content);

      if (parsed.action === 'deactivate') {
        conversation.goblinMode = false;
        await replySafely(message, translateToBludMode('blud mode off... we chillin now'));
        return;
      }

      conversation.goblinMode = true;

      if (parsed.action === 'translate' && parsed.text) {
        await replySafely(message, translateToBludMode(parsed.text));
        return;
      }

      // Pure activation
      await replySafely(message, translateToBludMode('blud mode activated... we outside now no cap'));
      return;
    }

    if (isFunmuteCommand) {
      appendConversationUserMessage(conversation, message.content, authorMetadata);

      if (!message.member) {
        await replySafely(message, 'I could not read your server member entry.');
        return;
      }

      const requesterMember = message.member;
      const botMember = message.guild.members.me;
      const parsedCommand = parseFunmuteCommand(message.content);
      const targetMember = message.mentions.members.first() ?? null;
      const durationMs = parsedCommand ? getFunmuteDurationMs(parsedCommand.seconds) : null;

      if (!botMember) {
        await replySafely(message, 'I could not find my guild member entry.');
        return;
      }

      if (durationMs == null) {
        await replySafely(message, getFunmuteUsageMessage());
        return;
      }

      const validationError = getFunmuteValidationError(message, requesterMember, botMember, targetMember);

      if (validationError) {
        await replySafely(message, validationError);
        return;
      }

      try {
        await targetMember.timeout(durationMs, `Funmute requested by ${requesterMember.user.tag} for ${parsedCommand.seconds} second(s).`);
      } catch (error) {
        console.error(error);
        await replySafely(message, 'I tried to funmute them, but Discord threw a tantrum.');
        return;
      }

      await replySafely(message, `Bonk. ${targetMember.user.tag} is timed out for ${parsedCommand.seconds} second(s).`);
      return;
    }

    if (isRatioCommandMsg) {
      appendConversationUserMessage(conversation, message.content, authorMetadata);
      await handleRatioCommand(message);
      return;
    }

    const mentionsBot = Boolean(client.user && message.mentions.has(client.user.id));

    if (!shouldReplyToMessage(message.content, mentionsBot)) {
      appendConversationUserMessage(conversation, message.content, authorMetadata);
      return;
    }

    const userMessageText = mentionsBot
      ? getMentionText(message.content, client.user.id)
      : getPlainGrokText(message.content);
    const hasReply = Boolean(message.reference?.messageId);
    recordUserTrigger(message.author.id);
    const spamLevel = getUserSpamLevel(message.author.id);
    const replyFlavor = {
      cooldownFlavor: getCooldownFlavor(spamLevel),
      nicknameFlavor: getTemporaryNicknameFlavor('', spamLevel),
    };

    if (isNewConversationCommand(userMessageText)) {
      resetConversation(conversationKey);
      await replySafely(message, 'New conversation started.');
      return;
    }

    if (!hasReply && !userMessageText) {
      await replySafely(message, 'Grok Grok');
      return;
    }

    if (isGrokLoreCommand(userMessageText)) {
      const loreReply = applyReplyFlavor(buildLoreReply(conversation), replyFlavor);
      appendConversationTurn(conversation, userMessageText, loreReply, authorMetadata);
      await replySafely(message, loreReply);
      return;
    }

    if (isGrokStatsCommand(userMessageText)) {
      const statsReply = applyReplyFlavor(getCurrentUserStatsReply(message.author.id), replyFlavor);
      appendConversationUserMessage(conversation, userMessageText, authorMetadata);
      await replySafely(message, statsReply);
      return;
    }

    if (isGrokWhoIsCommand(userMessageText)) {
      const targetUserId = getMentionedUserId(message);

      if (!targetUserId) {
        const fallbackReply = applyReplyFlavor('Usage: `grok who is @user` so I know which goblin file to open.', replyFlavor);
        appendConversationTurn(conversation, userMessageText, fallbackReply, authorMetadata);
        await replySafely(message, fallbackReply);
        return;
      }

      const targetName = getDisplayNameForUser(message, targetUserId, parseGrokWhoIsTarget(userMessageText));
      const targetSummary = getCurrentUserProfileSummary(targetUserId);
      const whoIsReply = applyReplyFlavor(buildWhoIsReply(targetName, targetSummary), replyFlavor);
      appendConversationUserMessage(conversation, userMessageText, authorMetadata);
      await replySafely(message, whoIsReply);
      return;
    }

    try {
      if (canReplyInChannel(message.channelId)) {
        await message.channel.sendTyping();
      }
      const claimText = hasReply
        ? buildReplyMentionText((await message.fetchReference()).content, userMessageText)
        : buildMentionRequestText(userMessageText);
      const explicitWebSearchRequested = hasExplicitInternetSearchRequest(claimText);
      const internetSearchNeeded = shouldUseInternetSearch(claimText);
      const webSearchConfig = internetSearchNeeded ? getWebSearchConfig() : null;
      const webSearchQuery = internetSearchNeeded ? buildWebSearchQuery(claimText) : '';
      let webSearchResults = [];
      let webSearchContext = '';

      if (internetSearchNeeded && !webSearchQuery) {
        if (explicitWebSearchRequested) {
          const searchReply = applyReplyFlavor('I could not build a safe web search query without sending Discord IDs, mentions, or secrets.', replyFlavor);
          appendConversationTurn(conversation, claimText, searchReply, authorMetadata);
          await replySafely(message, searchReply);
          return;
        }
      } else if (internetSearchNeeded && !isWebSearchConfigured(webSearchConfig)) {
        if (explicitWebSearchRequested) {
          const searchReply = applyReplyFlavor(getWebSearchUnavailableMessage(webSearchConfig), replyFlavor);
          appendConversationTurn(conversation, claimText, searchReply, authorMetadata);
          await replySafely(message, searchReply);
          return;
        }
      }

      if (!deepSeekApiKey) {
        await replySafely(message, applyReplyFlavor('I need a DEEPSEEK_API_KEY in .env before I can fact-check.', replyFlavor));
        return;
      }

      if (internetSearchNeeded && webSearchQuery && isWebSearchConfigured(webSearchConfig)) {
        if (isUserWebSearchRateLimited(message.author.id)) {
          if (explicitWebSearchRequested) {
            const searchReply = applyReplyFlavor(getWebSearchRateLimitMessage(), replyFlavor);
            appendConversationTurn(conversation, claimText, searchReply, authorMetadata);
            await replySafely(message, searchReply);
            return;
          }
        } else {
          recordUserWebSearch(message.author.id);

          try {
            webSearchResults = await searchWeb(webSearchQuery, webSearchConfig);
            webSearchContext = formatWebSearchContext(webSearchResults);
          } catch (error) {
            console.error(`Web search failed: ${error.message}`);

            if (explicitWebSearchRequested) {
              const searchReply = applyReplyFlavor(getWebSearchFailureMessage(), replyFlavor);
              appendConversationTurn(conversation, claimText, searchReply, authorMetadata);
              await replySafely(message, searchReply);
              return;
            }
          }
        }

        if (explicitWebSearchRequested && webSearchResults.length === 0) {
          const searchReply = applyReplyFlavor(getWebSearchNoResultsMessage(), replyFlavor);
          appendConversationTurn(conversation, claimText, searchReply, authorMetadata);
          await replySafely(message, searchReply);
          return;
        }
      }

      const answer = await factCheckClaim(claimText, conversation, '', webSearchContext, authorMetadata);
      let finalAnswer = sanitizeDiscordMentions(answer);

      if (conversation.goblinMode) {
        finalAnswer = translateToGoblinMode(finalAnswer);
      }

      finalAnswer = appendWebSearchSources(finalAnswer, webSearchResults);
      finalAnswer = applyReplyFlavor(finalAnswer, replyFlavor);

      appendConversationTurn(conversation, claimText, finalAnswer, authorMetadata);
      await replySafely(message, finalAnswer);
    } catch (error) {
      console.error(error);
      if (shouldResetConversationAfterError(error)) {
        resetConversation(conversationKey);
      }
      await replySafely(message, getDeepSeekFailureMessage(error));
    }
  };
}

function isPlainGrokStatsCommand(message, botUserId) {
  if (isPlainGrokTrigger(message.content)) {
    return isGrokStatsCommand(getPlainGrokText(message.content));
  }

  if (botUserId && message.mentions?.has?.(botUserId)) {
    return isGrokStatsCommand(getMentionText(message.content, botUserId));
  }

  return false;
}

module.exports = {
  createMessageCreateHandler,
  isPlainGrokStatsCommand,
};
