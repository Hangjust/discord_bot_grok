const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const LIMITS = Object.freeze({
  userPerMinute: 8,
  userPerHour: 40,
  guildPerMinute: 120,
  guildPerDay: 1000,
  globalPerMinute: 500,
  guildConcurrent: 3,
  globalConcurrent: 50,
});

const WEB_SEARCH_LIMITS = Object.freeze({
  guildPerDay: 100,
  globalPerDay: 2000,
  globalConcurrent: 10,
});
const UTILITY_LIMITS = Object.freeze({
  userPerMinute: 30,
  guildPerMinute: 300,
  globalPerMinute: 1000,
});

const userTimestamps = new Map();
const guildTimestamps = new Map();
const globalTimestamps = [];
const lastAcceptedAt = new Map();
const inFlightUsers = new Map();
const guildInFlightCounts = new Map();
let globalInFlightCount = 0;
const webSearchGuildTimestamps = new Map();
const webSearchGlobalTimestamps = [];
const webSearchInFlight = new Map();
let lastGlobalPruneAt = Number.NEGATIVE_INFINITY;
const utilityUserBuckets = new Map();
const utilityGuildBuckets = new Map();
let utilityGlobalBucket = null;

function refillUtilityBucket(bucket, capacity, now) {
  if (now < bucket.updatedAt) bucket.updatedAt = now;
  const refillPerMs = capacity / MINUTE_MS;
  bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.updatedAt) * refillPerMs));
  bucket.updatedAt = now;
  return bucket;
}

function getUtilityBucket(map, key, capacity, now) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, updatedAt: now };
    map.set(key, bucket);
  }
  return refillUtilityBucket(bucket, capacity, now);
}

function pruneIdleRateLimitEntries(now = Date.now()) {
  for (const [key, timestamps] of userTimestamps.entries()) {
    pruneTimestamps(timestamps, now, HOUR_MS);
    if (timestamps.length === 0 && !inFlightUsers.has(key)) {
      userTimestamps.delete(key);
      lastAcceptedAt.delete(key);
    }
  }
  for (const [key, timestamps] of guildTimestamps.entries()) {
    pruneTimestamps(timestamps, now, DAY_MS);
    if (timestamps.length === 0 && !guildInFlightCounts.has(key)) guildTimestamps.delete(key);
  }
  for (const [key, timestamps] of webSearchGuildTimestamps.entries()) {
    pruneTimestamps(timestamps, now, DAY_MS);
    if (timestamps.length === 0) webSearchGuildTimestamps.delete(key);
  }
  pruneTimestamps(webSearchGlobalTimestamps, now, DAY_MS);
  for (const [key, bucket] of utilityUserBuckets) {
    const idleMs = now - bucket.updatedAt;
    refillUtilityBucket(bucket, UTILITY_LIMITS.userPerMinute, now);
    if (bucket.tokens >= UTILITY_LIMITS.userPerMinute && idleMs >= MINUTE_MS) {
      utilityUserBuckets.delete(key);
    }
  }
  for (const [key, bucket] of utilityGuildBuckets) {
    const idleMs = now - bucket.updatedAt;
    refillUtilityBucket(bucket, UTILITY_LIMITS.guildPerMinute, now);
    if (bucket.tokens >= UTILITY_LIMITS.guildPerMinute && idleMs >= MINUTE_MS) {
      utilityGuildBuckets.delete(key);
    }
  }
  lastGlobalPruneAt = now;
}

function maybePruneIdleRateLimitEntries(now) {
  if (now < lastGlobalPruneAt || now - lastGlobalPruneAt >= 5 * MINUTE_MS) {
    pruneIdleRateLimitEntries(now);
  }
}

function pruneTimestamps(timestamps, now, windowMs) {
  let firstCurrentIndex = 0;
  while (firstCurrentIndex < timestamps.length && now - timestamps[firstCurrentIndex] >= windowMs) {
    firstCurrentIndex += 1;
  }

  if (firstCurrentIndex > 0) timestamps.splice(0, firstCurrentIndex);
  return timestamps;
}

function getRetryAfterMs(timestamps, now, windowMs) {
  if (timestamps.length === 0) return 0;
  return Math.max(1, windowMs - (now - timestamps[0]));
}

function consumeUtilityLimit({ guildId, userId, now = Date.now() } = {}) {
  if (guildId == null || userId == null) return false;
  const timestamp = Number(now);
  if (!Number.isFinite(timestamp)) return false;
  maybePruneIdleRateLimitEntries(timestamp);
  const guildKey = String(guildId);
  const userKey = `${guildKey}:${String(userId)}`;
  utilityGlobalBucket ??= { tokens: UTILITY_LIMITS.globalPerMinute, updatedAt: timestamp };
  refillUtilityBucket(utilityGlobalBucket, UTILITY_LIMITS.globalPerMinute, timestamp);
  if (utilityGlobalBucket.tokens < 1) return false;
  const userBucket = getUtilityBucket(
    utilityUserBuckets,
    userKey,
    UTILITY_LIMITS.userPerMinute,
    timestamp,
  );
  const guildBucket = getUtilityBucket(
    utilityGuildBuckets,
    guildKey,
    UTILITY_LIMITS.guildPerMinute,
    timestamp,
  );
  if (userBucket.tokens < 1 || guildBucket.tokens < 1 || utilityGlobalBucket.tokens < 1) {
    return false;
  }
  userBucket.tokens -= 1;
  guildBucket.tokens -= 1;
  utilityGlobalBucket.tokens -= 1;
  return true;
}

function getWindowStartIndex(timestamps, cutoff) {
  let low = 0;
  let high = timestamps.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (timestamps[middle] <= cutoff) low = middle + 1;
    else high = middle;
  }
  return low;
}

function getRetryAfterAt(timestamps, index, now, windowMs) {
  if (index >= timestamps.length) return 0;
  return Math.max(1, windowMs - (now - timestamps[index]));
}

function denied(reason, retryAfterMs = 0) {
  return { allowed: false, reason, retryAfterMs };
}

function consumeChatLimit({ guildId, userId, cooldownSeconds = 0, now = Date.now() } = {}) {
  if (guildId == null || userId == null) return denied('invalid_scope');

  const timestamp = Number(now);
  if (!Number.isFinite(timestamp)) return denied('invalid_time');
  maybePruneIdleRateLimitEntries(timestamp);

  const guildKey = String(guildId);
  const userIdString = String(userId);
  const userKey = `${guildKey}:${userIdString}`;
  if (inFlightUsers.has(userKey)) return denied('in_flight');
  if ((guildInFlightCounts.get(guildKey) ?? 0) >= LIMITS.guildConcurrent) {
    return denied('guild_concurrent');
  }
  if (globalInFlightCount >= LIMITS.globalConcurrent) {
    return denied('global_concurrent');
  }

  const cooldownMs = Math.max(0, Number(cooldownSeconds) || 0) * 1000;
  const previousAcceptedAt = lastAcceptedAt.get(userKey);
  if (cooldownMs > 0 && previousAcceptedAt != null && timestamp - previousAcceptedAt < cooldownMs) {
    return denied('cooldown', Math.max(1, cooldownMs - (timestamp - previousAcceptedAt)));
  }

  const userHistory = userTimestamps.get(userKey) ?? [];
  const guildHistory = guildTimestamps.get(guildKey) ?? [];

  pruneTimestamps(userHistory, timestamp, HOUR_MS);
  pruneTimestamps(guildHistory, timestamp, DAY_MS);
  pruneTimestamps(globalTimestamps, timestamp, MINUTE_MS);

  const userMinuteStart = getWindowStartIndex(userHistory, timestamp - MINUTE_MS);
  if (userHistory.length - userMinuteStart >= LIMITS.userPerMinute) {
    return denied('user_minute', getRetryAfterAt(userHistory, userMinuteStart, timestamp, MINUTE_MS));
  }

  if (userHistory.length >= LIMITS.userPerHour) {
    return denied('user_hour', getRetryAfterMs(userHistory, timestamp, HOUR_MS));
  }

  const guildMinuteStart = getWindowStartIndex(guildHistory, timestamp - MINUTE_MS);
  if (guildHistory.length - guildMinuteStart >= LIMITS.guildPerMinute) {
    return denied('guild_minute', getRetryAfterAt(guildHistory, guildMinuteStart, timestamp, MINUTE_MS));
  }

  if (guildHistory.length >= LIMITS.guildPerDay) {
    return denied('guild_day', getRetryAfterMs(guildHistory, timestamp, DAY_MS));
  }

  if (globalTimestamps.length >= LIMITS.globalPerMinute) {
    return denied('global_minute', getRetryAfterMs(globalTimestamps, timestamp, MINUTE_MS));
  }

  // All counters and the in-flight lock are committed synchronously, before the
  // caller can reach its first await.
  const token = Symbol('chat-limit');
  userHistory.push(timestamp);
  guildHistory.push(timestamp);
  globalTimestamps.push(timestamp);
  userTimestamps.set(userKey, userHistory);
  guildTimestamps.set(guildKey, guildHistory);
  lastAcceptedAt.set(userKey, timestamp);
  inFlightUsers.set(userKey, token);
  guildInFlightCounts.set(guildKey, (guildInFlightCounts.get(guildKey) ?? 0) + 1);
  globalInFlightCount += 1;

  return {
    allowed: true,
    reason: null,
    retryAfterMs: 0,
    guildId: guildKey,
    userId: userIdString,
    userKey,
    token,
  };
}

function releaseChatLimit(reservationOrUserId, tokenArg) {
  const userKey = typeof reservationOrUserId === 'object'
    ? reservationOrUserId?.userKey
      ?? (reservationOrUserId?.guildId != null && reservationOrUserId?.userId != null
        ? `${reservationOrUserId.guildId}:${reservationOrUserId.userId}`
        : null)
    : reservationOrUserId;
  const token = typeof reservationOrUserId === 'object'
    ? reservationOrUserId?.token
    : tokenArg;

  if (userKey == null) return false;
  const normalizedUserKey = String(userKey);
  const activeToken = inFlightUsers.get(normalizedUserKey);
  if (!activeToken || (token != null && token !== activeToken)) return false;

  inFlightUsers.delete(normalizedUserKey);
  const guildKey = typeof reservationOrUserId === 'object'
    ? String(reservationOrUserId?.guildId ?? '')
    : normalizedUserKey.slice(0, normalizedUserKey.indexOf(':'));
  const guildCount = guildInFlightCounts.get(guildKey) ?? 0;
  if (guildCount <= 1) guildInFlightCounts.delete(guildKey);
  else guildInFlightCounts.set(guildKey, guildCount - 1);
  globalInFlightCount = Math.max(0, globalInFlightCount - 1);
  return true;
}

function getChatRateLimitMessage(result) {
  if (result?.reason === 'in_flight') return 'I am already answering your previous message.';
  if (result?.reason === 'cooldown') return 'Please wait a moment before asking again.';
  return 'Too many requests right now. Please try again shortly.';
}

function consumeWebSearchLimit({ guildId, now = Date.now() } = {}) {
  if (guildId == null) return denied('invalid_scope');
  const timestamp = Number(now);
  if (!Number.isFinite(timestamp)) return denied('invalid_time');
  maybePruneIdleRateLimitEntries(timestamp);

  const guildKey = String(guildId);
  const guildHistory = webSearchGuildTimestamps.get(guildKey) ?? [];
  pruneTimestamps(guildHistory, timestamp, DAY_MS);
  pruneTimestamps(webSearchGlobalTimestamps, timestamp, DAY_MS);

  if (guildHistory.length >= WEB_SEARCH_LIMITS.guildPerDay) {
    return denied('search_guild_day', getRetryAfterMs(guildHistory, timestamp, DAY_MS));
  }
  if (webSearchGlobalTimestamps.length >= WEB_SEARCH_LIMITS.globalPerDay) {
    return denied('search_global_day', getRetryAfterMs(webSearchGlobalTimestamps, timestamp, DAY_MS));
  }
  if (webSearchInFlight.size >= WEB_SEARCH_LIMITS.globalConcurrent) {
    return denied('search_global_concurrent');
  }

  const token = Symbol('web-search-limit');
  guildHistory.push(timestamp);
  webSearchGlobalTimestamps.push(timestamp);
  webSearchGuildTimestamps.set(guildKey, guildHistory);
  webSearchInFlight.set(token, guildKey);
  return { allowed: true, reason: null, retryAfterMs: 0, guildId: guildKey, token };
}

function releaseWebSearchLimit(reservation) {
  const token = reservation?.token;
  if (!token || !webSearchInFlight.has(token)) return false;
  webSearchInFlight.delete(token);
  return true;
}

function resetGuildChatRateLimits(guildId) {
  // Keep 24-hour guild/search tombstones and active reservations so kicking and
  // re-adding the bot cannot reset spend caps. Normal TTL pruning removes them.
  pruneIdleRateLimitEntries(Date.now());
  const normalizedGuildId = String(guildId);
  utilityGuildBuckets.delete(normalizedGuildId);
  const prefix = `${normalizedGuildId}:`;
  for (const key of utilityUserBuckets.keys()) {
    if (key.startsWith(prefix)) utilityUserBuckets.delete(key);
  }
}

function resetChatRateLimits() {
  userTimestamps.clear();
  guildTimestamps.clear();
  globalTimestamps.splice(0, globalTimestamps.length);
  lastAcceptedAt.clear();
  inFlightUsers.clear();
  guildInFlightCounts.clear();
  globalInFlightCount = 0;
  webSearchGuildTimestamps.clear();
  webSearchGlobalTimestamps.splice(0, webSearchGlobalTimestamps.length);
  webSearchInFlight.clear();
  lastGlobalPruneAt = Number.NEGATIVE_INFINITY;
  utilityUserBuckets.clear();
  utilityGuildBuckets.clear();
  utilityGlobalBucket = null;
}

module.exports = {
  LIMITS,
  WEB_SEARCH_LIMITS,
  UTILITY_LIMITS,
  consumeChatLimit,
  consumeWebSearchLimit,
  consumeUtilityLimit,
  getChatRateLimitMessage,
  pruneIdleRateLimitEntries,
  releaseChatLimit,
  releaseWebSearchLimit,
  resetChatRateLimits,
  resetGuildChatRateLimits,
};
