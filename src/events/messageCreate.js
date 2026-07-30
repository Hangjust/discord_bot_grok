const { getMentionText, replySafely, sanitizeDiscordMentions } = require('../discord/mentions');
const { hasManageMessagesPermission } = require('../discord/accessPolicy');
const { getHelpEmbedPages, isHelpCommand } = require('../commands/help');
const {
  handleServerBrandingCommand,
  parseServerBrandingCommand,
} = require('../commands/serverBranding');
const {
  createProviderKeyEmbed,
  isProviderKeyCommand,
} = require('../commands/providerKeys');
const { DEFAULT_TRIGGER_WORD } = require('../config/guildConfigSchema');
const { blockedAllowedMentions } = require('../config/constants');
const {
  appendConversationTurn,
  appendConversationUserMessage,
  getConversation,
  getConversationKey,
  resetConversation,
} = require('../state/conversations');
const {
  getPlainTriggerText,
  isNewConversationCommand,
  shouldReplyToMessage,
} = require('../ai/triggers');
const { buildMentionRequestText, buildReplyMentionText } = require('../ai/mentions');
const { compactAiResponse } = require('../ai/responseLength');
const {
  factCheckClaim,
  getDeepSeekFailureMessage,
  shouldResetConversationAfterError,
} = require('../services/deepseek');
const {
  generateGemmaResponse,
  getGeminiFailureMessage,
  shouldResetConversationAfterGeminiError,
} = require('../services/gemini');
const {
  collectQwenImages,
  generateQwenResponse,
  getQwenFailureMessage,
  shouldResetConversationAfterQwenError,
} = require('../services/qwen');
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

function getMentionedUserIds(message) {
  const mentioned = new Set();
  const users = message?.mentions?.users;

  if (users && typeof users.keys === 'function') {
    for (const userId of users.keys()) {
      if (/^\d{1,32}$/u.test(String(userId))) {
        mentioned.add(String(userId));
      }
    }
  }

  for (const match of String(message?.content || '').matchAll(/<@!?(\d{1,32})>/gu)) {
    mentioned.add(match[1]);
  }

  return [...mentioned];
}

async function runMemoryOperation(operation, logger, guildId) {
  try {
    return await operation();
  } catch (error) {
    logger?.warn?.('User memory operation failed', {
      guildId: String(guildId || ''),
      errorClass: String(error?.name || 'Error'),
    });
    return null;
  }
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

async function replyWithHelpEmbeds(message, embeds) {
  let lastReply = null;
  for (const embed of embeds) {
    const payload = { embeds: [embed], allowedMentions: blockedAllowedMentions };
    lastReply = await message.reply(payload);
  }
  return lastReply;
}

function createMessageCreateHandler(client, dependencies = {}) {
  const accessPolicy = dependencies.accessPolicy;
  const guildConfigService = dependencies.guildConfigService;
  const requestGate = dependencies.requestGate;
  const factCheck = dependencies.factCheckClaim || factCheckClaim;
  const generateGemma = dependencies.generateGemmaResponse || generateGemmaResponse;
  const generateQwen = dependencies.generateQwenResponse || generateQwenResponse;
  const webSearch = dependencies.searchWeb || searchWeb;
  const logger = dependencies.logger || console;
  const fetchImpl = dependencies.fetchImpl;
  const userMemoryStore = dependencies.userMemoryStore;

  return async function handleMessageCreate(message) {
    if (message?.author?.bot || message?.webhookId || message?.webhook || !message?.guildId) {
      return;
    }

    let triggerWord = DEFAULT_TRIGGER_WORD;
    try {
      const invocation = await guildConfigService?.getInvocationConfig?.(message.guildId);
      triggerWord = invocation?.triggerWord || triggerWord;
    } catch {
      // Public help can still render with the safe default. Other messages fail
      // closed through the normal access/configuration paths below.
    }

    if (isHelpCommand(message.content, triggerWord)) {
      if (!hasManageMessagesPermission(message)) {
        return;
      }

      let status = null;
      let promptSource = 'built-in';
      try {
        status = await guildConfigService?.getStatus?.(message.guildId);
        const behavior = await guildConfigService?.resolveAgentBehavior?.(
          message.guildId,
          message.channelId,
        );
        promptSource = behavior?.source || promptSource;
      } catch {
        // Help intentionally remains available with safe, non-secret defaults.
      }

      await replyWithHelpEmbeds(message, getHelpEmbedPages({
        triggerWord,
        configured: status?.configured,
        webSearchEnabled: status?.webSearchEnabled,
        promptSource,
        guildName: message.guild?.name,
        avatarUrl: client.user?.displayAvatarURL?.(),
      }));
      return;
    }

    const brandingCommand = parseServerBrandingCommand(message.content, triggerWord);
    if (brandingCommand) {
      await handleServerBrandingCommand(message, brandingCommand, { fetchImpl, logger });
      return;
    }

    if (!accessPolicy || !await accessPolicy.isMessageAllowed(message)) return;

    if (isProviderKeyCommand(message.content, triggerWord)) {
      await message.reply({
        embeds: [createProviderKeyEmbed()],
        allowedMentions: blockedAllowedMentions,
      });
      return;
    }

    const conversationKey = getConversationKey(message);
    const conversation = getConversation(conversationKey);
    const authorMetadata = getMessageAuthorMetadata(message);
    const mentionsBot = Boolean(client.user && message.mentions.has(client.user.id));
    const addressedBot = shouldReplyToMessage(message.content, mentionsBot, triggerWord);
    const memoryEventId = /^\d{1,32}$/u.test(String(message.id || ''))
      ? String(message.id)
      : null;

    if (userMemoryStore && memoryEventId) {
      await runMemoryOperation(() => userMemoryStore.recordUserMessage({
        eventId: memoryEventId,
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        displayName: authorMetadata.displayName,
        username: authorMetadata.username,
        content: message.content,
        addressedBot,
        timestamp: message.createdTimestamp || Date.now(),
      }), logger, message.guildId);
    }

    if (message.content === '!ping') {
      appendConversationUserMessage(conversation, message.content, authorMetadata);
      await replySafely(message, 'Pong!');
      return;
    }

    if (!addressedBot) {
      appendConversationUserMessage(conversation, message.content, authorMetadata);
      return;
    }

    const userMessageText = mentionsBot
      ? getMentionText(message.content, client.user.id)
      : getPlainTriggerText(message.content, triggerWord);
    const hasReply = Boolean(message.reference?.messageId);
    const directImages = collectQwenImages(message);

    if (isNewConversationCommand(userMessageText)) {
      resetConversation(conversationKey);
      await replySafely(message, 'New conversation started.');
      return;
    }

    if (!hasReply && !userMessageText && directImages.length === 0) {
      await replySafely(message, `${triggerWord} ${triggerWord}`);
      return;
    }

    const guildId = message.guildId || message.guild?.id;

    if (!guildId || !guildConfigService || typeof guildConfigService.resolveRuntimeConfig !== 'function') {
      await replySafely(message, 'This server has not finished AI setup yet. An administrator can run `/ai-setup api`.');
      return;
    }

    let runtimeConfig;

    try {
      runtimeConfig = await guildConfigService.resolveRuntimeConfig(guildId, message.channelId);
    } catch (error) {
      logProviderError(logger, guildId, error);
      await replySafely(message, 'I could not load this server\'s AI configuration. Try again in a bit.');
      return;
    }

    const activeAiConfig = runtimeConfig?.ai || runtimeConfig?.deepseek;
    if (!runtimeConfig?.configured || !activeAiConfig?.apiKey) {
      await replySafely(message, 'This server has not finished AI setup yet. An administrator can run `/ai-setup api`.');
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

      let claimText;
      let referencedMessage = null;
      if (hasReply) {
        try {
          referencedMessage = await message.fetchReference();
        } catch {
          await replySafely(message, 'I could not read the message you replied to. It may have been deleted or be inaccessible.');
          return;
        }
        claimText = buildReplyMentionText(referencedMessage, userMessageText);
      } else {
        claimText = buildMentionRequestText(userMessageText);
      }
      const qwenImages = activeAiConfig.provider === 'qwen'
        ? collectQwenImages(message, referencedMessage)
        : [];
      if (directImages.length > 0 && activeAiConfig.provider !== 'qwen') {
        await replySafely(message, 'Image analysis is available when this server uses Qwen. An administrator can select it with `/ai-setup api`.');
        return;
      }
      const userMemoryContext = userMemoryStore
        ? await runMemoryOperation(() => userMemoryStore.getRelevantContext({
          guildId,
          currentUser: authorMetadata,
          query: claimText,
          mentionedUserIds: getMentionedUserIds(message),
          excludeEventId: memoryEventId,
        }), logger, guildId) || ''
        : '';
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

      const providerCall = activeAiConfig.provider === 'gemma4'
        ? generateGemma
        : activeAiConfig.provider === 'qwen'
          ? generateQwen
          : factCheck;
      const answer = await providerCall(
        claimText,
        conversation,
        webSearchContext,
        authorMetadata,
        {
          providerConfig: activeAiConfig,
          effectiveBehavior: runtimeConfig.effectiveBehavior,
          fetchImpl,
          images: qwenImages,
          userMemoryContext,
        },
      );
      let finalAnswer = sanitizeDiscordMentions(compactAiResponse(
        answer,
        runtimeConfig.effectiveBehavior,
      ));

      if (webSearchResults.length > 0) {
        finalAnswer = appendWebSearchSources(finalAnswer, webSearchResults);
      }

      appendConversationTurn(conversation, claimText, finalAnswer, authorMetadata);
      if (userMemoryStore && memoryEventId) {
        await runMemoryOperation(() => userMemoryStore.recordAssistantReply({
          eventId: `${memoryEventId}:assistant`,
          replyToEventId: memoryEventId,
          guildId,
          channelId: message.channelId,
          userId: message.author.id,
          content: finalAnswer,
          timestamp: Date.now(),
        }), logger, guildId);
      }
      await replySafely(message, finalAnswer);
    } catch (error) {
      if (error instanceof RequestGateError) {
        await replySafely(message, getRequestGateFailureMessage(error));
        return;
      }

      logProviderError(logger, guildId, error);

      if (shouldResetConversationAfterError(error)
        || shouldResetConversationAfterGeminiError(error)
        || shouldResetConversationAfterQwenError(error)) {
        resetConversation(conversationKey);
      }

      await replySafely(
        message,
        error?.name?.startsWith('Gemini')
          ? getGeminiFailureMessage(error)
          : error?.name?.startsWith('Qwen')
            ? getQwenFailureMessage(error)
            : getDeepSeekFailureMessage(error),
      );
    } finally {
      releaseGate?.();
    }
  };
}

module.exports = {
  createMessageCreateHandler,
  getMentionedUserIds,
  replyWithHelpEmbeds,
  runMemoryOperation,
};
