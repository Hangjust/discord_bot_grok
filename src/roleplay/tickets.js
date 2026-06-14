const crypto = require('node:crypto');
const { roleplayTicketTopicPrefix } = require('./config');

const roleplayTicketsByChannelId = new Map();

function createRoleplayTicketMetadata({ channelId, guildId, openerUserId, promptId, levelId, personName = '', promptText = '', improvedAi = false, ticketId = crypto.randomUUID(), createdAt = Date.now(), status = 'open' }) {
  return { ticketId, channelId, guildId, openerUserId, promptId, levelId, personName, promptText, improvedAi: Boolean(improvedAi), createdAt, status };
}

function registerRoleplayTicket(ticketInput) {
  const ticket = createRoleplayTicketMetadata(ticketInput);
  roleplayTicketsByChannelId.set(ticket.channelId, ticket);
  return ticket;
}

function getRoleplayTicketByChannelId(channelId) { return roleplayTicketsByChannelId.get(channelId) ?? null; }

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

function resetRoleplayTickets() { roleplayTicketsByChannelId.clear(); }

module.exports = { buildRoleplayTicketTopic, closeRoleplayTicket, createRoleplayTicketMetadata, getOpenRoleplayTicketForUser, getRoleplayTicketByChannelId, parseRoleplayTicketTopic, recognizeRoleplayTicketChannel, registerRoleplayTicket, resetRoleplayTickets };
