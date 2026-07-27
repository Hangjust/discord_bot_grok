const assert = require('node:assert/strict');
const test = require('node:test');
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const { commandDefinitions } = require('../src/interactions/commandDefinitions');
const { createGuildConfigInteractionHandler, IDS } = require('../src/interactions/guildConfig');

function createService(overrides = {}) {
  const calls = [];
  return {
    calls,
    getStatus: async () => ({
      configured: false,
      source: 'none',
      hasDeepseekKey: false,
      webSearchEnabled: false,
      hasBraveKey: false,
      access: {
        allowedChannelIds: [], ignoredChannelIds: [], allowedRoleIds: [], ignoredRoleIds: [],
      },
    }),
    configureGuild: async (...args) => calls.push(['configureGuild', ...args]),
    moveAccessEntry: async (...args) => calls.push(['moveAccessEntry', ...args]),
    setWebSearch: async (...args) => calls.push(['setWebSearch', ...args]),
    rotateSecret: async (...args) => calls.push(['rotateSecret', ...args]),
    resetGuild: async (...args) => calls.push(['resetGuild', ...args]),
    ...overrides,
  };
}

function createInteraction(type, overrides = {}) {
  const replies = [];
  const edits = [];
  const modals = [];
  const interaction = {
    type,
    commandName: type === 'command' ? 'grok-config' : undefined,
    customId: overrides.customId || '',
    guildId: '1001',
    channelId: '3001',
    channel: null,
    user: { id: '2001' },
    memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
    deferred: false,
    replied: false,
    inGuild: () => true,
    isChatInputCommand: () => type === 'command',
    isButton: () => type === 'button',
    isModalSubmit: () => type === 'modal',
    options: {
      getSubcommand: () => overrides.subcommand || 'status',
      getString: (name) => overrides[name],
      getChannel: () => ({ id: overrides.channelTargetId || '3002' }),
      getRole: () => ({ id: overrides.roleTargetId || '5001' }),
    },
    fields: {
      getTextInputValue: (name) => overrides.fields?.[name] || '',
    },
    reply: async (value) => {
      interaction.replied = true;
      replies.push(value);
    },
    deferReply: async (value) => {
      interaction.deferred = true;
      replies.push(value);
    },
    editReply: async (value) => edits.push(value),
    showModal: async (value) => modals.push(value),
    replies,
    edits,
    modals,
    ...overrides,
    options: {
      getSubcommand: () => overrides.subcommand || 'status',
      getString: (name) => overrides[name],
      getChannel: () => ({ id: overrides.channelTargetId || '3002' }),
      getRole: () => ({ id: overrides.roleTargetId || '5001' }),
    },
    fields: {
      getTextInputValue: (name) => overrides.fields?.[name] || '',
    },
  };
  return interaction;
}

function createHandler(service = createService(), overrides = {}) {
  const validated = [];
  return {
    service,
    validated,
    handler: createGuildConfigInteractionHandler({
      guildConfigService: service,
      credentialValidators: {
        validateDeepseekKey: async (key) => validated.push(['deepseek', key]),
        validateBraveKey: async (key) => validated.push(['brave', key]),
      },
      ...overrides,
    }),
  };
}

test('grok-config definition is guild-only and administrator-defaulted', () => {
  const definition = commandDefinitions[0];
  assert.equal(definition.name, 'grok-config');
  assert.deepEqual(definition.contexts, [0]);
  assert.equal(definition.default_member_permissions, String(PermissionFlagsBits.Administrator));
  assert.deepEqual(definition.options.map((option) => option.name), [
    'setup', 'status', 'channel', 'role', 'web', 'secret', 'reset',
  ]);
});

test('guild and administrator checks reject with ephemeral responses', async () => {
  const { handler } = createHandler();
  const dm = createInteraction('command', { guildId: null, inGuild: () => false });
  const member = createInteraction('command', { memberPermissions: { has: () => false } });

  await handler(dm);
  await handler(member);

  assert.equal(dm.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(dm.replies[0].content, /only works in a server/i);
  assert.equal(member.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(member.replies[0].content, /administrators/i);
});

test('unconfigured guilds reject administration while setup and status remain available', async () => {
  const { handler, service } = createHandler();
  const interactions = [
    createInteraction('command', { subcommand: 'channel', action: 'allow' }),
    createInteraction('command', { subcommand: 'role', action: 'ignore' }),
    createInteraction('command', { subcommand: 'web', action: 'disable' }),
    createInteraction('command', { subcommand: 'secret', field: 'deepseek' }),
    createInteraction('command', { subcommand: 'reset' }),
  ];

  for (const interaction of interactions) {
    await handler(interaction);
    assert.match(interaction.replies[0].content, /not configured|setup/i);
  }

  const setup = createInteraction('command', { subcommand: 'setup' });
  const status = createInteraction('command', { subcommand: 'status' });
  await handler(setup);
  await handler(status);

  assert.equal(setup.replies[0].components.length, 1);
  assert.match(status.replies[0].content, /not configured/i);
  assert.equal(service.calls.length, 0);
});

test('setup with web search validates both keys and stores only through the service', async () => {
  const { handler, service, validated } = createHandler();
  const setup = createInteraction('command', { subcommand: 'setup' });
  await handler(setup);
  assert.equal(setup.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(setup.replies[0].components.length, 1);

  const choice = createInteraction('button', { customId: IDS.setupWebEnabled });
  await handler(choice);
  assert.equal(choice.modals.length, 1);
  const modalId = choice.modals[0].data.custom_id;

  const submission = createInteraction('modal', {
    customId: modalId,
    fields: {
      'deepseek-key': 'deep-secret-value',
      'brave-key': 'brave-secret-value',
    },
  });
  await handler(submission);

  assert.deepEqual(validated, [
    ['deepseek', 'deep-secret-value'],
    ['brave', 'brave-secret-value'],
  ]);
  assert.deepEqual(service.calls[0], ['configureGuild', '1001', {
    configuredByUserId: '2001',
    setupChannelId: '3001',
    deepseekApiKey: 'deep-secret-value',
    webSearchEnabled: true,
    braveApiKey: 'brave-secret-value',
  }]);
  assert.equal(submission.replies[0].flags, MessageFlags.Ephemeral);
  assert.doesNotMatch(JSON.stringify([...setup.replies, ...submission.edits]), /deep-secret-value|brave-secret-value/);
});

test('setup with web disabled asks for and validates only DeepSeek', async () => {
  const { handler, validated, service } = createHandler();
  const choice = createInteraction('button', { customId: IDS.setupWebDisabled });
  await handler(choice);
  const modalId = choice.modals[0].data.custom_id;
  const submission = createInteraction('modal', {
    customId: modalId,
    fields: { 'deepseek-key': 'deep-only-secret' },
  });

  await handler(submission);
  assert.deepEqual(validated, [['deepseek', 'deep-only-secret']]);
  assert.equal(service.calls[0][2].webSearchEnabled, false);
  assert.equal(service.calls[0][2].braveApiKey, '');
});

test('modal state is bound to guild and user and is consumed once', async () => {
  const { handler, service } = createHandler();
  const choice = createInteraction('button', { customId: IDS.setupWebDisabled });
  await handler(choice);
  const modalId = choice.modals[0].data.custom_id;
  const wrongUser = createInteraction('modal', {
    customId: modalId,
    user: { id: '2999' },
    fields: { 'deepseek-key': 'must-not-save' },
  });
  await handler(wrongUser);

  assert.match(wrongUser.replies[0].content, /expired|does not belong/i);
  assert.equal(service.calls.length, 0);

  const valid = createInteraction('modal', {
    customId: modalId,
    fields: { 'deepseek-key': 'valid-owner-secret' },
  });
  await handler(valid);
  assert.equal(service.calls.length, 1);

  const replay = createInteraction('modal', {
    customId: modalId,
    fields: { 'deepseek-key': 'must-not-save-either' },
  });
  await handler(replay);
  assert.match(replay.replies[0].content, /expired|does not belong/i);
  assert.equal(service.calls.length, 1);
});

test('credential failures return generic secret-free errors and do not save', async () => {
  const service = createService();
  const { handler } = createHandler(service, {
    credentialValidators: {
      validateDeepseekKey: async () => { throw new Error('provider leaked submitted-secret'); },
      validateBraveKey: async () => true,
    },
  });
  const choice = createInteraction('button', { customId: IDS.setupWebDisabled });
  await handler(choice);
  const submission = createInteraction('modal', {
    customId: choice.modals[0].data.custom_id,
    fields: { 'deepseek-key': 'submitted-secret' },
  });
  await handler(submission);

  assert.equal(service.calls.length, 0);
  assert.match(submission.edits[0].content, /could not be validated or saved/i);
  assert.doesNotMatch(JSON.stringify(submission.edits), /submitted-secret/);
});

test('channel and role actions, web toggles, rotation, and reset route to the service', async () => {
  const service = createService({
    getStatus: async () => ({
      configured: true,
      source: 'stored',
      hasDeepseekKey: true,
      webSearchEnabled: false,
      hasBraveKey: true,
      access: { allowedChannelIds: [], ignoredChannelIds: [], allowedRoleIds: [], ignoredRoleIds: [] },
    }),
  });
  const { handler } = createHandler(service);

  await handler(createInteraction('command', { subcommand: 'channel', action: 'ignore' }));
  await handler(createInteraction('command', { subcommand: 'role', action: 'allow' }));
  await handler(createInteraction('command', { subcommand: 'web', action: 'enable' }));

  const rotate = createInteraction('command', { subcommand: 'secret', field: 'brave' });
  await handler(rotate);
  const rotateSubmit = createInteraction('modal', {
    customId: rotate.modals[0].data.custom_id,
    fields: { 'secret-key': 'rotated-brave-secret' },
  });
  await handler(rotateSubmit);

  const reset = createInteraction('command', { subcommand: 'reset' });
  await handler(reset);
  const resetId = reset.replies[0].components[0].components[0].data.custom_id;
  await handler(createInteraction('button', { customId: resetId }));

  assert.deepEqual(service.calls, [
    ['moveAccessEntry', '1001', 'channel', 'ignore', '3002'],
    ['moveAccessEntry', '1001', 'role', 'allow', '5001'],
    ['setWebSearch', '1001', true],
    ['rotateSecret', '1001', 'brave', 'rotated-brave-secret'],
    ['resetGuild', '1001', '2001'],
  ]);
});

test('status reports booleans and lists without ciphertext or plaintext keys', async () => {
  const service = createService({
    getStatus: async () => ({
      configured: true,
      source: 'stored',
      hasDeepseekKey: true,
      webSearchEnabled: true,
      hasBraveKey: true,
      access: {
        allowedChannelIds: ['3001'], ignoredChannelIds: ['3002'], allowedRoleIds: ['5001'], ignoredRoleIds: [],
      },
    }),
  });
  const { handler } = createHandler(service);
  const interaction = createInteraction('command', { subcommand: 'status' });
  await handler(interaction);

  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(interaction.replies[0].content, /DeepSeek key stored: \*\*yes\*\*/);
  assert.match(interaction.replies[0].content, /`3001`/);
  assert.doesNotMatch(interaction.replies[0].content, /ciphertext|apiKey/i);
});
