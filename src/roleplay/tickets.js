const crypto = require('node:crypto');
const { roleplayTicketTopicPrefix } = require('./config');

const roleplayTicketsByChannelId = new Map();
const roleplayTicketCountsByGuild = new Map();
const maxRoleplayTickets = 4096;
const maxRoleplayTicketsPerGuild = 200;
const closedRoleplayTicketTtlMs = 24 * 60 * 60 * 1000;
const roleplayTicketCleanupIntervalMs = 30 * 60 * 1000;

function deleteTicketFromRegistry(channelId) {
  const ticket = roleplayTicketsByChannelId.get(channelId);
  if (!ticket || !roleplayTicketsByChannelId.delete(channelId)) return null;
  const guildId = String(ticket.guildId);
  const count = roleplayTicketCountsByGuild.get(guildId) ?? 0;
  if (count <= 1) roleplayTicketCountsByGuild.delete(guildId);
  else roleplayTicketCountsByGuild.set(guildId, count - 1);
  return ticket;
}

function pruneClosedRoleplayTickets(now = Date.now()) {
  for (const [channelId, ticket] of roleplayTicketsByChannelId) {
    if (ticket.status !== 'open' && now - ticket.createdAt >= closedRoleplayTicketTtlMs) {
      deleteTicketFromRegistry(channelId);
    }
  }
}

function evictOldestRoleplayTicket(guildId = null) {
  let oldestClosed = null;

  for (const [channelId, ticket] of roleplayTicketsByChannelId) {
    if (guildId != null && String(ticket.guildId) !== String(guildId)) continue;
    const candidate = { channelId, createdAt: ticket.createdAt };
    if (ticket.status !== 'open' && (!oldestClosed || candidate.createdAt < oldestClosed.createdAt)) {
      oldestClosed = candidate;
    }
  }

  if (oldestClosed) return Boolean(deleteTicketFromRegistry(oldestClosed.channelId));
  return false;
}

const roleplayTicketCleanupTimer = setInterval(
  pruneClosedRoleplayTickets,
  roleplayTicketCleanupIntervalMs,
);
roleplayTicketCleanupTimer.unref?.();

function createRoleplayTicketMetadata({ channelId, guildId, openerUserId, promptId, levelId, personName = '', promptText = '', improvedAi = false, ticketId = crypto.randomUUID(), createdAt = Date.now(), status = 'open' }) {
  return { ticketId, channelId, guildId, openerUserId, promptId, levelId, personName, promptText, improvedAi: Boolean(improvedAi), createdAt, status };
}

function registerRoleplayTicket(ticketInput) {
  pruneClosedRoleplayTickets();
  if (roleplayTicketsByChannelId.has(ticketInput.channelId)) {
    deleteTicketFromRegistry(ticketInput.channelId);
  }
  const guildId = String(ticketInput.guildId);
  while ((roleplayTicketCountsByGuild.get(guildId) ?? 0) >= maxRoleplayTicketsPerGuild) {
    if (!evictOldestRoleplayTicket(guildId)) {
      throw new RangeError('This guild roleplay ticket registry is at capacity.');
    }
  }
  while (roleplayTicketsByChannelId.size >= maxRoleplayTickets) {
    if (!evictOldestRoleplayTicket()) {
      throw new RangeError('The roleplay ticket registry is at capacity.');
    }
  }
  const ticket = createRoleplayTicketMetadata(ticketInput);
  roleplayTicketsByChannelId.set(ticket.channelId, ticket);
  roleplayTicketCountsByGuild.set(guildId, (roleplayTicketCountsByGuild.get(guildId) ?? 0) + 1);

  return ticket;
}

function canRegisterRoleplayTicket(guildId) {
  const normalizedGuildId = String(guildId);
  const guildCount = roleplayTicketCountsByGuild.get(normalizedGuildId) ?? 0;
  if (guildCount >= maxRoleplayTicketsPerGuild) {
    for (const ticket of roleplayTicketsByChannelId.values()) {
      if (String(ticket.guildId) === normalizedGuildId && ticket.status !== 'open') return true;
    }
    return false;
  }
  if (roleplayTicketsByChannelId.size < maxRoleplayTickets) return true;
  for (const ticket of roleplayTicketsByChannelId.values()) {
    if (ticket.status !== 'open') return true;
  }
  return false;
}

function getRoleplayTicketByChannelId(channelId) { return roleplayTicketsByChannelId.get(channelId) ?? null; }

function deleteRoleplayTicketByChannelId(channelId) {
  return deleteTicketFromRegistry(channelId);
}

function getOpenRoleplayTicketForUser(guildId, openerUserId) {
  for (const ticket of roleplayTicketsByChannelId.values()) {
    if (ticket.guildId === guildId && ticket.openerUserId === openerUserId && ticket.status === 'open') return ticket;
  }
  return null;
}

function closeRoleplayTicket(channelId) {
  const ticket = getRoleplayTicketByChannelId(channelId);
  if (ticket) ticket.status = 'closed';
  return ticket;
}

function buildRoleplayTicketTopic(ticket) {
  return `[${roleplayTicketTopicPrefix}${ticket.ticketId}] opener=${ticket.openerUserId} prompt=${ticket.promptId} level=${ticket.levelId} improved=${ticket.improvedAi ? '1' : '0'}`;
}

function parseRoleplayTicketTopic(topic) {
  const topicText = String(topic ?? '').trim();
  const currentMatch = topicText.match(/\[roleplay-ticket:([^\]]+)]\s+opener=([^\s]+)\s+prompt=([^\s]+)\s+level=([^\s]+)(?:\s+improved=([^\s]+))?/i);
  if (currentMatch) return { ticketId: currentMatch[1], openerUserId: currentMatch[2], promptId: currentMatch[3], levelId: currentMatch[4], improvedAi: currentMatch[5] === '1' };

  const unbracketedMatch = topicText.match(/roleplay-ticket:([^\s]+)\s+opener=([^\s]+)\s+prompt=([^\s]+)\s+level=([^\s]+)(?:\s+improved=([^\s]+))?/i);
  if (unbracketedMatch) return { ticketId: unbracketedMatch[1], openerUserId: unbracketedMatch[2], promptId: unbracketedMatch[3], levelId: unbracketedMatch[4], improvedAi: unbracketedMatch[5] === '1' };

  const legacyMatch = topicText.match(/^rp opener:\s*([^\s]+)/i);
  if (legacyMatch) return { ticketId: '', openerUserId: legacyMatch[1], promptId: '', levelId: '', improvedAi: false };

  return null;
}

function recognizeRoleplayTicketChannel(messageOrChannel) {
  const channel = messageOrChannel?.channel ?? messageOrChannel;
  const channelId = messageOrChannel?.channelId ?? channel?.id;
  const registeredTicket = channelId ? getRoleplayTicketByChannelId(channelId) : null;
  if (registeredTicket) return { kind: 'registered', ticket: registeredTicket };
  const marker = parseRoleplayTicketTopic(channel?.topic);
  return marker ? { kind: 'orphaned', marker } : { kind: 'none' };
}

function resetRoleplayTickets() {
  roleplayTicketsByChannelId.clear();
  roleplayTicketCountsByGuild.clear();
}

function deleteGuildRoleplayTickets(guildId) {
  const normalizedGuildId = String(guildId);
  const deletedTicketIds = [];
  for (const [channelId, ticket] of roleplayTicketsByChannelId) {
    if (String(ticket.guildId) === normalizedGuildId) {
      deletedTicketIds.push(ticket.ticketId);
      deleteTicketFromRegistry(channelId);
    }
  }
  return deletedTicketIds;
}

module.exports = { buildRoleplayTicketTopic, canRegisterRoleplayTicket, closeRoleplayTicket, createRoleplayTicketMetadata, deleteGuildRoleplayTickets, deleteRoleplayTicketByChannelId, getOpenRoleplayTicketForUser, getRoleplayTicketByChannelId, parseRoleplayTicketTopic, recognizeRoleplayTicketChannel, registerRoleplayTicket, resetRoleplayTickets };
