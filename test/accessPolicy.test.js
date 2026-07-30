const assert = require('node:assert/strict');
const test = require('node:test');
const { PermissionFlagsBits } = require('discord.js');
const {
  createAccessPolicy,
  evaluateGuildChannelAccess,
  evaluateMessageAccess,
} = require('../src/discord/accessPolicy');
const { createMessageCreateHandler } = require('../src/events/messageCreate');
const { getConversation, resetConversation } = require('../src/state/conversations');

function createConfig(access = {}, overrides = {}) {
  return {
    configured: true,
    access: {
      allowedChannelIds: [],
      ignoredChannelIds: [],
      allowedRoleIds: [],
      ignoredRoleIds: [],
      ...access,
    },
    ...overrides,
  };
}

function createMessage(overrides = {}) {
  const channel = {
    id: '200',
    guildId: '100',
    parentId: null,
    send: async () => null,
  };

  return {
    author: { id: '400', bot: false, username: 'user' },
    channel,
    channelId: channel.id,
    content: 'ordinary message',
    guild: { id: '100' },
    guildId: '100',
    member: {
      permissions: {
        has: (flag) => flag === PermissionFlagsBits.ViewChannel
          || flag === PermissionFlagsBits.SendMessages,
      },
      roles: { cache: new Map([['300', { id: '300' }]]) },
    },
    mentions: { has: () => false },
    ...overrides,
  };
}

test('access policy denies bots, webhooks, DMs, and unconfigured guilds first', async () => {
  let statusReads = 0;
  const policy = createAccessPolicy({
    guildConfigService: {
      getStatus: async () => {
        statusReads += 1;
        return createConfig();
      },
    },
  });

  assert.equal((await policy.evaluateMessage(createMessage({ author: { bot: true } }))).reason, 'bot');
  assert.equal((await policy.evaluateMessage(createMessage({ webhookId: '900' }))).reason, 'webhook');
  assert.equal((await policy.evaluateMessage(createMessage({ guild: null, guildId: null }))).reason, 'dm');
  assert.equal(statusReads, 0);
  assert.equal(evaluateMessageAccess(createMessage(), createConfig({}, { configured: false })).reason, 'unconfigured');
});

test('channel ignores beat allows and threads inherit parent rules', () => {
  const thread = createMessage({
    channelId: '201',
    channel: { id: '201', guildId: '100', parentId: '200' },
  });

  assert.equal(evaluateGuildChannelAccess(thread, createConfig({ allowedChannelIds: ['200'] })).allowed, true);
  assert.equal(evaluateGuildChannelAccess(thread, createConfig({
    allowedChannelIds: ['200', '201'],
    ignoredChannelIds: ['201'],
  })).reason, 'ignored-channel');
  assert.equal(evaluateGuildChannelAccess(thread, createConfig({
    allowedChannelIds: ['201'],
    ignoredChannelIds: ['200'],
  })).reason, 'ignored-channel');
  assert.equal(evaluateGuildChannelAccess(thread, createConfig({ allowedChannelIds: ['999'] })).reason, 'channel-not-allowed');
  assert.equal(evaluateGuildChannelAccess(thread, createConfig()).allowed, true);
});

test('ignored roles beat allowed roles and administrators do not bypass policy', () => {
  const administrator = createMessage({
    member: {
      permissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
      roles: { cache: new Map([['300', { id: '300' }]]) },
    },
  });

  assert.equal(evaluateMessageAccess(administrator, createConfig({
    allowedRoleIds: ['300'],
    ignoredRoleIds: ['300'],
  })).reason, 'ignored-role');
  assert.equal(evaluateMessageAccess(administrator, createConfig({ allowedRoleIds: ['999'] })).reason, 'role-not-allowed');
  assert.equal(evaluateMessageAccess(administrator, createConfig({ ignoredRoleIds: ['999'] })).allowed, true);
});

test('role restrictions fail closed when member role data is missing', () => {
  assert.equal(evaluateMessageAccess(createMessage({ member: null }), createConfig()).allowed, true);
  assert.equal(evaluateMessageAccess(createMessage({ member: null }), createConfig({ allowedRoleIds: ['300'] })).reason, 'missing-member-roles');
  assert.equal(evaluateMessageAccess(createMessage({ member: {} }), createConfig({ ignoredRoleIds: ['300'] })).reason, 'missing-member-roles');
});

test('role-authorized members can use AI without message-management permissions', () => {
  const member = createMessage({
    member: {
      permissions: { has: () => false },
      roles: { cache: new Map([['300', { id: '300' }]]) },
    },
  });

  assert.equal(evaluateMessageAccess(member, createConfig({ allowedRoleIds: ['300'] })).allowed, true);
});

test('normal AI chat reaches the provider for an allowed role without Manage Messages', async () => {
  const replies = [];
  let providerCalls = 0;
  const guildConfigService = {
    getStatus: async () => createConfig({ allowedRoleIds: ['300'] }),
    getInvocationConfig: async () => ({ triggerWord: 'AI' }),
    resolveRuntimeConfig: async () => ({
      configured: true,
      deepseek: { apiKey: 'test-provider-key' },
      webSearch: { enabled: false },
    }),
  };
  const accessPolicy = createAccessPolicy({ guildConfigService });
  const handler = createMessageCreateHandler({ user: { id: '900' } }, {
    accessPolicy,
    guildConfigService,
    factCheckClaim: async () => {
      providerCalls += 1;
      return 'normal member response';
    },
    logger: { error: () => assert.fail('provider should not fail') },
  });
  const message = createMessage({
    content: 'AI hello',
    member: {
      permissions: { has: () => false },
      roles: { cache: new Map([['300', { id: '300' }]]) },
    },
    reply: async (payload) => replies.push(payload),
  });

  await handler(message);

  assert.equal(providerCalls, 1);
  assert.equal(replies[0].content, 'normal member response');
  resetConversation('100:200');
});

test('service failures fail closed and configured status is read per decision', async () => {
  let configured = true;
  const policy = createAccessPolicy({
    guildConfigService: {
      getStatus: async () => {
        if (configured === null) throw new Error('store unavailable');
        return createConfig({}, { configured });
      },
    },
  });

  assert.equal(await policy.isMessageAllowed(createMessage()), true);
  configured = false;
  assert.equal(await policy.isMessageAllowed(createMessage()), false);
  configured = null;
  assert.equal((await policy.evaluateMessage(createMessage())).reason, 'config-unavailable');
});

test('denied messages do not mutate conversation, profile, command, or reply state', async () => {
  const guildId = '71001';
  const channelId = '72001';
  const userId = '73001';
  const now = Date.UTC(2026, 6, 27);
  const replies = [];
  const message = createMessage({
    author: { id: userId, bot: false, username: 'denied' },
    channel: {
      id: channelId,
      guildId,
      send: async () => {
        throw new Error('denied message attempted channel send');
      },
      sendTyping: async () => {
        throw new Error('denied message attempted typing');
      },
    },
    channelId,
    content: 'AI explain this',
    guild: { id: guildId },
    guildId,
    reply: async (value) => replies.push(value),
  });
  const handler = createMessageCreateHandler({ user: { id: '74001' } }, {
    accessPolicy: {
      isChannelEligible: async () => false,
      isMessageAllowed: async () => false,
    },
  });

  const conversationKey = `${guildId}:${channelId}`;

  resetConversation(conversationKey);
  await handler(message);

  assert.equal(replies.length, 0);
  assert.deepEqual(getConversation(conversationKey, now).messages, []);

  resetConversation(conversationKey);
});
