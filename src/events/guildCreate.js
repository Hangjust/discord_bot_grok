const { ensureSetupPanel } = require('../setup/panel');

function createGuildCreateHandler(store) {
  return async function handleGuildCreate(guild) {
    try {
      const panel = await ensureSetupPanel(guild, store, { force: true });
      if (!panel) {
        console.warn('Joined a guild but could not find a channel for the setup panel.', { guildId: guild?.id });
      }
    } catch (error) {
      console.error('Could not create the join setup panel.', {
        name: error?.name,
        message: error?.message,
        guildId: guild?.id,
      });
    }
  };
}

module.exports = {
  createGuildCreateHandler,
};
