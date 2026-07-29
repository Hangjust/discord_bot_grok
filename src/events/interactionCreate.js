const { createGuildConfigInteractionHandler } = require('../interactions/guildConfig');
const { createAiHelpInteractionHandler, isAiHelpInteraction } = require('../interactions/help');
const {
  createAiPromptInteractionHandler,
  isAiPromptInteraction,
} = require('../interactions/agentBehavior');
const {
  createAiSetupInteractionHandler,
  isAiSetupInteraction,
} = require('../interactions/aiSetup');

function isAiConfigComponentInteraction(interaction) {
  return Boolean(
    (interaction.isButton?.() && String(interaction.customId || '').startsWith('ai-setup:'))
    || (interaction.isModalSubmit?.()
      && String(interaction.customId || '').startsWith('ai-setup:api:')),
  );
}

function createInteractionCreateHandler(discordClient, dependencies = {}) {
  const handleGuildConfig = dependencies.guildConfigService
    ? createGuildConfigInteractionHandler({
      ...dependencies,
      discordClient,
    })
    : async () => {};
  const handleAiHelp = createAiHelpInteractionHandler(dependencies);
  const handleAiPrompt = dependencies.guildConfigService
    ? createAiPromptInteractionHandler(dependencies)
    : async () => {};
  const handleAiSetup = dependencies.guildConfigService
    ? createAiSetupInteractionHandler({
      ...dependencies,
      configActions: handleGuildConfig,
      promptActions: handleAiPrompt,
    })
    : async () => {};

  return async function handleInteractionCreate(interaction) {
    if (isAiHelpInteraction(interaction)) {
      await handleAiHelp(interaction);
      return;
    }

    if (isAiPromptInteraction(interaction)) {
      await handleAiPrompt(interaction);
      return;
    }

    if (isAiSetupInteraction(interaction)) {
      await handleAiSetup(interaction);
      return;
    }

    if (isAiConfigComponentInteraction(interaction)) {
      await handleGuildConfig(interaction);
    }
  };
}

module.exports = {
  createInteractionCreateHandler,
  isAiConfigComponentInteraction,
};
