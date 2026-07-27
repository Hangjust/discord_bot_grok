const { createGuildConfigInteractionHandler } = require('../interactions/guildConfig');

function createInteractionCreateHandler(discordClient, dependencies = {}) {
  const handleGuildConfig = createGuildConfigInteractionHandler({
    ...dependencies,
    discordClient,
  });

  return async function handleInteractionCreate(interaction) {
    await handleGuildConfig(interaction);
  };
}

module.exports = {
  createInteractionCreateHandler,
};
