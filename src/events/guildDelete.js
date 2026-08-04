const { resetGuildChatRateLimits } = require('../chat/rateLimit');
const { resetGuildConversationQueues } = require('../chat/conversationQueue');
const { resetGuildFunmuteCooldown } = require('../commands/funmute');
const { resetGuildConversations } = require('../state/conversations');
const { deleteGuildIdleChatterState } = require('../state/idleChatter');
const { deleteGuildUserProfiles } = require('../state/userProfiles');
const {
  deleteGuildRoleplayTickets,
  resetGuildRoleplayRateLimits,
  resetGuildRoleplaySessions,
} = require('../roleplay');
const { deleteGuildSetupDrafts } = require('../setup/drafts');
const { cancelGuildApiKeyOperation } = require('../setup/interactions');

function createGuildDeleteHandler(store) {
  return async function handleGuildDelete(guild) {
    try {
      cancelGuildApiKeyOperation(guild.id);
      deleteGuildSetupDrafts(guild.id);
      resetGuildConversations(guild.id);
      resetGuildConversationQueues(guild.id);
      resetGuildChatRateLimits(guild.id);
      resetGuildFunmuteCooldown(guild.id);
      deleteGuildIdleChatterState(guild.id);
      deleteGuildUserProfiles(guild.id);
      const deletedRoleplayTicketIds = deleteGuildRoleplayTickets(guild.id);
      resetGuildRoleplaySessions(guild.id);
      resetGuildRoleplayRateLimits(guild.id, deletedRoleplayTicketIds);
      await store.delete(guild.id);
    } catch (error) {
      console.error('Could not remove configuration for a guild the bot left.', {
        name: error?.name,
        message: error?.message,
        guildId: guild?.id,
      });
    }
  };
}

module.exports = {
  createGuildDeleteHandler,
};
