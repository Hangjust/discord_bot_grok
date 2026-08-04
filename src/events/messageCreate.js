const { PermissionFlagsBits } = require('discord.js');
const { isBludCommand, parseBludCommand } = require('../commands/blud');
const { handleChannelAccessCommand } = require('../commands/channelAccess');
const { canAccessChat } = require('../chat/access');
const { enforceLanguagePolicy } = require('../chat/contentPolicy');
const {
  enqueueCoalescedConversationTask,
  runInConversationQueue,
} = require('../chat/conversationQueue');
const {
  consumeChatLimit,
  consumeWebSearchLimit,
  consumeUtilityLimit,
  getChatRateLimitMessage,
  releaseChatLimit,
  releaseWebSearchLimit,
} = require('../chat/rateLimit');
const { ResponseDeliveryCancelledError, sendConfiguredResponse } = require('../chat/renderer');
const {
  extractWakeWordRequest,
  getReferencedAuthorId,
  isBotMentioned,
  isReplyToBot,
  matchesWakeWord,
} = require('../chat/triggers');
const { deepSeekBaseUrl, deepSeekTimeoutMs } = require('../config/env');
const { getMentionText, replySafely } = require('../discord/mentions');
const {
  appendConversationTurn,
  appendConversationUserMessage,
  getConversation,
  getConversationKey,
  resetConversationIfCurrent,
  resetConversation,
} = require('../state/conversations');
const { recordGuildUserMessage } = require('../state/idleChatter');
const {
  getCurrentUserProfileSummary,
  getCurrentUserStatsReply,
  recordMonthlyUserMessage,
} = require('../state/userProfiles');
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
const {
  getPlainGrokText,
  isNewConversationCommand,
  isPlainGrokTrigger,
} = require('../grok/triggers');
const {
  DeepSeekApiError,
  generateChatResponse,
  getDeepSeekFailureMessage,
  shouldResetConversationAfterError,
} = require('../services/deepseek');
const {
  appendWebSearchSources,
  formatWebSearchContext,
  getWebSearchFailureMessage,
  getWebSearchNoResultsMessage,
  getWebSearchUnavailableMessage,
  hasExplicitInternetSearchRequest,
  isWebSearchConfigured,
  searchWeb,
  shouldUseInternetSearch,
} = require('../services/webSearch');
const { isNormalizedGuildConfigReady } = require('../storage/guildConfigStore');
const {
  handleRoleplayCooldownCommand,
  handleRoleplayMessage,
  handleRoleplayPanelCommand,
  recognizeRoleplayTicketChannel,
} = require('../roleplay');
const { ensureSetupPanel, refreshSetupPanel } = require('../setup/panel');
const { isMessageAuthorGuildOwnerOrAdministrator } = require('../setup/permissions');
const { handleLegacyCommand, isLegacyCommand } = require('./legacyCommands');

function getMessageAuthorMetadata(message) {
  return {
    userId: String(message.author.id),
    displayName: message.member?.displayName
      ?? message.author.globalName
      ?? message.author.displayName
      ?? message.author.username,
    username: message.author.username,
  };
}

function snapshotPassiveContextMessage(message, authorMetadata) {
  const roleCache = message.member?.roles?.cache;
  return {
    guildId: String(message.guildId ?? message.guild?.id),
    channel: {
      id: String(message.channelId ?? message.channel?.id),
      parentId: message.channel?.parentId ?? null,
      type: message.channel?.type,
    },
    member: {
      roleIds: roleCache?.keys ? Array.from(roleCache.keys(), String) : [],
    },
    content: String(message.content ?? ''),
    authorMetadata,
  };
}

function queuePassiveContext(conversationKey, snapshot, contextLimit, store) {
  enqueueCoalescedConversationTask(
    conversationKey,
    snapshot,
    contextLimit,
    async (pendingMessages, isQueueCurrent) => {
      if (!isQueueCurrent() || pendingMessages.length === 0) return;
      const latestConfig = await store.get(snapshot.guildId);
      const latestLimit = getContextLimit(latestConfig);
      if (!isQueueCurrent() || latestLimit <= 0) return;
      const conversation = getConversation(conversationKey);
      for (const pending of pendingMessages) {
        if (!canAccessChat(pending, latestConfig)) continue;
        appendConversationUserMessage(conversation, pending.content, {
          author: pending.authorMetadata,
          maxMessages: latestLimit,
        });
      }
    },
  );
}

function getContextLimit(config) {
  const value = Number(config?.advanced?.contextMessages ?? 10);
  return [0, 5, 10, 20].includes(value) ? value : 10;
}

function canBotRespondInChannel(message, config) {
  const botMember = message.guild?.members?.me;
  const permissions = botMember && message.channel?.permissionsFor?.(botMember);
  if (!permissions) return false;

  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
  if (message.channel.isThread?.()) required.push(PermissionFlagsBits.SendMessagesInThreads);
  else required.push(PermissionFlagsBits.SendMessages);
  if (config?.persona?.responseFormat === 'embed') required.push(PermissionFlagsBits.EmbedLinks);
  return permissions.has(required);
}

function getPersonaGenerationSignature(config) {
  const persona = config?.persona ?? {};
  return JSON.stringify({
    characterName: persona.characterName,
    behavior: persona.behavior,
    customPrompt: persona.customPrompt,
  });
}

function extractCurrentRequestText(message, config, botUserId) {
  const content = String(message.content ?? '');
  const triggerWord = config.persona.triggerWord;
  let requestText;

  if (matchesWakeWord(content, triggerWord)) {
    requestText = extractWakeWordRequest(content, triggerWord);
  } else if (isPlainGrokTrigger(content)) {
    requestText = getPlainGrokText(content);
  } else if (isBotMentioned(message, botUserId)) {
    requestText = getMentionText(content, botUserId);
  } else {
    requestText = content.trim();
  }

  if (!requestText) {
    requestText = 'Greet me briefly and ask what I would like help with.';
  }

  return requestText;
}

function getReferencedBotText(referencedMessage, botUserId) {
  if (referencedMessage?.author?.id !== botUserId) {
    return '';
  }

  return [
    referencedMessage.content,
    ...(referencedMessage.embeds ?? []).flatMap((embed) => [embed?.title, embed?.description]),
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 1500);
}

function buildCurrentRequest(message, config, botUserId, referencedMessage = null) {
  const requestText = extractCurrentRequestText(message, config, botUserId);
  const quotedText = getContextLimit(config) === 0
    ? getReferencedBotText(referencedMessage, botUserId)
    : '';

  if (quotedText) {
    return [
      'UNTRUSTED REFERENCED BOT MESSAGE (context only):',
      quotedText,
      'END REFERENCED BOT MESSAGE',
      '',
      `Current request: ${requestText}`,
    ].join('\n');
  }

  return requestText;
}

function shouldSearchWeb(requestText, config) {
  const mode = config?.advanced?.webSearchMode ?? 'off';
  if (mode === 'on_request') {
    return hasExplicitInternetSearchRequest(requestText);
  }
  if (mode === 'automatic') {
    return shouldUseInternetSearch(requestText);
  }
  return false;
}

async function getReferencedMessageIfNeeded(message) {
  if (message.referencedMessage) return message.referencedMessage;
  if (!message.reference?.messageId || typeof message.fetchReference !== 'function') {
    return null;
  }

  try {
    return await message.fetchReference();
  } catch {
    return null;
  }
}

async function handleSetupCommand(message, store) {
  if (String(message.content ?? '').trim().toLowerCase() !== '!setup') {
    return false;
  }

  if (!isMessageAuthorGuildOwnerOrAdministrator(message)) {
    await replySafely(message, 'Only the server owner or an administrator can post the setup panel.');
    return true;
  }

  const panel = await ensureSetupPanel(message.guild, store, {
    force: true,
    channel: message.channel,
  });
  if (!panel) {
    await replySafely(message, 'I need View Channel, Send Messages, and Embed Links in a text channel before I can post setup.');
  }
  return true;
}

async function updateProviderState(store, guildId, status, expectedFingerprint) {
  let changed = false;
  await store.update(guildId, (current) => {
    if (!current.provider?.encryptedKey
      || current.provider.fingerprint !== expectedFingerprint
      || current.provider.keyStatus === status) {
      return current;
    }
    changed = true;
    return {
      ...current,
      provider: {
        ...current.provider,
        keyStatus: status,
        checkedAt: new Date().toISOString(),
      },
    };
  });
  return changed;
}

async function clearProviderKeyIfCurrent(store, guildId, expectedFingerprint) {
  let cleared = false;
  await store.update(guildId, (current) => {
    if (!current.provider?.encryptedKey || current.provider.fingerprint !== expectedFingerprint) {
      return current;
    }
    cleared = true;
    return {
      ...current,
      provider: {
        encryptedKey: null,
        keyStatus: 'unchecked',
        checkedAt: null,
        fingerprint: null,
      },
    };
  });
  return cleared;
}

function startTyping(message) {
  try {
    Promise.resolve(message.channel?.sendTyping?.()).catch(() => null);
  } catch {
    // Typing is best-effort feedback and must never delay or fail the request.
  }
}

function refreshSetupPanelInBackground(guild, store) {
  Promise.resolve(refreshSetupPanel(guild, store)).catch(() => null);
}

function getScopedProfileUserId(message, userId) {
  return `${String(message.guildId ?? message.guild?.id)}:${String(userId)}`;
}

function shouldRecordProfileMessage(message, requestText, isDirectTrigger) {
  const bludCommand = isBludCommand(message.content)
    ? parseBludCommand(message.content)
    : null;
  if (bludCommand && bludCommand.action !== 'translate') return false;
  return !(isDirectTrigger && isGrokStatsCommand(requestText));
}

async function handleLocalGrokCommand(message, requestText, conversationKey) {
  const conversation = getConversation(conversationKey);
  const authorMetadata = getMessageAuthorMetadata(message);

  if (isNewConversationCommand(requestText)) {
    resetConversation(conversationKey);
    await replySafely(message, 'New conversation started.');
    return true;
  }
  if (!requestText && !message.reference?.messageId) {
    await replySafely(message, 'Grok Grok');
    return true;
  }
  if (isGrokLoreCommand(requestText)) {
    const loreReply = buildLoreReply(conversation);
    appendConversationTurn(conversation, requestText, loreReply, authorMetadata);
    await replySafely(message, loreReply);
    return true;
  }
  if (isGrokStatsCommand(requestText)) {
    const statsReply = getCurrentUserStatsReply(
      getScopedProfileUserId(message, message.author.id),
    );
    appendConversationUserMessage(conversation, requestText, authorMetadata);
    await replySafely(message, statsReply);
    return true;
  }
  if (isGrokWhoIsCommand(requestText)) {
    const targetUserId = getMentionedUserId(message);
    if (!targetUserId) {
      const fallbackReply = 'Usage: `grok who is @user` so I know which goblin file to open.';
      appendConversationTurn(conversation, requestText, fallbackReply, authorMetadata);
      await replySafely(message, fallbackReply);
      return true;
    }
    const targetName = getDisplayNameForUser(
      message,
      targetUserId,
      parseGrokWhoIsTarget(requestText),
    );
    const targetSummary = getCurrentUserProfileSummary(
      getScopedProfileUserId(message, targetUserId),
    );
    const whoIsReply = buildWhoIsReply(targetName, targetSummary);
    appendConversationUserMessage(conversation, requestText, authorMetadata);
    await replySafely(message, whoIsReply);
    return true;
  }
  return false;
}

async function handleRoleplayRouting(message, store, dependencies) {
  const normalizedContent = String(message.content ?? '').trim().toLowerCase();
  const isRoleplayCommand = normalizedContent === '!rp'
    || normalizedContent === '!roleplay panel'
    || normalizedContent === '!roleplay close'
    || normalizedContent.startsWith('!roleplay cooldown');
  const recognition = recognizeRoleplayTicketChannel(message);
  if ((isRoleplayCommand || recognition.kind !== 'none') && !consumeUtilityLimit({
    guildId: message.guild.id,
    userId: message.author.id,
  })) return true;
  if (await handleRoleplayPanelCommand(message)) return true;
  if (await handleRoleplayCooldownCommand(message)) return true;
  if (recognition.kind === 'none') return false;

  const conversationKey = getConversationKey(message);
  let apiKey = null;
  try {
    await runInConversationQueue(conversationKey, async (isQueueCurrent, signal) => {
      if (!isQueueCurrent()) return;
      await handleRoleplayMessage(message, {
        baseUrl: deepSeekBaseUrl,
        fetchImpl: dependencies.fetchImpl,
        getApiKey: async (guildId) => {
          apiKey = store && typeof store.getApiKey === 'function'
            ? await store.getApiKey(guildId)
            : null;
          return apiKey;
        },
        reserveGeneration: (ticket) => consumeChatLimit({
          guildId: ticket.guildId,
          userId: message.author.id,
        }),
        releaseGeneration: releaseChatLimit,
        signal,
        timeoutMs: deepSeekTimeoutMs,
      });
    });
  } finally {
    apiKey = null;
  }
  return true;
}

async function runWebSearch(requestText, config, dependencies, guildId, signal) {
  if (!shouldSearchWeb(requestText, config)) {
    return { results: [], context: '' };
  }
  if (!isWebSearchConfigured()) {
    return { error: getWebSearchUnavailableMessage() };
  }

  const reservation = consumeWebSearchLimit({ guildId });
  if (!reservation.allowed) {
    return { error: 'Internet search has reached its usage limit. Please try again later.' };
  }
  try {
    const results = await searchWeb(requestText, undefined, dependencies.fetchImpl, { signal });
    if (results.length === 0) {
      return { error: getWebSearchNoResultsMessage() };
    }
    return { results, context: formatWebSearchContext(results) };
  } catch {
    return { error: getWebSearchFailureMessage() };
  } finally {
    releaseWebSearchLimit(reservation);
  }
}

function createMessageCreateHandler(client, store, dependencies = {}) {
  const generateResponse = dependencies.generateChatResponse ?? generateChatResponse;

  return async function handleMessageCreate(message) {
    if (message.author?.bot || !message.guild || !message.member) {
      return;
    }

    let accessGranted = false;
    try {
      if (String(message.content ?? '').trim().toLowerCase() === '!setup'
        && !consumeUtilityLimit({ guildId: message.guild.id, userId: message.author.id })) {
        return;
      }
      if (await handleChannelAccessCommand(message, store, client.user?.id)) return;
      if (await handleRoleplayRouting(message, store, dependencies)) return;
      if (await handleSetupCommand(message, store)) {
        return;
      }

      const config = await store.get(message.guild.id);

      // Default-deny before fetching replies, recording context, typing, commands,
      // searches, key decryption, or any paid AI request.
      if (!canAccessChat(message, config)) {
        return;
      }
      accessGranted = true;

      recordGuildUserMessage(message, Date.now(), setTimeout, { allowConfiguredChannel: true });
      const botUserId = client.user?.id;
      const mentionsBot = isBotMentioned(message, botUserId);
      const configuredWakeWordMatches = matchesWakeWord(
        message.content,
        config.persona?.triggerWord,
      );
      const legacyWakeWordMatches = isPlainGrokTrigger(message.content);
      const directTrigger = configuredWakeWordMatches || legacyWakeWordMatches || mentionsBot;
      const initialRequestText = extractCurrentRequestText(message, config, botUserId);
      if (shouldRecordProfileMessage(message, initialRequestText, directTrigger)) {
        recordMonthlyUserMessage(
          getScopedProfileUserId(message, message.author.id),
          message.content,
        );
      }

      let conversationKey;
      if (isLegacyCommand(message.content) && !consumeUtilityLimit({
        guildId: message.guild.id,
        userId: message.author.id,
      })) return;
      if (isBludCommand(message.content)) {
        conversationKey = getConversationKey(message);
        await runInConversationQueue(conversationKey, async (isQueueCurrent) => {
          if (!isQueueCurrent()) return;
          const latestConfig = await store.get(message.guild.id);
          if (canAccessChat(message, latestConfig)) {
            await handleLegacyCommand(message, latestConfig, getConversation(conversationKey));
          }
        });
        return;
      }
      if (await handleLegacyCommand(message, config, null)) return;

      const wakeWordMatches = configuredWakeWordMatches || legacyWakeWordMatches;
      const contextLimit = getContextLimit(config);
      const hasReference = Boolean(message.reference?.messageId || message.referencedMessage);
      let referencedMessage = message.referencedMessage ?? null;
      let referencedAuthorId = getReferencedAuthorId(message);

      // Gateway reply metadata normally identifies the replied user without a
      // REST call. Fetch only when that metadata is missing and it can affect
      // triggering or zero-context quoting.
      if (hasReference
        && referencedAuthorId == null
        && ((!mentionsBot && !wakeWordMatches) || contextLimit === 0)) {
        referencedMessage = await getReferencedMessageIfNeeded(message);
        referencedAuthorId = referencedMessage?.author?.id ?? null;
      }

      const repliesToBot = isReplyToBot(message, botUserId, referencedAuthorId);
      const isTriggered = wakeWordMatches || mentionsBot || repliesToBot;
      const authorMetadata = getMessageAuthorMetadata(message);

      const isPotentialLocalGrokCommand = (
        (!initialRequestText && !message.reference?.messageId)
        || isNewConversationCommand(initialRequestText)
        || isGrokLoreCommand(initialRequestText)
        || isGrokStatsCommand(initialRequestText)
        || isGrokWhoIsCommand(initialRequestText)
      );
      if (directTrigger && isPotentialLocalGrokCommand) {
        if (!consumeUtilityLimit({
          guildId: message.guild.id,
          userId: message.author.id,
        })) return;
        conversationKey = getConversationKey(message);
        let handledLocally = false;
        await runInConversationQueue(conversationKey, async (isQueueCurrent) => {
          if (!isQueueCurrent()) return;
          handledLocally = await handleLocalGrokCommand(
            message,
            initialRequestText,
            conversationKey,
          );
        });
        if (handledLocally) return;
      }

      if (!isTriggered) {
        if (contextLimit > 0) {
          conversationKey = getConversationKey(message);
          queuePassiveContext(
            conversationKey,
            snapshotPassiveContextMessage(message, authorMetadata),
            contextLimit,
            store,
          );
        }
        return;
      }

      if (contextLimit === 0 && repliesToBot && !referencedMessage) {
        referencedMessage = await getReferencedMessageIfNeeded(message);
      }

      if (!isNormalizedGuildConfigReady(config)) {
        await replySafely(message, 'This server has not finished the required bot setup yet. An owner or administrator can use `!setup`.');
        return;
      }
      if (!canBotRespondInChannel(message, config)) return;

      conversationKey ??= getConversationKey(message);
      const reservation = consumeChatLimit({
        guildId: message.guild.id,
        userId: message.author.id,
        cooldownSeconds: config.advanced?.cooldownSeconds,
      });
      if (!reservation.allowed) {
        await replySafely(message, getChatRateLimitMessage(reservation));
        return;
      }
      startTyping(message);

      let keySnapshot = {
        apiKey: null,
        fingerprint: config.provider.fingerprint,
        keyStatus: config.provider.keyStatus,
      };
      try {
        await runInConversationQueue(conversationKey, async (isQueueCurrent, signal) => {
          let activeConfig = await store.get(message.guild.id);
          if (!isQueueCurrent()
            || !isNormalizedGuildConfigReady(activeConfig)
            || !canAccessChat(message, activeConfig)
            || !canBotRespondInChannel(message, activeConfig)) {
            return;
          }

          keySnapshot = typeof store.getApiKeySnapshot === 'function'
            ? await store.getApiKeySnapshot(message.guild.id)
            : {
              apiKey: await store.getApiKey(message.guild.id),
              fingerprint: activeConfig.provider.fingerprint,
              keyStatus: activeConfig.provider.keyStatus,
            };

          let requestConversation = null;
          try {
            const activePersonaSignature = getPersonaGenerationSignature(activeConfig);
            const rawRequestText = extractCurrentRequestText(message, activeConfig, botUserId);
            const requestText = buildCurrentRequest(message, activeConfig, botUserId, referencedMessage);
            const webSearch = await runWebSearch(
              rawRequestText,
              activeConfig,
              dependencies,
              message.guild.id,
              signal,
            );
            if (!isQueueCurrent()) return;
            if (webSearch.error) {
              const latestConfig = await store.get(message.guild.id);
              if (canAccessChat(message, latestConfig)) {
                await replySafely(message, webSearch.error);
              }
              return;
            }

            const preProviderConfig = await store.get(message.guild.id);
            if (!isQueueCurrent()
              || preProviderConfig.provider.fingerprint !== keySnapshot.fingerprint
              || !canAccessChat(message, preProviderConfig)
              || !canBotRespondInChannel(message, preProviderConfig)
              || getPersonaGenerationSignature(preProviderConfig) !== activePersonaSignature) {
              return;
            }
            activeConfig = preProviderConfig;

            const activeConversation = getConversation(conversationKey);
            requestConversation = activeConversation;
            const answer = await generateResponse({
              apiKey: keySnapshot.apiKey,
              config: activeConfig,
              advanced: activeConfig.advanced,
              currentMessage: requestText,
              currentRequesterMetadata: authorMetadata,
              conversation: activeConversation,
              webSearchContext: webSearch.context,
              fetchImpl: dependencies.fetchImpl,
              baseUrl: deepSeekBaseUrl,
              timeoutMs: deepSeekTimeoutMs,
              signal,
            });
            if (!isQueueCurrent()) return;

            const latestConfig = await store.get(message.guild.id);
            if (!isNormalizedGuildConfigReady(latestConfig)
              || latestConfig.provider.fingerprint !== keySnapshot.fingerprint
              || !canAccessChat(message, latestConfig)
              || !canBotRespondInChannel(message, latestConfig)
              || getPersonaGenerationSignature(latestConfig) !== activePersonaSignature) {
              return;
            }

            const latestConversation = getConversation(conversationKey);
            let finalAnswer = appendWebSearchSources(answer, webSearch.results);
            if (latestConversation.goblinMode) {
              const { translateToGoblinMode } = require('../commands/nn');
              finalAnswer = translateToGoblinMode(finalAnswer);
            }
            finalAnswer = enforceLanguagePolicy(finalAnswer, latestConfig.persona.profanity);

            try {
              await sendConfiguredResponse(message, finalAnswer, latestConfig, {
                shouldContinue: () => isQueueCurrent()
                  && canAccessChat(message, latestConfig)
                  && canBotRespondInChannel(message, latestConfig),
              });
            } catch (error) {
              if (error instanceof ResponseDeliveryCancelledError) return;
              console.error('Discord response delivery failed.', {
                name: error?.name,
                guildId: message.guild.id,
                channelId: message.channelId,
              });
              return;
            }

            if (!isQueueCurrent() || !canAccessChat(message, latestConfig)) return;

            appendConversationTurn(latestConversation, requestText, finalAnswer, {
              author: authorMetadata,
              maxMessages: getContextLimit(latestConfig),
            });
            if (keySnapshot.keyStatus !== 'valid'
              && await updateProviderState(store, message.guild.id, 'valid', keySnapshot.fingerprint)) {
              refreshSetupPanelInBackground(message.guild, store);
            }
          } catch (error) {
            if (!isQueueCurrent()) return;
            console.error('AI provider request failed.', {
              name: error?.name,
              status: error instanceof DeepSeekApiError ? error.status : undefined,
              code: error instanceof DeepSeekApiError ? error.code : undefined,
              guildId: message.guild.id,
              userId: message.author.id,
            });

            let panelNeedsRefresh = false;
            if (error instanceof DeepSeekApiError && error.status === 401) {
              if (await clearProviderKeyIfCurrent(store, message.guild.id, keySnapshot.fingerprint)) {
                panelNeedsRefresh = true;
              }
            } else if (error instanceof DeepSeekApiError && error.status === 402) {
              if (await updateProviderState(store, message.guild.id, 'no_balance', keySnapshot.fingerprint)) {
                panelNeedsRefresh = true;
              }
            }
            if (shouldResetConversationAfterError(error) && requestConversation) {
              resetConversationIfCurrent(conversationKey, requestConversation);
            }
            const latestConfig = await store.get(message.guild.id);
            if (canAccessChat(message, latestConfig)) {
              await replySafely(message, getDeepSeekFailureMessage(error));
            }
            if (panelNeedsRefresh) refreshSetupPanelInBackground(message.guild, store);
          }
        });
      } finally {
        keySnapshot.apiKey = null;
        releaseChatLimit(reservation);
      }
    } catch (error) {
      console.error('Message handling failed.', {
        name: error?.name,
        guildId: message.guild?.id,
        userId: message.author?.id,
      });
      if (accessGranted) {
        await replySafely(message, 'I could not process that message right now.').catch(() => null);
      }
    }
  };
}

module.exports = {
  buildCurrentRequest,
  clearProviderKeyIfCurrent,
  createMessageCreateHandler,
  getContextLimit,
  getMessageAuthorMetadata,
  handleSetupCommand,
  runWebSearch,
  shouldSearchWeb,
  updateProviderState,
};
