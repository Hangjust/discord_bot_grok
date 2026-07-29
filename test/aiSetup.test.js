const assert = require('node:assert/strict');
const test = require('node:test');
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const {
  createAiSetupInteractionHandler,
  createSetupStatusEmbed,
} = require('../src/interactions/aiSetup');

// Keep the interaction object mutable without relying on Discord.js internals.
function setupInteraction(subcommand, overrides = {}) {
  const replies = [];
  const edits = [];
  const interaction = {
    commandName: 'ai-setup',
    guildId: '1001',
    channelId: '3001',
    user: { id: '2001' },
    deferred: false,
    replied: false,
    inGuild: () => true,
    isChatInputCommand: () => true,
    memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => ({
        action: overrides.action,
        provider: overrides.provider,
        scope: overrides.scope,
        value: overrides.value,
      })[name] ?? null,
      getBoolean: () => overrides.webSearch === true,
      getChannel: () => overrides.channel || null,
      getAttachment: () => overrides.file || null,
    },
    deferReply: async (payload) => {
      interaction.deferred = true;
      replies.push(payload);
    },
    editReply: async (payload) => edits.push(payload),
    reply: async (payload) => {
      interaction.replied = true;
      replies.push(payload);
    },
    replies,
    edits,
    ...overrides.interaction,
  };
  return interaction;
}

function createHandler(overrides = {}) {
  const configCalls = [];
  const promptCalls = [];
  const triggerCalls = [];
  const guildConfigService = {
    getStatus: async () => ({
      configured: true,
      revision: 7,
      aiProvider: 'deepseek',
      hasDeepseekKey: true,
      hasGeminiKey: false,
      hasBraveKey: false,
      webSearchEnabled: false,
      triggerWord: 'AI',
      access: {},
      secretForTest: 'DO-NOT-LEAK',
    }),
    resolveAgentBehavior: async () => ({
      source: 'server',
      characterCount: 123,
      content: 'DO-NOT-LEAK-PROMPT',
    }),
    setTriggerWord: async (...args) => {
      triggerCalls.push(args);
      return { changed: true, triggerWord: args[1], revision: 8 };
    },
    ...overrides.guildConfigService,
  };
  return {
    guildConfigService,
    configCalls,
    promptCalls,
    triggerCalls,
    handler: createAiSetupInteractionHandler({
      guildConfigService,
      configActions: {
        handleApi: async (interaction, provider, webSearchEnabled) => {
          configCalls.push({
            action: 'api',
            commandName: interaction.commandName,
            provider,
            webSearchEnabled,
          });
        },
        handleCommand: async (interaction) => {
          configCalls.push({
            action: interaction.options.getSubcommand(),
            commandName: interaction.commandName,
          });
        },
      },
      promptActions: {
        handleCommand: async (interaction) => {
          promptCalls.push({
          commandName: interaction.commandName,
          scope: interaction.options.getString('scope'),
          action: interaction.options.getString('action'),
          });
        },
      },
    }),
  };
}

test('AI setup status is private, embedded, and never contains keys or prompt text', async () => {
  const { handler } = createHandler();
  const interaction = setupInteraction('status');

  await handler(interaction);

  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  const serialized = JSON.stringify(interaction.edits[0].embeds[0].toJSON());
  assert.match(serialized, /AI Server Setup/);
  assert.match(serialized, /Trigger word.*AI/s);
  assert.doesNotMatch(serialized, /Ignored channels/);
  assert.doesNotMatch(serialized, /ai-setup api.*credentials/);
  assert.doesNotMatch(serialized, /DO-NOT-LEAK/);
});

test('setup status suggests API credentials only when the active provider key is missing', () => {
  const deepseekReady = JSON.stringify(createSetupStatusEmbed({
    configured: true,
    aiProvider: 'deepseek',
    hasDeepseekKey: true,
    hasGeminiKey: false,
    access: {},
  }, {}).toJSON());
  const gemmaReady = JSON.stringify(createSetupStatusEmbed({
    configured: true,
    aiProvider: 'gemma4',
    hasDeepseekKey: false,
    hasGeminiKey: true,
    access: {},
  }, {}).toJSON());
  const gemmaMissing = JSON.stringify(createSetupStatusEmbed({
    configured: false,
    aiProvider: 'gemma4',
    hasDeepseekKey: true,
    hasGeminiKey: false,
    access: {},
  }, {}).toJSON());

  assert.doesNotMatch(deepseekReady, /ai-setup api.*credentials/);
  assert.doesNotMatch(gemmaReady, /ai-setup api.*credentials/);
  assert.match(gemmaMissing, /ai-setup api.*credentials/);
});

test('AI setup routes trigger, API, access, and prompt operations through secure existing pipelines', async () => {
  const fixture = createHandler();
  const trigger = setupInteraction('trigger', { value: 'llm' });
  const api = setupInteraction('api', { provider: 'gemma4', webSearch: true });
  const channel = setupInteraction('channel', { action: 'allow' });
  const prompt = setupInteraction('prompt', { action: 'set', scope: 'channel' });

  await fixture.handler(trigger);
  await fixture.handler(api);
  await fixture.handler(channel);
  await fixture.handler(prompt);

  assert.deepEqual(fixture.triggerCalls, [['1001', 'llm', '2001']]);
  assert.match(trigger.edits[0].content, /llm help/);
  assert.deepEqual(fixture.configCalls, [
    {
      action: 'api',
      commandName: 'ai-setup',
      provider: 'gemma4',
      webSearchEnabled: true,
    },
    { action: 'channel', commandName: 'ai-setup' },
  ]);
  assert.deepEqual(fixture.promptCalls, [{
    commandName: 'ai-setup',
    scope: 'channel',
    action: 'set',
  }]);
});

test('AI setup status requires Manage Messages while mutations require Administrator', async () => {
  const failing = createHandler({
    guildConfigService: {
      setTriggerWord: async () => {
        throw new Error('DO-NOT-LEAK-KEY');
      },
    },
  });
  const dm = setupInteraction('status', {
    interaction: { guildId: null, inGuild: () => false },
  });
  const member = setupInteraction('status', {
    interaction: { memberPermissions: { has: () => false } },
  });
  const moderatorStatus = setupInteraction('status', {
    interaction: {
      memberPermissions: {
        has: (flag) => flag === PermissionFlagsBits.ManageMessages,
      },
    },
  });
  const moderatorMutation = setupInteraction('trigger', {
    value: 'llm',
    interaction: {
      memberPermissions: {
        has: (flag) => flag === PermissionFlagsBits.ManageMessages,
      },
    },
  });
  const failed = setupInteraction('trigger', { value: 'llm' });

  await failing.handler(dm);
  await failing.handler(member);
  await failing.handler(moderatorStatus);
  await failing.handler(moderatorMutation);
  await failing.handler(failed);

  assert.match(dm.replies[0].content, /only works in a server/i);
  assert.match(member.replies[0].content, /Manage Messages/i);
  assert.equal(moderatorStatus.edits.length, 1);
  assert.match(moderatorMutation.replies[0].content, /administrators/i);
  assert.doesNotMatch(JSON.stringify(failed.edits), /DO-NOT-LEAK/);
  assert.match(failed.edits[0].content, /could not be completed/i);
});

test('setup status embed omits unknown secret-bearing properties by construction', () => {
  const embed = createSetupStatusEmbed({
    configured: true,
    revision: 1,
    hasDeepseekKey: true,
    hasBraveKey: true,
    webSearchEnabled: true,
    triggerWord: 'llm',
    access: {},
    ciphertext: 'DO-NOT-LEAK',
  }, {
    source: 'channel',
    characterCount: 12,
    content: 'DO-NOT-LEAK-PROMPT',
  });

  assert.doesNotMatch(JSON.stringify(embed.toJSON()), /DO-NOT-LEAK/);
});
