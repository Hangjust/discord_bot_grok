const { setupDraftTtlMs } = require('./constants');

const setupDrafts = new Map();
const maxSetupDrafts = 1000;
const draftPruneIntervalMs = Math.min(setupDraftTtlMs, 5 * 60 * 1000);
let lastDraftPruneAt = Number.NEGATIVE_INFINITY;

function getDraftKey(type, guildId, userId) {
  return `${type}:${guildId}:${userId}`;
}

function pruneExpiredDrafts(now = Date.now()) {
  for (const [key, draft] of setupDrafts.entries()) {
    if (now - draft.updatedAt >= setupDraftTtlMs) {
      setupDrafts.delete(key);
    }
  }
  lastDraftPruneAt = now;
}

function maybePruneExpiredDrafts(now) {
  if (now < lastDraftPruneAt || now - lastDraftPruneAt >= draftPruneIntervalMs) {
    pruneExpiredDrafts(now);
  }
}

function evictOldestDraft() {
  let oldestKey = null;
  let oldestUpdatedAt = Number.POSITIVE_INFINITY;
  for (const [key, draft] of setupDrafts) {
    if (draft.updatedAt < oldestUpdatedAt) {
      oldestKey = key;
      oldestUpdatedAt = draft.updatedAt;
    }
  }
  if (oldestKey != null) setupDrafts.delete(oldestKey);
}

function createSetupDraft(type, guildId, userId, values, now = Date.now()) {
  maybePruneExpiredDrafts(now);
  const key = getDraftKey(type, guildId, userId);
  if (!setupDrafts.has(key) && setupDrafts.size >= maxSetupDrafts) evictOldestDraft();
  const draft = {
    type,
    guildId,
    userId,
    values: structuredClone(values),
    createdAt: now,
    updatedAt: now,
  };
  setupDrafts.set(key, draft);
  return structuredClone(draft);
}

function getSetupDraft(type, guildId, userId, now = Date.now()) {
  maybePruneExpiredDrafts(now);
  const key = getDraftKey(type, guildId, userId);
  const draft = setupDrafts.get(key);
  if (draft && now - draft.updatedAt >= setupDraftTtlMs) {
    setupDrafts.delete(key);
    return null;
  }
  return draft ? structuredClone(draft) : null;
}

function updateSetupDraft(type, guildId, userId, patch, now = Date.now()) {
  const key = getDraftKey(type, guildId, userId);
  const existing = getSetupDraft(type, guildId, userId, now);

  if (!existing) {
    return null;
  }

  existing.values = {
    ...existing.values,
    ...structuredClone(patch),
  };
  existing.updatedAt = now;
  setupDrafts.set(key, existing);
  return structuredClone(existing);
}

function deleteSetupDraft(type, guildId, userId) {
  return setupDrafts.delete(getDraftKey(type, guildId, userId));
}

function resetSetupDrafts() {
  setupDrafts.clear();
  lastDraftPruneAt = Number.NEGATIVE_INFINITY;
}

const draftCleanupTimer = setInterval(() => pruneExpiredDrafts(Date.now()), draftPruneIntervalMs);
draftCleanupTimer.unref?.();

function deleteGuildSetupDrafts(guildId) {
  const marker = `:${String(guildId)}:`;
  let removedCount = 0;
  for (const key of setupDrafts.keys()) {
    if (key.includes(marker) && setupDrafts.delete(key)) {
      removedCount += 1;
    }
  }
  return removedCount;
}

module.exports = {
  createSetupDraft,
  deleteGuildSetupDrafts,
  deleteSetupDraft,
  getDraftKey,
  getSetupDraft,
  maxSetupDrafts,
  pruneExpiredDrafts,
  resetSetupDrafts,
  updateSetupDraft,
};
