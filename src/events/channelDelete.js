const {
  deleteRoleplayTicketByChannelId,
  getRoleplaySessionKey,
  resetRoleplaySession,
  resetRoleplayTicketRateLimit,
} = require('../roleplay');
const { resetConversation } = require('../state/conversations');
const {
  deleteIdleChatterStateForChannel,
} = require('../state/idleChatter');
const { resetConversationQueue } = require('../chat/conversationQueue');

function createChannelDeleteHandler() {
  return function handleChannelDelete(channel) {
    const channelId = channel?.id;
    const guildId = channel?.guildId ?? channel?.guild?.id;
    if (!channelId || !guildId) return;

    const ticket = deleteRoleplayTicketByChannelId(channelId);
    if (ticket) {
      resetRoleplaySession(getRoleplaySessionKey({
        guildId: ticket.guildId,
        channelId: ticket.channelId,
        userId: ticket.openerUserId,
        ticketId: ticket.ticketId,
      }));
      resetRoleplayTicketRateLimit(ticket.ticketId);
    }

    resetConversation(`${guildId}:${channelId}`);
    resetConversationQueue(`${guildId}:${channelId}`);
    deleteIdleChatterStateForChannel(guildId, channelId);
  };
}

module.exports = { createChannelDeleteHandler };
