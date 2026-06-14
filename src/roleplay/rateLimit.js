const { roleplayRateLimitWindows, roleplayTicketCreationCooldownMs, roleplayTicketMessageMax } = require('./config');
const roleplayRateLimitTimestamps = new Map();
const roleplayTicketMessageCounts = new Map();
const roleplayTicketCreationTimestamps = new Map();
const roleplayTicketReopenCooldownTimestamps = new Map();
const roleplayTicketReopenCooldownEnabledByGuildId = new Map();
const roleplayMaxWindowMs = Math.max(...roleplayRateLimitWindows.map((window) => window.windowMs));
const roleplayTicketReopenCooldownMs = 3 * 60 * 60 * 1000;
function pruneRoleplayTimestamps(timestamps, now = Date.now()) { return timestamps.filter((timestamp) => now - timestamp < roleplayMaxWindowMs); }
function isRoleplayRateLimited(rateLimitKey, now = Date.now()) {
  const timestamps = pruneRoleplayTimestamps(roleplayRateLimitTimestamps.get(rateLimitKey) ?? [], now);
  roleplayRateLimitTimestamps.set(rateLimitKey, timestamps);
  return roleplayRateLimitWindows.some((window) => timestamps.filter((timestamp) => now - timestamp < window.windowMs).length >= window.max);
}
function isRoleplayTicketMessageLimitReached(ticketId) { return (roleplayTicketMessageCounts.get(ticketId) ?? 0) >= roleplayTicketMessageMax; }
function isRoleplayTicketCreationRateLimited(creationKey, now = Date.now()) { return roleplayTicketCreationTimestamps.has(creationKey) && now - (roleplayTicketCreationTimestamps.get(creationKey) ?? 0) < roleplayTicketCreationCooldownMs; }
function recordRoleplayTicketCreation(creationKey, now = Date.now()) { roleplayTicketCreationTimestamps.set(creationKey, now); return now; }
function isRoleplayTicketReopenCooldownEnabled(guildId) { return roleplayTicketReopenCooldownEnabledByGuildId.get(guildId) ?? true; }
function setRoleplayTicketReopenCooldownEnabled(guildId, enabled) { roleplayTicketReopenCooldownEnabledByGuildId.set(guildId, Boolean(enabled)); return Boolean(enabled); }
function recordRoleplayTicketReopenCooldown(creationKey, now = Date.now()) { roleplayTicketReopenCooldownTimestamps.set(creationKey, now); return now; }
function isRoleplayTicketReopenCooldownActive(creationKey, now = Date.now()) { return roleplayTicketReopenCooldownTimestamps.has(creationKey) && now - (roleplayTicketReopenCooldownTimestamps.get(creationKey) ?? 0) < roleplayTicketReopenCooldownMs; }
function getRoleplayCreationRateLimitMessage() { return 'Roleplay ticket creation is on cooldown. Try again in a bit.'; }
function getRoleplayTicketReopenCooldownMessage() { return 'Roleplay ticket reopen cooldown is active. Try again after 3 hours.'; }
function recordRoleplayAiMessage(rateLimitKey, ticketId, now = Date.now()) {
  const timestamps = pruneRoleplayTimestamps(roleplayRateLimitTimestamps.get(rateLimitKey) ?? [], now);
  timestamps.push(now);
  roleplayRateLimitTimestamps.set(rateLimitKey, timestamps);
  roleplayTicketMessageCounts.set(ticketId, (roleplayTicketMessageCounts.get(ticketId) ?? 0) + 1);
  return { windowCounts: roleplayRateLimitWindows.map((window) => timestamps.filter((timestamp) => now - timestamp < window.windowMs).length), ticketCount: roleplayTicketMessageCounts.get(ticketId) };
}
function getRoleplayRateLimitMessage() { return 'Roleplay cooldown is active for this ticket. Try again in a bit.'; }
function resetRoleplayRateLimits() { roleplayRateLimitTimestamps.clear(); roleplayTicketMessageCounts.clear(); roleplayTicketCreationTimestamps.clear(); roleplayTicketReopenCooldownTimestamps.clear(); roleplayTicketReopenCooldownEnabledByGuildId.clear(); }
module.exports = { getRoleplayCreationRateLimitMessage, getRoleplayRateLimitMessage, getRoleplayTicketReopenCooldownMessage, isRoleplayRateLimited, isRoleplayTicketCreationRateLimited, isRoleplayTicketMessageLimitReached, isRoleplayTicketReopenCooldownActive, isRoleplayTicketReopenCooldownEnabled, recordRoleplayAiMessage, recordRoleplayTicketCreation, recordRoleplayTicketReopenCooldown, resetRoleplayRateLimits, setRoleplayTicketReopenCooldownEnabled };
