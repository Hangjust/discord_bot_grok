const { deepSeekBaseUrl, deepSeekTimeoutMs } = require('../config/env');
const { consumeChatLimit, releaseChatLimit } = require('../chat/rateLimit');
const { runInConversationQueue } = require('../chat/conversationQueue');
const { generateRoleplayReply } = require('../roleplay/deepseek');
const {
  createInteractionCreateHandler: createRoleplayInteractionHandler,
} = require('../roleplay/interactions');
const {
  createSetupInteractionHandler,
  isSetupInteraction,
} = require('../setup/interactions');

function createInteractionCreateHandler(store, dependencies = {}) {
  const setupHandler = createSetupInteractionHandler(store, dependencies);
  const roleplayHandler = createRoleplayInteractionHandler({
    generateOpeningReply: (userText, ticket, session) => runInConversationQueue(
      `${ticket.guildId}:${ticket.channelId}`,
      async (isQueueCurrent, signal) => {
        let apiKey = null;
        let expectedFingerprint = null;
        const reservation = consumeChatLimit({
          guildId: ticket.guildId,
          userId: ticket.openerUserId,
        });
        try {
          if (!reservation.allowed || !isQueueCurrent()) {
            throw new Error('Roleplay generation is rate limited or cancelled.');
          }
          if (store && typeof store.getApiKeySnapshot === 'function') {
            const snapshot = await store.getApiKeySnapshot(ticket.guildId);
            apiKey = snapshot.apiKey;
            expectedFingerprint = snapshot.fingerprint;
          } else {
            apiKey = store && typeof store.getApiKey === 'function'
              ? await store.getApiKey(ticket.guildId)
              : null;
          }
          if (!apiKey || !isQueueCurrent()) {
            throw new Error('No current guild API key is configured for roleplay.');
          }
          const answer = await generateRoleplayReply(userText, ticket, session, {
            apiKey,
            baseUrl: deepSeekBaseUrl,
            fetchImpl: dependencies.fetchImpl,
            signal,
            timeoutMs: deepSeekTimeoutMs,
          });
          if (!isQueueCurrent()) throw new Error('Roleplay generation was cancelled.');
          if (expectedFingerprint && store && typeof store.get === 'function') {
            const latestConfig = await store.get(ticket.guildId);
            if (latestConfig.provider?.fingerprint !== expectedFingerprint) {
              throw new Error('Roleplay API key changed before delivery.');
            }
          }
          return answer;
        } finally {
          apiKey = null;
          releaseChatLimit(reservation);
        }
      },
    ),
  });

  return function handleInteractionCreate(interaction) {
    return isSetupInteraction(interaction)
      ? setupHandler(interaction)
      : roleplayHandler(interaction);
  };
}

module.exports = {
  createInteractionCreateHandler,
};
