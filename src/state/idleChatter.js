const {
  idleChatterInactivityMs,
  idleChatterMessages,
  replyAllowedChannelIds,
} = require('../config/constants');
const { canReplyInChannel } = require('../discord/channel');
const { buildSafeReplyOptions } = require('../discord/mentions');

const guildIdleChatterStates = new Map();

function getIdleChatterState(guildId) {
  const existingState = guildIdleChatterStates.get(guildId);

  if (existingState) {
    return existingState;
  }

  const state = {
    channel: null,
    lastMessageAt: 0,
    timer: null,
  };

  guildIdleChatterStates.set(guildId, state);
  return state;
}

function shouldRunIdleChatter(state, now = Date.now()) {
  return Boolean(state?.channel) && now - state.lastMessageAt >= idleChatterInactivityMs;
}

function getChannelGuildId(channel) {
  return channel?.guildId ?? channel?.guild?.id ?? null;
}

function recordGuildIdleChatterChannel(channel, now = Date.now(), timerFn = setTimeout) {
  const guildId = getChannelGuildId(channel);

  if (!guildId || !canReplyInChannel(channel.id) || typeof channel.send !== 'function') {
    return null;
  }

  const state = getIdleChatterState(guildId);
  state.channel = channel;
  state.lastMessageAt = now;
  scheduleGuildIdleChatter(guildId, timerFn);

  return state;
}

function startGuildIdleChatterTimers(discordClient, now = Date.now(), timerFn = setTimeout) {
  const channelCache = discordClient.channels?.cache;

  if (!channelCache || typeof channelCache.get !== 'function') {
    return [];
  }

  return replyAllowedChannelIds
    .map((channelId) => recordGuildIdleChatterChannel(channelCache.get(channelId), now, timerFn))
    .filter(Boolean);
}

async function sendIdleChatter(state) {
  if (!state?.channel) {
    return null;
  }

  if (!canReplyInChannel(state.channel.id) || typeof state.channel.send !== 'function') {
    return null;
  }

  let previousMessage = await state.channel.send(buildSafeReplyOptions(idleChatterMessages[0]));

  for (const content of idleChatterMessages.slice(1)) {
    previousMessage = await previousMessage.reply(buildSafeReplyOptions(content));
  }

  return previousMessage;
}

function clearGuildIdleChatterTimer(guildId) {
  const state = guildIdleChatterStates.get(guildId);

  if (state?.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function scheduleGuildIdleChatter(guildId, timerFn = setTimeout) {
  const state = getIdleChatterState(guildId);

  clearGuildIdleChatterTimer(guildId);

  state.timer = timerFn(async () => {
    state.timer = null;

    if (!shouldRunIdleChatter(state)) {
      return;
    }

    try {
      await sendIdleChatter(state);
    } catch (error) {
      console.error(error);
    }
  }, idleChatterInactivityMs);

  return state.timer;
}

function recordGuildUserMessage(message, now = Date.now(), timerFn = setTimeout) {
  if (!message.guildId) {
    return null;
  }

  const state = getIdleChatterState(message.guildId);

  if (canReplyInChannel(message.channelId) && typeof message.channel?.send === 'function') {
    state.channel = message.channel;
  }

  state.lastMessageAt = now;
  scheduleGuildIdleChatter(message.guildId, timerFn);

  return state;
}

module.exports = {
  getIdleChatterState,
  recordGuildIdleChatterChannel,
  recordGuildUserMessage,
  sendIdleChatter,
  shouldRunIdleChatter,
  startGuildIdleChatterTimers,
};
