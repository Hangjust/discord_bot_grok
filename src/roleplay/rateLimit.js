const {
  roleplayRateLimitWindows,
  roleplayTicketCreationCooldownMs,
  roleplayTicketMessageMax,
} = require('./config');

const roleplayRateLimitTimestamps = new Map();
const roleplayTicketMessageCounts = new Map();
const roleplayTicketCreationTimestamps = new Map();
const roleplayTicketReopenCooldownTimestamps = new Map();
const roleplayTicketReopenCooldownEnabledByGuildId = new Map();
const roleplayMaxWindowMs = Math.max(...roleplayRateLimitWindows.map((window) => window.windowMs));
const roleplayTicketReopenCooldownMs = 3 * 60 * 60 * 1000;
const roleplayTicketMessageCountTtlMs = 30 * 24 * 60 * 60 * 1000;
const roleplayRateLimitCleanupIntervalMs = 10 * 60 * 1000;
const maxRoleplayRateLimitEntries = 8192;
const maxRoleplayGuildSettings = 4096;

function setBoundedMapEntry(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);

  while (map.size > limit) {
    map.delete(map.keys().next().value);
  }
}

function pruneRoleplayTimestamps(timestamps, now = Date.now()) {
  let firstActive = 0;
  while (firstActive < timestamps.length && now - timestamps[firstActive] >= roleplayMaxWindowMs) {
    firstActive += 1;
  }
  if (firstActive > 0) timestamps.splice(0, firstActive);
  return timestamps;
}

function countRoleplayTimestampsInWindow(timestamps, now, windowMs) {
  const cutoff = now - windowMs;
  let low = 0;
  let high = timestamps.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (timestamps[middle] <= cutoff) low = middle + 1;
    else high = middle;
  }
  return timestamps.length - low;
}

function pruneRoleplayRateLimitState(now = Date.now()) {
  for (const [rateLimitKey, timestamps] of roleplayRateLimitTimestamps) {
    const activeTimestamps = pruneRoleplayTimestamps(timestamps, now);

    if (activeTimestamps.length === 0) {
      roleplayRateLimitTimestamps.delete(rateLimitKey);
    } else if (activeTimestamps.length !== timestamps.length) {
      roleplayRateLimitTimestamps.set(rateLimitKey, activeTimestamps);
    }
  }

  for (const [ticketId, entry] of roleplayTicketMessageCounts) {
    if (now - entry.updatedAt >= roleplayTicketMessageCountTtlMs) {
      roleplayTicketMessageCounts.delete(ticketId);
    }
  }

  for (const [creationKey, createdAt] of roleplayTicketCreationTimestamps) {
    if (now - createdAt >= roleplayTicketCreationCooldownMs) {
      roleplayTicketCreationTimestamps.delete(creationKey);
    }
  }

  for (const [creationKey, reopenedAt] of roleplayTicketReopenCooldownTimestamps) {
    if (now - reopenedAt >= roleplayTicketReopenCooldownMs) {
      roleplayTicketReopenCooldownTimestamps.delete(creationKey);
    }
  }
}

const roleplayRateLimitCleanupTimer = setInterval(
  pruneRoleplayRateLimitState,
  roleplayRateLimitCleanupIntervalMs,
);
roleplayRateLimitCleanupTimer.unref?.();

function isRoleplayRateLimited(rateLimitKey, now = Date.now()) {
  const timestamps = pruneRoleplayTimestamps(roleplayRateLimitTimestamps.get(rateLimitKey) ?? [], now);

  if (timestamps.length === 0) {
    roleplayRateLimitTimestamps.delete(rateLimitKey);
  } else {
    setBoundedMapEntry(
      roleplayRateLimitTimestamps,
      rateLimitKey,
      timestamps,
      maxRoleplayRateLimitEntries,
    );
  }

  return roleplayRateLimitWindows.some(
    (window) => countRoleplayTimestampsInWindow(timestamps, now, window.windowMs) >= window.max,
  );
}

function isRoleplayTicketMessageLimitReached(ticketId) {
  return (roleplayTicketMessageCounts.get(ticketId)?.count ?? 0) >= roleplayTicketMessageMax;
}

function isRoleplayTicketCreationRateLimited(creationKey, now = Date.now()) {
  const createdAt = roleplayTicketCreationTimestamps.get(creationKey);

  if (createdAt === undefined) return false;
  if (now - createdAt < roleplayTicketCreationCooldownMs) return true;

  roleplayTicketCreationTimestamps.delete(creationKey);
  return false;
}

function recordRoleplayTicketCreation(creationKey, now = Date.now()) {
  setBoundedMapEntry(
    roleplayTicketCreationTimestamps,
    creationKey,
    now,
    maxRoleplayRateLimitEntries,
  );
  return now;
}

function isRoleplayTicketReopenCooldownEnabled(guildId) {
  return roleplayTicketReopenCooldownEnabledByGuildId.get(guildId) ?? true;
}

function setRoleplayTicketReopenCooldownEnabled(guildId, enabled) {
  const normalizedEnabled = Boolean(enabled);
  setBoundedMapEntry(
    roleplayTicketReopenCooldownEnabledByGuildId,
    guildId,
    normalizedEnabled,
    maxRoleplayGuildSettings,
  );
  return normalizedEnabled;
}

function recordRoleplayTicketReopenCooldown(creationKey, now = Date.now()) {
  setBoundedMapEntry(
    roleplayTicketReopenCooldownTimestamps,
    creationKey,
    now,
    maxRoleplayRateLimitEntries,
  );
  return now;
}

function isRoleplayTicketReopenCooldownActive(creationKey, now = Date.now()) {
  const reopenedAt = roleplayTicketReopenCooldownTimestamps.get(creationKey);

  if (reopenedAt === undefined) return false;
  if (now - reopenedAt < roleplayTicketReopenCooldownMs) return true;

  roleplayTicketReopenCooldownTimestamps.delete(creationKey);
  return false;
}

function getRoleplayCreationRateLimitMessage() {
  return 'Roleplay ticket creation is on cooldown. Try again in a bit.';
}

function getRoleplayTicketReopenCooldownMessage() {
  return 'Roleplay ticket reopen cooldown is active. Try again after 3 hours.';
}

function recordRoleplayAiMessage(rateLimitKey, ticketId, now = Date.now()) {
  const timestamps = pruneRoleplayTimestamps(roleplayRateLimitTimestamps.get(rateLimitKey) ?? [], now);
  timestamps.push(now);
  setBoundedMapEntry(
    roleplayRateLimitTimestamps,
    rateLimitKey,
    timestamps,
    maxRoleplayRateLimitEntries,
  );

  const ticketCount = (roleplayTicketMessageCounts.get(ticketId)?.count ?? 0) + 1;
  setBoundedMapEntry(
    roleplayTicketMessageCounts,
    ticketId,
    { count: ticketCount, updatedAt: now },
    maxRoleplayRateLimitEntries,
  );

  return {
    windowCounts: roleplayRateLimitWindows.map(
      (window) => countRoleplayTimestampsInWindow(timestamps, now, window.windowMs),
    ),
    ticketCount,
  };
}

function getRoleplayRateLimitMessage() {
  return 'Roleplay cooldown is active for this ticket. Try again in a bit.';
}

function resetRoleplayRateLimits() {
  roleplayRateLimitTimestamps.clear();
  roleplayTicketMessageCounts.clear();
  roleplayTicketCreationTimestamps.clear();
  roleplayTicketReopenCooldownTimestamps.clear();
  roleplayTicketReopenCooldownEnabledByGuildId.clear();
}

function resetGuildRoleplayRateLimits(guildId, ticketIds = []) {
  const normalizedGuildId = String(guildId);
  const prefix = `${normalizedGuildId}:`;
  for (const map of [
    roleplayRateLimitTimestamps,
    roleplayTicketCreationTimestamps,
    roleplayTicketReopenCooldownTimestamps,
  ]) {
    for (const key of map.keys()) {
      if (String(key).startsWith(prefix)) map.delete(key);
    }
  }
  for (const ticketId of ticketIds) roleplayTicketMessageCounts.delete(ticketId);
  roleplayTicketReopenCooldownEnabledByGuildId.delete(guildId);
  roleplayTicketReopenCooldownEnabledByGuildId.delete(normalizedGuildId);
}

function resetRoleplayTicketRateLimit(ticketId) {
  return roleplayTicketMessageCounts.delete(ticketId);
}

module.exports = {
  getRoleplayCreationRateLimitMessage,
  getRoleplayRateLimitMessage,
  getRoleplayTicketReopenCooldownMessage,
  isRoleplayRateLimited,
  isRoleplayTicketCreationRateLimited,
  isRoleplayTicketMessageLimitReached,
  isRoleplayTicketReopenCooldownActive,
  isRoleplayTicketReopenCooldownEnabled,
  recordRoleplayAiMessage,
  recordRoleplayTicketCreation,
  recordRoleplayTicketReopenCooldown,
  resetRoleplayRateLimits,
  resetGuildRoleplayRateLimits,
  resetRoleplayTicketRateLimit,
  setRoleplayTicketReopenCooldownEnabled,
};
