const { getRoleplaySessionKey, resetRoleplaySession } = require('./sessions');
const { closeRoleplayTicket, getRoleplayTicketByChannelId } = require('./tickets');
const { recordRoleplayTicketReopenCooldown } = require('./rateLimit');

async function deleteRoleplayTicketChannel(channel) {
  if (typeof channel?.delete !== 'function') return false;
  await channel.delete('Roleplay ticket closed');
  return true;
}

async function closeRoleplayTicketChannel({ channel, channelId, userId }) {
  const ticket = getRoleplayTicketByChannelId(channelId ?? channel?.id);
  if (!ticket) return null;
  if (userId && userId !== ticket.openerUserId) return null;
  if (channel?.id && channel.id !== ticket.channelId) return null;

  closeRoleplayTicket(ticket.channelId);
  recordRoleplayTicketReopenCooldown(`${ticket.guildId}:${ticket.openerUserId}`);
  resetRoleplaySession(getRoleplaySessionKey({ guildId: ticket.guildId, channelId: ticket.channelId, userId: ticket.openerUserId, ticketId: ticket.ticketId }));

  try {
    await deleteRoleplayTicketChannel(channel);
  } catch (error) {
    console.error(error);
  }

  return ticket;
}

module.exports = { closeRoleplayTicketChannel, deleteRoleplayTicketChannel };
