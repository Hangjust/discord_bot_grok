const assert = require('node:assert/strict');
const test = require('node:test');
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const { createInteractionCreateHandler } = require('../src/events/interactionCreate');

function createInteraction(overrides = {}) {
  const replies = [];
  const followUps = [];
  return {
    commandName: 'ai-help',
    guildId: '1001',
    memberPermissions: {
      has: (flag) => flag === PermissionFlagsBits.Administrator,
    },
    inGuild: () => true,
    isChatInputCommand: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
    reply: async (payload) => replies.push(payload),
    followUp: async (payload) => followUps.push(payload),
    replies,
    followUps,
    ...overrides,
  };
}

test('administrators can use private slash help without consulting AI policy', async () => {
  const accessPolicy = {
    isMessageAllowed: async () => assert.fail('help must not consult AI access policy'),
  };
  const interaction = createInteraction();
  const guildConfigService = {
    getStatus: async () => ({
      configured: true,
      triggerWord: 'llm',
      webSearchEnabled: true,
    }),
    resolveAgentBehavior: async () => ({ source: 'server' }),
  };
  const handler = createInteractionCreateHandler(null, { accessPolicy, guildConfigService });

  await handler(interaction);

  assert.equal(interaction.replies.length, 1);
  assert.equal(interaction.replies[0].embeds.length, 1);
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(interaction.followUps.length, 1);
  assert.ok(interaction.followUps.every(({ embeds }) => embeds.length === 1));
  assert.ok(interaction.followUps.every(({ flags }) => flags === MessageFlags.Ephemeral));
  const serialized = JSON.stringify([
    interaction.replies[0].embeds[0].toJSON(),
    ...interaction.followUps.map(({ embeds }) => embeds[0].toJSON()),
  ]);
  assert.match(serialized, /llm\/@bot <message>/);
  assert.doesNotMatch(serialized, /Setup areas|Current setup status|Web search:|Effective prompt:/);
  assert.doesNotMatch(serialized, /super-secret-provider-value/);
});

test('slash help rejects non-administrators', async () => {
  const interaction = createInteraction({
    memberPermissions: { has: () => false },
  });
  const handler = createInteractionCreateHandler(null, {});

  await handler(interaction);

  assert.equal(interaction.replies.length, 1);
  assert.match(interaction.replies[0].content, /administrators/i);
  assert.equal(interaction.followUps.length, 0);
});

test('slash help handles DMs explicitly and unrelated commands receive no acknowledgment', async () => {
  const handler = createInteractionCreateHandler(null, {});
  const dm = createInteraction({ guildId: null, inGuild: () => false });
  const unrelated = createInteraction({ commandName: 'unrelated' });

  await handler(dm);
  await handler(unrelated);

  assert.equal(dm.replies.length, 1);
  assert.match(dm.replies[0].content, /only works in a server/i);
  assert.equal(unrelated.replies.length, 0);
  assert.equal(unrelated.followUps.length, 0);
});
