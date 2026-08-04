const { roleplaySessionHistoryLimit } = require('./config');

const roleplaySessions = new Map();
const roleplaySessionCountsByGuild = new Map();
const maxRoleplaySessions = 500;
const maxRoleplaySessionsPerGuild = 100;
const maxRoleplayMessageCharacters = 8192;
const roleplaySessionTtlMs = 24 * 60 * 60 * 1000;
const roleplaySessionCleanupIntervalMs = 15 * 60 * 1000;

function getRoleplaySessionGuildId(sessionKey) {
  return String(sessionKey).split(':', 1)[0];
}

function deleteRoleplaySession(sessionKey) {
  if (!roleplaySessions.delete(sessionKey)) return false;
  const guildId = getRoleplaySessionGuildId(sessionKey);
  const count = roleplaySessionCountsByGuild.get(guildId) ?? 0;
  if (count <= 1) roleplaySessionCountsByGuild.delete(guildId);
  else roleplaySessionCountsByGuild.set(guildId, count - 1);
  return true;
}

function pruneExpiredRoleplaySessions(now = Date.now()) {
  for (const [sessionKey, session] of roleplaySessions) {
    if (now - session.lastActivityAt >= roleplaySessionTtlMs) {
      deleteRoleplaySession(sessionKey);
    }
  }
}

function evictOldestRoleplaySession(guildId = null) {
  let oldestKey = null;
  let oldestActivityAt = Infinity;

  for (const [sessionKey, session] of roleplaySessions) {
    if (guildId != null && getRoleplaySessionGuildId(sessionKey) !== String(guildId)) continue;
    if (oldestKey === null || session.lastActivityAt < oldestActivityAt) {
      oldestKey = sessionKey;
      oldestActivityAt = session.lastActivityAt;
    }
  }

  if (oldestKey !== null) return deleteRoleplaySession(oldestKey);
  return false;
}

const roleplaySessionCleanupTimer = setInterval(
  pruneExpiredRoleplaySessions,
  roleplaySessionCleanupIntervalMs,
);
roleplaySessionCleanupTimer.unref?.();

function getRoleplaySessionKey({ guildId, channelId, userId, ticketId }) {
  return [guildId, channelId, userId, ticketId].map((part) => String(part ?? '')).join(':');
}

function createRoleplaySession(now = Date.now()) {
  return { messages: [], createdAt: now, lastActivityAt: now };
}

function normalizeRoleplayMessageContent(value) {
  const content = String(value ?? '');
  if (content.length <= maxRoleplayMessageCharacters) return content;
  return `${content.slice(0, maxRoleplayMessageCharacters - 1)}…`;
}

function getRoleplaySession(sessionKey, now = Date.now()) {
  const existingSession = roleplaySessions.get(sessionKey);

  if (existingSession && now - existingSession.lastActivityAt < roleplaySessionTtlMs) {
    return existingSession;
  }

  if (existingSession) deleteRoleplaySession(sessionKey);

  const guildId = getRoleplaySessionGuildId(sessionKey);
  while ((roleplaySessionCountsByGuild.get(guildId) ?? 0) >= maxRoleplaySessionsPerGuild) {
    if (!evictOldestRoleplaySession(guildId)) break;
  }

  while (roleplaySessions.size >= maxRoleplaySessions) {
    if (!evictOldestRoleplaySession()) break;
  }

  roleplaySessions.set(sessionKey, createRoleplaySession(now));
  roleplaySessionCountsByGuild.set(
    guildId,
    (roleplaySessionCountsByGuild.get(guildId) ?? 0) + 1,
  );
  return roleplaySessions.get(sessionKey);
}

function appendRoleplayTurn(session, userContent, assistantContent, now = Date.now()) {
  session.messages.push({ role: 'user', content: normalizeRoleplayMessageContent(userContent) }, { role: 'assistant', content: normalizeRoleplayMessageContent(assistantContent) });
  if (session.messages.length > roleplaySessionHistoryLimit) session.messages.splice(0, session.messages.length - roleplaySessionHistoryLimit);
  session.lastActivityAt = now;
}

function appendRoleplayAssistantMessage(session, assistantContent, now = Date.now()) {
  session.messages.push({ role: 'assistant', content: normalizeRoleplayMessageContent(assistantContent) });
  if (session.messages.length > roleplaySessionHistoryLimit) session.messages.splice(0, session.messages.length - roleplaySessionHistoryLimit);
  session.lastActivityAt = now;
}

function resetRoleplaySession(sessionKey) {
  deleteRoleplaySession(sessionKey);
}

function resetRoleplaySessions() {
  roleplaySessions.clear();
  roleplaySessionCountsByGuild.clear();
}

function resetGuildRoleplaySessions(guildId) {
  const prefix = `${String(guildId)}:`;
  let deletedCount = 0;
  for (const sessionKey of roleplaySessions.keys()) {
    if (sessionKey.startsWith(prefix) && deleteRoleplaySession(sessionKey)) deletedCount += 1;
  }
  return deletedCount;
}

module.exports = {
  appendRoleplayAssistantMessage,
  appendRoleplayTurn,
  createRoleplaySession,
  getRoleplaySession,
  getRoleplaySessionKey,
  resetRoleplaySession,
  resetRoleplaySessions,
  resetGuildRoleplaySessions,
};
