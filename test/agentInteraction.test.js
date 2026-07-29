const assert = require('node:assert/strict');
const test = require('node:test');
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const {
  AGENT_IDS,
  createAiPromptInteractionHandler,
} = require('../src/interactions/agentBehavior');
const { getConversation } = require('../src/state/conversations');

function result(overrides = {}) {
  return Object.freeze({
    guildId: '1001',
    scope: 'server',
    channelId: null,
    targetId: '1001',
    changed: true,
    source: 'server',
    characterCount: 12,
    revision: 2,
    channelOverrideIds: [],
    updatedAt: null,
    updatedByUserId: null,
    ...overrides,
  });
}

function createService(overrides = {}) {
  const calls = [];
  return {
    calls,
    setAgentBehavior: async (...args) => {
      calls.push(['set', ...args]);
      return result({
        scope: args[1].scope,
        channelId: args[1].channelId || null,
        source: args[1].scope,
      });
    },
    clearAgentBehavior: async (...args) => {
      calls.push(['clear', ...args]);
      return result({
        scope: args[1].scope,
        channelId: args[1].channelId || null,
        source: args[1].scope === 'channel' ? 'server' : 'built-in',
        characterCount: 0,
      });
    },
    getAgentBehaviorStatus: async (...args) => {
      calls.push(['status', ...args]);
      return result({
        changed: false,
        scope: args[1].scope,
        channelId: args[1].channelId || null,
      });
    },
    exportAgentBehavior: async (...args) => {
      calls.push(['export', ...args]);
      return result({
        changed: false,
        scope: args[1].scope,
        channelId: args[1].channelId || null,
        content: 'Exact exported behavior',
      });
    },
    ...overrides,
  };
}

function createInteraction(type = 'command', overrides = {}) {
  const acknowledgments = [];
  const edits = [];
  const modals = [];
  const interaction = {
    commandName: type === 'command' ? 'ai-setup' : undefined,
    customId: overrides.customId || '',
    guildId: '1001',
    channelId: '3001',
    user: { id: '2001' },
    memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
    deferred: false,
    replied: false,
    inGuild: () => true,
    isChatInputCommand: () => type === 'command',
    isModalSubmit: () => type === 'modal',
    isButton: () => false,
    options: {
      getSubcommand: () => 'prompt',
      getString: (name) => ({
        scope: overrides.scope || 'server',
        action: overrides.operation || 'status',
        text: overrides.text,
      })[name] ?? null,
      getAttachment: (name) => (name === 'file' ? overrides.attachment : null),
      getChannel: () => (overrides.channelTargetId ? { id: overrides.channelTargetId } : null),
    },
    fields: {
      getTextInputValue: () => overrides.modalText || '',
    },
    reply: async (payload) => {
      interaction.replied = true;
      acknowledgments.push(['reply', payload]);
    },
    deferReply: async (payload) => {
      interaction.deferred = true;
      acknowledgments.push(['defer', payload]);
    },
    editReply: async (payload) => edits.push(payload),
    showModal: async (modal) => {
      acknowledgments.push(['modal', modal]);
      modals.push(modal);
    },
    acknowledgments,
    edits,
    modals,
    ...overrides,
  };
  return interaction;
}

test('agent status and export defer privately and expose metadata/content only in the download', async () => {
  const service = createService();
  const handler = createAiPromptInteractionHandler({ guildConfigService: service });
  const status = createInteraction('command', { scope: 'channel', operation: 'status' });
  const exported = createInteraction('command', { scope: 'channel', operation: 'export', channelTargetId: '3999' });

  await handler(status);
  await handler(exported);

  assert.deepEqual(service.calls.map(([name]) => name), ['status', 'export']);
  assert.equal(service.calls[0][2].channelId, '3001');
  assert.equal(service.calls[1][2].channelId, '3999');
  assert.equal(status.acknowledgments.length, 1);
  assert.equal(status.acknowledgments[0][0], 'defer');
  assert.equal(status.acknowledgments[0][1].flags, MessageFlags.Ephemeral);
  assert.doesNotMatch(status.edits[0].content, /Exact exported behavior/);
  assert.equal(exported.edits[0].files[0].name, 'AGENTS.md');
  assert.equal(exported.edits[0].files[0].attachment.toString('utf8'), 'Exact exported behavior');
});

test('direct and modal sets use exact targets and one-time owner-bound modal state', async () => {
  const service = createService();
  let now = 1_000;
  const handler = createAiPromptInteractionHandler({
    guildConfigService: service,
    now: () => now,
  });
  const direct = createInteraction('command', {
    scope: 'channel',
    operation: 'set',
    channelTargetId: '3999',
    text: '  Channel rules  ',
  });
  await handler(direct);

  assert.equal(service.calls[0][0], 'set');
  assert.deepEqual(service.calls[0][2], {
    scope: 'channel',
    channelId: '3999',
    content: 'Channel rules',
    updatedByUserId: '2001',
  });

  const open = createInteraction('command', {
    scope: 'channel',
    operation: 'set',
    channelTargetId: '3555',
  });
  await handler(open);
  assert.equal(open.acknowledgments.length, 1);
  assert.equal(open.acknowledgments[0][0], 'modal');
  const modalId = open.modals[0].data.custom_id;

  const wrongUser = createInteraction('modal', {
    customId: modalId,
    user: { id: '2999' },
    modalText: 'must not save',
  });
  await handler(wrongUser);
  assert.match(wrongUser.acknowledgments[0][1].content, /does not belong|expired/i);

  const wrongGuild = createInteraction('modal', {
    customId: modalId,
    guildId: '1999',
    modalText: 'must not save cross-guild',
  });
  await handler(wrongGuild);
  assert.match(wrongGuild.acknowledgments[0][1].content, /does not belong|expired/i);

  const valid = createInteraction('modal', {
    customId: modalId,
    channelId: '3998',
    modalText: 'Modal rules',
  });
  await handler(valid);
  assert.equal(service.calls.filter(([name]) => name === 'set').length, 2);
  assert.equal(service.calls.at(-1)[2].channelId, '3555');

  const replay = createInteraction('modal', { customId: modalId, modalText: 'replay' });
  await handler(replay);
  assert.match(replay.acknowledgments[0][1].content, /does not belong|expired/i);

  const expiring = createInteraction('command', { operation: 'set' });
  await handler(expiring);
  now += 10 * 60 * 1000;
  const expired = createInteraction('modal', {
    customId: expiring.modals[0].data.custom_id,
    modalText: 'expired',
  });
  await handler(expired);
  assert.match(expired.acknowledgments[0][1].content, /expired/i);
});

test('attachment set downloads Markdown before one service mutation and both sources mutate zero times', async () => {
  const service = createService();
  const handler = createAiPromptInteractionHandler({
    guildConfigService: service,
    fetchImpl: async () => ({
      ok: true,
      redirected: false,
      url: 'https://cdn.discordapp.com/attachments/1/2/AGENTS.md',
      headers: { get: () => null },
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: async () => {
              if (sent) return { done: true };
              sent = true;
              return { done: false, value: Buffer.from('Attachment rules') };
            },
            cancel: async () => {},
            releaseLock: () => {},
          };
        },
      },
    }),
  });
  const attachment = {
    name: 'AGENTS.MD',
    url: 'https://cdn.discordapp.com/attachments/1/2/AGENTS.md',
    size: 16,
  };
  await handler(createInteraction('command', { operation: 'set', attachment }));
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0][2].content, 'Attachment rules');

  const both = createInteraction('command', {
    operation: 'set',
    text: 'text',
    attachment,
  });
  await handler(both);
  assert.equal(service.calls.length, 1);
  assert.match(both.edits[0].content, /either text|not both/i);
  assert.equal(both.acknowledgments.length, 1);
});

test('changed operations invalidate only effective conversations and no-ops preserve them', async () => {
  const normalKey = '1001:3100';
  const overrideKey = '1001:3200';
  const otherKey = '2002:3100';
  const normal = getConversation(normalKey);
  const override = getConversation(overrideKey);
  const other = getConversation(otherKey);
  const service = createService({
    clearAgentBehavior: async (guildId, request) => result({
      guildId,
      scope: request.scope,
      channelId: request.channelId || null,
      changed: request.channelId !== '3300',
      source: 'built-in',
      channelOverrideIds: request.scope === 'server' ? ['3200'] : [],
    }),
  });
  const handler = createAiPromptInteractionHandler({ guildConfigService: service });

  await handler(createInteraction('command', { operation: 'clear' }));
  assert.notEqual(getConversation(normalKey), normal);
  assert.equal(getConversation(overrideKey), override);
  assert.equal(getConversation(otherKey), other);

  const noOp = getConversation('1001:3300');
  await handler(createInteraction('command', {
    scope: 'channel',
    operation: 'clear',
    channelTargetId: '3300',
  }));
  assert.equal(getConversation('1001:3300'), noOp);

  const semanticNoOp = getConversation('1001:3400');
  const semanticService = createService({
    setAgentBehavior: async () => result({
      scope: 'channel',
      channelId: '3400',
      changed: true,
      effectiveChanged: false,
      source: 'channel',
    }),
  });
  const semanticHandler = createAiPromptInteractionHandler({ guildConfigService: semanticService });
  await semanticHandler(createInteraction('command', {
    scope: 'channel',
    operation: 'set',
    channelTargetId: '3400',
    text: 'same effective content',
  }));
  assert.equal(getConversation('1001:3400'), semanticNoOp);
});

test('DMs and non-admins fail once while unrelated interactions are ignored', async () => {
  const service = createService();
  const handler = createAiPromptInteractionHandler({ guildConfigService: service });
  const dm = createInteraction('command', { guildId: null, inGuild: () => false });
  const member = createInteraction('command', {
    memberPermissions: { has: () => false },
  });
  const unrelated = createInteraction('command', { commandName: 'other' });

  assert.equal(await handler(dm), true);
  assert.equal(await handler(member), true);
  assert.equal(await handler(unrelated), false);
  assert.equal(dm.acknowledgments.length, 1);
  assert.equal(member.acknowledgments.length, 1);
  assert.equal(unrelated.acknowledgments.length, 0);
  assert.equal(service.calls.length, 0);
});

test('persistence and validation failures are generic, private, and never echo content', async () => {
  const service = createService({
    setAgentBehavior: async () => {
      throw new Error('database failure submitted-private-text');
    },
  });
  const handler = createAiPromptInteractionHandler({ guildConfigService: service });
  const interaction = createInteraction('command', {
    operation: 'set',
    text: 'submitted-private-text',
  });

  await handler(interaction);

  assert.equal(interaction.acknowledgments.length, 1);
  assert.equal(interaction.acknowledgments[0][0], 'defer');
  assert.doesNotMatch(JSON.stringify(interaction.edits), /submitted-private-text/);
  assert.match(interaction.edits[0].content, /could not be completed/i);
});

test('unconfigured or legacy-only guilds allow read-only status/export but mutate no state', async () => {
  let mutations = 0;
  const service = createService({
    getAgentBehaviorStatus: async (guildId, request) => result({
      guildId,
      scope: request.scope,
      changed: false,
      source: 'built-in',
      characterCount: 100,
      revision: 0,
    }),
    exportAgentBehavior: async (guildId, request) => result({
      guildId,
      scope: request.scope,
      changed: false,
      source: 'built-in',
      characterCount: 100,
      revision: 0,
      content: 'Built-in behavior',
    }),
    setAgentBehavior: async () => {
      throw new Error('Guild is not configured');
    },
    clearAgentBehavior: async () => {
      throw new Error('Guild is not configured');
    },
  });
  const handler = createAiPromptInteractionHandler({ guildConfigService: service });
  const interactions = [
    createInteraction('command', { operation: 'status' }),
    createInteraction('command', { operation: 'export' }),
    createInteraction('command', { operation: 'set', text: 'do not store' }),
    createInteraction('command', { operation: 'clear' }),
  ];

  for (const interaction of interactions) {
    await handler(interaction);
    assert.equal(interaction.acknowledgments.length, 1);
  }

  assert.match(interactions[0].edits[0].content, /built-in/i);
  assert.equal(interactions[1].edits[0].files[0].attachment.toString(), 'Built-in behavior');
  assert.match(interactions[2].edits[0].content, /could not be completed/i);
  assert.match(interactions[3].edits[0].content, /could not be completed/i);
  assert.equal(mutations, 0);
});

test('agent modal custom IDs remain namespaced', () => {
  assert.match(AGENT_IDS.modalPrefix, /^ai-setup:prompt:/);
});
