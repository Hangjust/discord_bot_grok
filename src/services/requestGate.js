const minuteMs = 60 * 1000;

function parseLimit(value, fallback, minimum = 1, maximum = 10000) {
  const parsed = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, minimum), maximum);
}

class RequestGateError extends Error {
  constructor(reason) {
    super('AI request rejected by request gate.');
    this.name = 'RequestGateError';
    this.reason = reason;
  }
}

function getRequestGateFailureMessage(error) {
  if (!(error instanceof RequestGateError)) {
    return 'I cannot start that request right now. Try again in a bit.';
  }

  if (error.reason === 'concurrency') {
    return 'This server already has too many AI requests running. Try again when one finishes.';
  }

  if (error.reason === 'user-rate-limit') {
    return 'You hit the per-minute AI request limit. Try again in a minute.';
  }

  return 'This server hit its per-minute AI request limit. Try again in a minute.';
}

function createRequestGate(options = {}) {
  const env = options.env || process.env;
  const now = options.now || Date.now;
  const maxConcurrentPerGuild = parseLimit(
    options.maxConcurrentPerGuild ?? env.DEEPSEEK_MAX_CONCURRENT_PER_GUILD,
    2,
    1,
    20,
  );
  const maxRequestsPerGuildPerMinute = parseLimit(
    options.maxRequestsPerGuildPerMinute ?? env.DEEPSEEK_MAX_REQUESTS_PER_GUILD_PER_MINUTE,
    40,
    1,
    1000,
  );
  const maxRequestsPerUserPerMinute = parseLimit(
    options.maxRequestsPerUserPerMinute ?? env.DEEPSEEK_MAX_REQUESTS_PER_USER_PER_MINUTE,
    8,
    1,
    120,
  );
  const guildStates = new Map();
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  let cleanupTimer = null;
  let cleanupDueAt = Infinity;

  function getState(guildId) {
    let state = guildStates.get(guildId);

    if (!state) {
      state = {
        active: 0,
        guildRequests: [],
        userRequests: new Map(),
      };
      guildStates.set(guildId, state);
    }

    return state;
  }

  function prune(timestamps, cutoff) {
    let firstCurrentIndex = 0;

    while (firstCurrentIndex < timestamps.length && timestamps[firstCurrentIndex] <= cutoff) {
      firstCurrentIndex += 1;
    }

    if (firstCurrentIndex > 0) {
      timestamps.splice(0, firstCurrentIndex);
    }
  }

  function pruneState(state, cutoff) {
    prune(state.guildRequests, cutoff);

    for (const [trackedUserId, timestamps] of state.userRequests) {
      prune(timestamps, cutoff);

      if (timestamps.length === 0) {
        state.userRequests.delete(trackedUserId);
      }
    }
  }

  function getNextExpiry() {
    let nextExpiry = Infinity;

    for (const state of guildStates.values()) {
      if (state.guildRequests.length > 0) {
        nextExpiry = Math.min(nextExpiry, state.guildRequests[0] + minuteMs + 1);
      }
    }

    return nextExpiry;
  }

  function scheduleCleanup(dueAt = getNextExpiry()) {
    if (!Number.isFinite(dueAt)) {
      if (cleanupTimer) {
        clearTimer(cleanupTimer);
        cleanupTimer = null;
      }

      cleanupDueAt = Infinity;
      return;
    }

    if (cleanupTimer && cleanupDueAt <= dueAt) {
      return;
    }

    if (cleanupTimer) {
      clearTimer(cleanupTimer);
    }

    cleanupDueAt = dueAt;
    cleanupTimer = setTimer(() => {
      cleanupTimer = null;
      cleanupDueAt = Infinity;
      cleanupExpired(Number(now()));
      scheduleCleanup();
    }, Math.max(0, dueAt - Number(now())));
    cleanupTimer?.unref?.();
  }

  function cleanupExpired(timestamp = Number(now())) {
    const cutoff = timestamp - minuteMs;

    for (const [guildId, state] of guildStates) {
      pruneState(state, cutoff);

      if (state.active === 0 && state.guildRequests.length === 0 && state.userRequests.size === 0) {
        guildStates.delete(guildId);
      }
    }
  }

  function acquire(guildIdValue, userIdValue) {
    const guildId = String(guildIdValue || '').trim();
    const userId = String(userIdValue || '').trim();

    if (!guildId || !userId) {
      throw new TypeError('guildId and userId are required');
    }

    const timestamp = Number(now());
    cleanupExpired(timestamp);
    const state = getState(guildId);
    const userRequests = state.userRequests.get(userId) || [];

    if (state.active >= maxConcurrentPerGuild) {
      throw new RequestGateError('concurrency');
    }

    if (state.guildRequests.length >= maxRequestsPerGuildPerMinute) {
      throw new RequestGateError('guild-rate-limit');
    }

    if (userRequests.length >= maxRequestsPerUserPerMinute) {
      throw new RequestGateError('user-rate-limit');
    }

    state.active += 1;
    state.guildRequests.push(timestamp);
    userRequests.push(timestamp);
    state.userRequests.set(userId, userRequests);
    scheduleCleanup(timestamp + minuteMs + 1);
    let released = false;

    return function release() {
      if (released) {
        return;
      }

      released = true;
      state.active = Math.max(0, state.active - 1);

      if (state.active === 0 && state.guildRequests.length === 0 && state.userRequests.size === 0) {
        guildStates.delete(guildId);
      }
    };
  }

  function getSnapshot(guildIdValue, timestamp = Number(now())) {
    const guildId = String(guildIdValue || '').trim();
    const state = guildStates.get(guildId);

    if (!state) {
      return Object.freeze({ active: 0, guildRequests: 0 });
    }

    pruneState(state, timestamp - minuteMs);

    if (state.active === 0 && state.guildRequests.length === 0 && state.userRequests.size === 0) {
      guildStates.delete(guildId);
      scheduleCleanup();
      return Object.freeze({ active: 0, guildRequests: 0 });
    }

    return Object.freeze({
      active: state.active,
      guildRequests: state.guildRequests.length,
    });
  }

  return Object.freeze({
    acquire,
    getSnapshot,
    limits: Object.freeze({
      maxConcurrentPerGuild,
      maxRequestsPerGuildPerMinute,
      maxRequestsPerUserPerMinute,
    }),
  });
}

module.exports = {
  RequestGateError,
  createRequestGate,
  getRequestGateFailureMessage,
  parseLimit,
};
