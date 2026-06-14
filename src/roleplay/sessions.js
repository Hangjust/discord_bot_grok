const { roleplaySessionHistoryLimit } = require('./config');
const roleplaySessions = new Map();
function getRoleplaySessionKey({ guildId, channelId, userId, ticketId }) { return [guildId, channelId, userId, ticketId].map((part) => String(part ?? '')).join(':'); }
function createRoleplaySession(now = Date.now()) { return { messages: [], createdAt: now, lastActivityAt: now }; }
function getRoleplaySession(sessionKey, now = Date.now()) {
  if (!roleplaySessions.has(sessionKey)) roleplaySessions.set(sessionKey, createRoleplaySession(now));
  return roleplaySessions.get(sessionKey);
}
function appendRoleplayTurn(session, userContent, assistantContent, now = Date.now()) {
  session.messages.push({ role: 'user', content: String(userContent ?? '') }, { role: 'assistant', content: String(assistantContent ?? '') });
  if (session.messages.length > roleplaySessionHistoryLimit) session.messages.splice(0, session.messages.length - roleplaySessionHistoryLimit);
  session.lastActivityAt = now;
}
function appendRoleplayAssistantMessage(session, assistantContent, now = Date.now()) {
  session.messages.push({ role: 'assistant', content: String(assistantContent ?? '') });
  if (session.messages.length > roleplaySessionHistoryLimit) session.messages.splice(0, session.messages.length - roleplaySessionHistoryLimit);
  session.lastActivityAt = now;
}
function resetRoleplaySession(sessionKey) { roleplaySessions.delete(sessionKey); }
function resetRoleplaySessions() { roleplaySessions.clear(); }
module.exports = { appendRoleplayAssistantMessage, appendRoleplayTurn, createRoleplaySession, getRoleplaySession, getRoleplaySessionKey, resetRoleplaySession, resetRoleplaySessions };
