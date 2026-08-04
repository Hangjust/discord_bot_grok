const {
  getBotHelpMessage,
  getGrokHelpMessage,
  isBotHelpCommand,
  isGrokHelpCommand,
} = require('../commands/help');
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
const { buildSafeReplyOptions, replySafely } = require('../discord/mentions');
const { enforceLanguagePolicy } = require('../chat/contentPolicy');

function replyWithLanguagePolicy(message, content, config) {
  return replySafely(message, enforceLanguagePolicy(content, config?.persona?.profanity));
}

async function finishProgressReply(message, progressMessage, content, config) {
  const filteredContent = enforceLanguagePolicy(content, config?.persona?.profanity);
  if (typeof progressMessage?.edit === 'function') {
    try {
      return await progressMessage.edit(buildSafeReplyOptions(filteredContent));
    } catch {
      // Fall back to a fresh reply if the progress message disappeared.
    }
  }
  return replySafely(message, filteredContent);
}

async function handleNnCommand(message, config) {
  let text = getNnCommandText(message.content);
  if (!text && message.reference?.messageId && typeof message.fetchReference === 'function') {
    try {
      const referencedMessage = await message.fetchReference();
      text = String(referencedMessage?.content ?? '').trim();
    } catch {
      await replyWithLanguagePolicy(message, 'I could not read the message you replied to.', config);
      return;
    }
  }

  await replyWithLanguagePolicy(message, text ? translateToGoblinMode(text) : getNnUsageMessage(), config);
}

async function handleBludCommand(message, conversation, config) {
  const parsed = parseBludCommand(message.content);
  if (parsed.action === 'deactivate') {
    conversation.goblinMode = false;
    await replyWithLanguagePolicy(message, translateToBludMode('blud mode off... we chillin now'), config);
    return;
  }

  conversation.goblinMode = true;
  if (parsed.action === 'translate' && parsed.text) {
    await replyWithLanguagePolicy(message, translateToBludMode(parsed.text), config);
    return;
  }
  await replyWithLanguagePolicy(message, translateToBludMode('blud mode activated... we outside now no cap'), config);
}

async function handleFunmuteCommand(message, config) {
  const requesterMember = message.member;
  const botMember = message.guild?.members?.me;
  const parsed = parseFunmuteCommand(message.content);
  const targetMember = message.mentions?.members?.first?.() ?? null;
  const durationMs = parsed ? getFunmuteDurationMs(parsed.seconds) : null;
  if (durationMs == null) {
    await replyWithLanguagePolicy(message, getFunmuteUsageMessage(), config);
    return;
  }

  const validationError = getFunmuteValidationError(message, requesterMember, botMember, targetMember);
  if (validationError) {
    await replyWithLanguagePolicy(message, validationError, config);
    return;
  }

  if (!consumeFunmuteCooldown(message.guild.id)) {
    await replyWithLanguagePolicy(message, 'Funmute is cooling down. Try again in a moment.', config);
    return;
  }

  let timeoutPromise;
  try {
    // Start the moderation request before doing any extra Discord I/O.
    timeoutPromise = Promise.resolve(targetMember.timeout(
      durationMs,
      `Funmute requested by ${requesterMember.user.tag} for ${parsed.seconds} second(s).`,
    ));
  } catch (error) {
    timeoutPromise = Promise.reject(error);
  }
  const progressPromise = replyWithLanguagePolicy(message, '⏳ Applying funmute…', config)
    .catch(() => null);

  try {
    await timeoutPromise;
    const progressMessage = await progressPromise;
    await finishProgressReply(
      message,
      progressMessage,
      `Bonk. ${targetMember.user.tag} is timed out for ${parsed.seconds} second(s).`,
      config,
    );
  } catch (error) {
    console.error('Funmute failed.', { name: error?.name, guildId: message.guildId });
    const progressMessage = await progressPromise;
    await finishProgressReply(
      message,
      progressMessage,
      'I tried to funmute them, but Discord rejected it.',
      config,
    );
  }
}

async function handleLegacyCommand(message, config, conversation) {
  const content = String(message.content ?? '');
  if (isBotHelpCommand(content)) {
    await replyWithLanguagePolicy(
      message,
      isGrokHelpCommand(content) ? getGrokHelpMessage() : getBotHelpMessage(config),
      config,
    );
    return true;
  }
  if (content.trim().toLowerCase() === '!ping') {
    await replyWithLanguagePolicy(message, 'Pong!', config);
    return true;
  }
  if (isNnCommand(content)) {
    await handleNnCommand(message, config);
    return true;
  }
  if (isBludCommand(content)) {
    await handleBludCommand(message, conversation, config);
    return true;
  }
  if (/^!funmute(?:\s|$)/i.test(content.trim())) {
    await handleFunmuteCommand(message, config);
    return true;
  }
  if (isRatioCommand(content)) {
    await handleRatioCommand(message);
    return true;
  }
  return false;
}

function isLegacyCommand(content) {
  const text = String(content ?? '');
  return isBotHelpCommand(text)
    || text.trim().toLowerCase() === '!ping'
    || isNnCommand(text)
    || isBludCommand(text)
    || /^!funmute(?:\s|$)/i.test(text.trim())
    || isRatioCommand(text);
}

module.exports = {
  handleBludCommand,
  handleFunmuteCommand,
  handleLegacyCommand,
  handleNnCommand,
  isLegacyCommand,
};
