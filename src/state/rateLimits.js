const {
  triggerSpamWindowMs,
  webSearchRateLimitMax,
  webSearchRateLimitWindowMs,
} = require('../config/constants');

const userTriggerTimestamps = new Map();
const userWebSearchTimestamps = new Map();

function pruneTriggerTimestamps(timestamps, now = Date.now()) {
  return timestamps.filter((timestamp) => now - timestamp < triggerSpamWindowMs);
}

function recordUserTrigger(userId, now = Date.now()) {
  const timestamps = pruneTriggerTimestamps(userTriggerTimestamps.get(userId) ?? [], now);
  timestamps.push(now);
  userTriggerTimestamps.set(userId, timestamps);
  return timestamps.length;
}

function getUserSpamLevel(userId, now = Date.now()) {
  const timestamps = pruneTriggerTimestamps(userTriggerTimestamps.get(userId) ?? [], now);
  userTriggerTimestamps.set(userId, timestamps);

  if (timestamps.length >= 5) {
    return 'feral';
  }

  if (timestamps.length >= 3) {
    return 'annoyed';
  }

  return 'normal';
}

function pruneWebSearchTimestamps(timestamps, now = Date.now()) {
  return timestamps.filter((timestamp) => now - timestamp < webSearchRateLimitWindowMs);
}

function recordUserWebSearch(userId, now = Date.now()) {
  const timestamps = pruneWebSearchTimestamps(userWebSearchTimestamps.get(userId) ?? [], now);
  timestamps.push(now);
  userWebSearchTimestamps.set(userId, timestamps);
  return timestamps.length;
}

function isUserWebSearchRateLimited(userId, now = Date.now()) {
  const timestamps = pruneWebSearchTimestamps(userWebSearchTimestamps.get(userId) ?? [], now);
  userWebSearchTimestamps.set(userId, timestamps);
  return timestamps.length >= webSearchRateLimitMax;
}

function getWebSearchRateLimitMessage() {
  return 'Slow down. Internet search cooldown is active.';
}

module.exports = {
  getUserSpamLevel,
  getWebSearchRateLimitMessage,
  isUserWebSearchRateLimited,
  recordUserTrigger,
  recordUserWebSearch,
};
