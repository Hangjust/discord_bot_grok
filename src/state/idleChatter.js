const {
  idleChatterInactivityMs,
  idleChatterMessages,
} = require('../config/constants');
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
    isChannelEligible: null,
  };

  guildIdleChatterStates.set(guildId, state);
  return state;
}

function peekIdleChatterState(guildId) {
  return guildIdleChatterStates.get(guildId) || null;
}

function shouldRunIdleChatter(state, now = Date.now()) {
  return Boolean(state?.channel) && now - state.lastMessageAt >= idleChatterInactivityMs;
}

function getChannelGuildId(channel) {
  return channel?.guildId ?? channel?.guild?.id ?? null;
}

async function isEligibleChannel(channel, evaluator) {
  return Boolean(channel
    && typeof channel.send === 'function'
    && typeof evaluator === 'function'
    && await evaluator(channel));
}

async function recordGuildIdleChatterChannel(channel, now = Date.now(), timerFn = setTimeout, isChannelEligible) {
  const guildId = getChannelGuildId(channel);

  if (!guildId || !await isEligibleChannel(channel, isChannelEligible)) {
    return null;
  }

  const state = getIdleChatterState(guildId);
  state.channel = channel;
  state.lastMessageAt = now;
  state.isChannelEligible = isChannelEligible;
  scheduleGuildIdleChatter(guildId, timerFn);

  return state;
}

async function startGuildIdleChatterTimers(discordClient, isChannelEligible, now = Date.now(), timerFn = setTimeout) {
  const channelCache = discordClient.channels?.cache;

  if (!channelCache || typeof channelCache.values !== 'function') {
    return [];
  }

  const states = await Promise.all([...channelCache.values()]
    .map((channel) => recordGuildIdleChatterChannel(channel, now, timerFn, isChannelEligible)));

  return states.filter(Boolean);
}

function clearGuildIdleChatterTimer(guildId) {
  const state = guildIdleChatterStates.get(guildId);

  if (state?.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function invalidateGuildIdleChatter(guildId) {
  clearGuildIdleChatterTimer(guildId);
  guildIdleChatterStates.delete(guildId);
}

async function sendIdleChatter(state) {
  if (!state?.channel || !await isEligibleChannel(state.channel, state.isChannelEligible)) {
    if (state) {
      state.channel = null;
    }
    return null;
  }

  let previousMessage = await state.channel.send(buildSafeReplyOptions(idleChatterMessages[0]));

  for (const content of idleChatterMessages.slice(1)) {
    previousMessage = await previousMessage.reply(buildSafeReplyOptions(content));
  }

  return previousMessage;
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

function recordGuildUserMessage(message, now = Date.now(), timerFn = setTimeout, isChannelEligible) {
  if (!message.guildId || typeof message.channel?.send !== 'function') {
    return null;
  }

  const state = getIdleChatterState(message.guildId);
  state.channel = message.channel;
  state.lastMessageAt = now;
  state.isChannelEligible = isChannelEligible;
  scheduleGuildIdleChatter(message.guildId, timerFn);

  return state;
}

module.exports = {
  getIdleChatterState,
  invalidateGuildIdleChatter,
  peekIdleChatterState,
  recordGuildIdleChatterChannel,
  recordGuildUserMessage,
  sendIdleChatter,
  shouldRunIdleChatter,
  startGuildIdleChatterTimers,
};
