const {
  idleChatterInactivityMs,
  idleChatterMessages,
  replyAllowedChannelIds,
} = require('../config/constants');
const { canReplyInChannel } = require('../discord/channel');
const { buildSafeReplyOptions } = require('../discord/mentions');

const guildIdleChatterStates = new Map();
const maxIdleChatterGuilds = 2048;
const idleChatterStateTtlMs = 7 * 24 * 60 * 60 * 1000;
const idleChatterCleanupIntervalMs = 60 * 60 * 1000;

function deleteIdleChatterState(guildId, state = guildIdleChatterStates.get(guildId)) {
  if (!state) return;

  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.channel = null;
  state.allowConfiguredChannel = false;
  guildIdleChatterStates.delete(guildId);
}

function pruneIdleChatterStates(now = Date.now()) {
  for (const [guildId, state] of guildIdleChatterStates) {
    if (!state.timer && now - state.lastMessageAt >= idleChatterStateTtlMs) {
      deleteIdleChatterState(guildId, state);
    }
  }
}

function evictOldestIdleChatterState() {
  let oldestGuildId = null;
  let oldestMessageAt = Infinity;

  for (const [guildId, state] of guildIdleChatterStates) {
    if (oldestGuildId === null || state.lastMessageAt < oldestMessageAt) {
      oldestGuildId = guildId;
      oldestMessageAt = state.lastMessageAt;
    }
  }

  if (oldestGuildId !== null) deleteIdleChatterState(oldestGuildId);
}

const idleChatterCleanupTimer = setInterval(
  pruneIdleChatterStates,
  idleChatterCleanupIntervalMs,
);
idleChatterCleanupTimer.unref?.();

function getIdleChatterState(guildId) {
  const existingState = guildIdleChatterStates.get(guildId);

  if (existingState) {
    return existingState;
  }

  const state = {
    channel: null,
    allowConfiguredChannel: false,
    lastMessageAt: 0,
    timer: null,
  };

  while (guildIdleChatterStates.size >= maxIdleChatterGuilds) {
    evictOldestIdleChatterState();
  }

  guildIdleChatterStates.set(guildId, state);
  return state;
}

function shouldRunIdleChatter(state, now = Date.now()) {
  return Boolean(state?.channel) && now - state.lastMessageAt >= idleChatterInactivityMs;
}

function getChannelGuildId(channel) {
  return channel?.guildId ?? channel?.guild?.id ?? null;
}

function recordGuildIdleChatterChannel(channel, now = Date.now(), timerFn = setTimeout, options = {}) {
  const guildId = getChannelGuildId(channel);
  const allowed = options.allowConfiguredChannel || canReplyInChannel(channel?.id);

  if (!guildId || !allowed || typeof channel.send !== 'function') {
    return null;
  }

  const state = getIdleChatterState(guildId);
  state.channel = channel;
  state.allowConfiguredChannel = Boolean(options.allowConfiguredChannel);
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

async function startConfiguredGuildIdleChatterTimers(discordClient, store, concurrency = 4) {
  const iterator = discordClient.guilds?.cache?.values?.();
  if (!iterator || !store) return 0;
  let startedCount = 0;
  const workerCount = Math.max(1, Math.min(16, Number(concurrency) || 1));
  const worker = async () => {
    for (;;) {
      const next = iterator.next();
      if (next.done) return;
      const guild = next.value;
      let config;
      try {
        config = await store.get(guild.id);
      } catch {
        continue;
      }
      for (const channelId of config.access?.channelIds ?? []) {
        const channel = guild.channels?.cache?.get?.(channelId)
          ?? discordClient.channels?.cache?.get?.(channelId);
        if (typeof channel?.send !== 'function') continue;
        recordGuildIdleChatterChannel(channel, Date.now(), setTimeout, {
          allowConfiguredChannel: true,
        });
        startedCount += 1;
        break;
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return startedCount;
}

async function sendIdleChatter(state) {
  if (!state?.channel) {
    return null;
  }

  if ((!state.allowConfiguredChannel && !canReplyInChannel(state.channel.id)) || typeof state.channel.send !== 'function') {
    return null;
  }

  let previousMessage = await state.channel.send(buildSafeReplyOptions(idleChatterMessages[0]));

  for (const content of idleChatterMessages.slice(1)) {
    previousMessage = await previousMessage.reply(buildSafeReplyOptions(content));
  }

  return previousMessage;
}

function scheduleGuildIdleChatter(guildId, timerFn = setTimeout, delayMs = idleChatterInactivityMs) {
  const state = getIdleChatterState(guildId);
  if (state.timer) return state.timer;

  state.timer = timerFn(async () => {
    state.timer = null;

    if (!shouldRunIdleChatter(state)) {
      const remainingMs = Math.max(
        1,
        idleChatterInactivityMs - (Date.now() - state.lastMessageAt),
      );
      scheduleGuildIdleChatter(guildId, timerFn, remainingMs);
      return;
    }

    try {
      await sendIdleChatter(state);
    } catch (error) {
      console.error('Idle chatter delivery failed.', { name: error?.name, guildId });
    }
  }, Math.max(1, delayMs));
  state.timer?.unref?.();

  return state.timer;
}

function recordGuildUserMessage(message, now = Date.now(), timerFn = setTimeout, options = {}) {
  if (!message.guildId) {
    return null;
  }

  const state = getIdleChatterState(message.guildId);

  if ((options.allowConfiguredChannel || canReplyInChannel(message.channelId)) && typeof message.channel?.send === 'function') {
    state.channel = message.channel;
    state.allowConfiguredChannel = Boolean(options.allowConfiguredChannel);
  }

  state.lastMessageAt = now;
  scheduleGuildIdleChatter(message.guildId, timerFn);

  return state;
}

function deleteGuildIdleChatterState(guildId) {
  const normalizedGuildId = String(guildId);
  const state = guildIdleChatterStates.get(normalizedGuildId)
    ?? guildIdleChatterStates.get(guildId);
  if (!state) return false;
  deleteIdleChatterState(normalizedGuildId, state);
  if (guildIdleChatterStates.get(guildId) === state) guildIdleChatterStates.delete(guildId);
  return true;
}

function deleteIdleChatterStateForChannel(guildId, channelId) {
  const state = guildIdleChatterStates.get(String(guildId))
    ?? guildIdleChatterStates.get(guildId);
  if (!state || state.channel?.id !== channelId) return false;
  return deleteGuildIdleChatterState(guildId);
}

module.exports = {
  getIdleChatterState,
  deleteGuildIdleChatterState,
  deleteIdleChatterStateForChannel,
  recordGuildIdleChatterChannel,
  recordGuildUserMessage,
  sendIdleChatter,
  shouldRunIdleChatter,
  startGuildIdleChatterTimers,
  startConfiguredGuildIdleChatterTimers,
};
