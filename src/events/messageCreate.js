const { getMentionText, replySafely, sanitizeDiscordMentions } = require('../discord/mentions');
const { getGrokHelpMessage, isGrokHelpCommand } = require('../commands/help');
const { isBludCommand, parseBludCommand, translateToBludMode } = require('../commands/blud');
const { translateToGoblinMode } = require('../commands/goblinMode');
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
const { buildMentionRequestText, buildReplyMentionText } = require('../grok/mentions');
const {
  factCheckClaim,
  getDeepSeekFailureMessage,
  shouldResetConversationAfterError,
} = require('../services/deepseek');
const { RequestGateError, getRequestGateFailureMessage } = require('../services/requestGate');
const {
  appendWebSearchSources,
  formatWebSearchContext,
  getWebSearchFailureMessage,
  getWebSearchNoResultsMessage,
  getWebSearchUnavailableMessage,
  isWebSearchConfigured,
  searchWeb,
  shouldUseInternetSearch,
} = require('../services/webSearch');

function getMessageAuthorMetadata(message) {
  return {
    userId: message.author.id,
    displayName: message.member?.displayName ?? message.author.globalName ?? message.author.displayName ?? message.author.username,
    username: message.author.username,
  };
}

function logProviderError(logger, guildId, error) {
  const metadata = {
    guildId: String(guildId || ''),
    errorClass: String(error?.name || 'Error'),
  };

  if (Number.isInteger(error?.status)) {
    metadata.status = error.status;
  }

  if (error?.requestId) {
    metadata.requestId = error.requestId;
  }

  logger?.error?.('Provider request failed', metadata);
}

function createMessageCreateHandler(client, dependencies = {}) {
  const accessPolicy = dependencies.accessPolicy;
  const guildConfigService = dependencies.guildConfigService;
  const requestGate = dependencies.requestGate;
  const factCheck = dependencies.factCheckClaim || factCheckClaim;
  const webSearch = dependencies.searchWeb || searchWeb;
  const logger = dependencies.logger || console;
  const fetchImpl = dependencies.fetchImpl;

  return async function handleMessageCreate(message) {
    if (!accessPolicy || !await accessPolicy.isMessageAllowed(message)) return;

    recordGuildUserMessage(message, Date.now(), setTimeout, accessPolicy.isChannelEligible);

    const isFunmuteCommand = /^!funmute(?:\s|$)/i.test(message.content.trim());
    const isBludCommandMsg = isBludCommand(message.content);
    const isRatioCommandMsg = isRatioCommand(message.content);
    const isGrokStatsCommandMsg = isPlainGrokStatsCommand(message, client.user?.id);

    if ((isFunmuteCommand || isRatioCommandMsg) && !message.guild) {
      await replySafely(message, 'This one only works in a server, not in DMs.');
      return;
    }

    let funmuteRequest = null;

    if (isFunmuteCommand) {
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

      if (!consumeFunmuteCooldown(message.guild.id, requesterMember.id)) {
        return;
      }

      funmuteRequest = {
        durationMs,
        parsedCommand,
        requesterMember,
        targetMember,
      };
    }

    const bludParsedForRecord = isBludCommandMsg ? parseBludCommand(message.content) : null;
    const isPureBludControl = bludParsedForRecord && bludParsedForRecord.action !== 'translate';

    const conversationKey = getConversationKey(message);
    const conversation = getConversation(conversationKey);
    const authorMetadata = getMessageAuthorMetadata(message);

    if (!isPureBludControl && !isGrokStatsCommandMsg) {
      recordMonthlyUserMessage(message.guildId ?? message.guild.id, message.author.id, message.content);
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

    if (funmuteRequest) {
      appendConversationUserMessage(conversation, message.content, authorMetadata);

      const {
        durationMs,
        parsedCommand,
        requesterMember,
        targetMember,
      } = funmuteRequest;

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
      const loreReply = buildLoreReply(conversation);
      appendConversationTurn(conversation, userMessageText, loreReply, authorMetadata);
      await replySafely(message, loreReply);
      return;
    }

    if (isGrokStatsCommand(userMessageText)) {
      const statsReply = getCurrentUserStatsReply(message.guildId ?? message.guild.id, message.author.id);
      appendConversationUserMessage(conversation, userMessageText, authorMetadata);
      await replySafely(message, statsReply);
      return;
    }

    if (isGrokWhoIsCommand(userMessageText)) {
      const targetUserId = getMentionedUserId(message);

      if (!targetUserId) {
        const fallbackReply = 'Usage: `grok who is @user` so I know which goblin file to open.';
        appendConversationTurn(conversation, userMessageText, fallbackReply, authorMetadata);
        await replySafely(message, fallbackReply);
        return;
      }

      const targetName = getDisplayNameForUser(message, targetUserId, parseGrokWhoIsTarget(userMessageText));
      const targetSummary = getCurrentUserProfileSummary(message.guildId ?? message.guild.id, targetUserId);
      const whoIsReply = buildWhoIsReply(targetName, targetSummary);
      appendConversationUserMessage(conversation, userMessageText, authorMetadata);
      await replySafely(message, whoIsReply);
      return;
    }

    const guildId = message.guildId || message.guild?.id;

    if (!guildId || !guildConfigService || typeof guildConfigService.resolveRuntimeConfig !== 'function') {
      await replySafely(message, 'This server has not finished Grok setup yet.');
      return;
    }

    let runtimeConfig;

    try {
      runtimeConfig = await guildConfigService.resolveRuntimeConfig(guildId);
    } catch (error) {
      logProviderError(logger, guildId, error);
      await replySafely(message, 'I could not load this server\'s Grok configuration. Try again in a bit.');
      return;
    }

    if (!runtimeConfig?.configured || !runtimeConfig.deepseek?.apiKey) {
      await replySafely(message, 'This server has not finished Grok setup yet.');
      return;
    }

    let releaseGate = null;

    try {
      if (requestGate && typeof requestGate.acquire === 'function') {
        releaseGate = requestGate.acquire(guildId, message.author.id);
      }

      if (typeof message.channel?.sendTyping === 'function') {
        await message.channel.sendTyping();
      }

      const claimText = hasReply
        ? buildReplyMentionText((await message.fetchReference()).content, userMessageText)
        : buildMentionRequestText(userMessageText);
      let webSearchResults = [];
      let webSearchContext = '';

      if (shouldUseInternetSearch(claimText)) {
        if (!isWebSearchConfigured(runtimeConfig.webSearch)) {
          await replySafely(message, getWebSearchUnavailableMessage(runtimeConfig.webSearch));
          return;
        }

        try {
          webSearchResults = await webSearch(claimText, runtimeConfig.webSearch, fetchImpl);
        } catch (error) {
          logProviderError(logger, guildId, error);
          await replySafely(message, getWebSearchFailureMessage());
          return;
        }

        if (webSearchResults.length === 0) {
          await replySafely(message, getWebSearchNoResultsMessage());
          return;
        }

        webSearchContext = formatWebSearchContext(webSearchResults);
      }

      const answer = await factCheck(
        claimText,
        conversation,
        '',
        webSearchContext,
        authorMetadata,
        {
          providerConfig: runtimeConfig.deepseek,
          fetchImpl,
        },
      );
      let finalAnswer = sanitizeDiscordMentions(answer);

      if (webSearchResults.length > 0) {
        finalAnswer = appendWebSearchSources(finalAnswer, webSearchResults);
      }

      if (conversation.goblinMode) {
        finalAnswer = translateToGoblinMode(finalAnswer);
      }

      appendConversationTurn(conversation, claimText, finalAnswer, authorMetadata);
      await replySafely(message, finalAnswer);
    } catch (error) {
      if (error instanceof RequestGateError) {
        await replySafely(message, getRequestGateFailureMessage(error));
        return;
      }

      logProviderError(logger, guildId, error);

      if (shouldResetConversationAfterError(error)) {
        resetConversation(conversationKey);
      }

      await replySafely(message, getDeepSeekFailureMessage(error));
    } finally {
      releaseGate?.();
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
