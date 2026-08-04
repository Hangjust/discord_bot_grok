'use strict';

// Load the production event modules with a distinctive, valid provider timeout
// so the integration path can prove that the configured value reaches the
// injected fetch boundary without making a real request.
const previousDeepSeekTimeout = process.env.DEEPSEEK_TIMEOUT_MS;
process.env.DEEPSEEK_TIMEOUT_MS = '1234';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

const { resetChatRateLimits } = require('../src/chat/rateLimit');
const { resetConversationQueues } = require('../src/chat/conversationQueue');
const { canReplyInChannel } = require('../src/discord/channel');
const { createChannelDeleteHandler } = require('../src/events/channelDelete');
const { createInteractionCreateHandler } = require('../src/events/interactionCreate');
const { createMessageCreateHandler } = require('../src/events/messageCreate');
const {
  buildRoleplayModalCustomId,
  roleplayCustomIds,
  roleplayCustomPromptId,
} = require('../src/roleplay/config');
const { buildRoleplayDeepSeekPayload } = require('../src/roleplay/deepseek');
const { createRoleplayTicketFromInteraction } = require('../src/roleplay/interactions');
const { resetRoleplayRateLimits } = require('../src/roleplay/rateLimit');
const { maxRoleplayResponseCharacters } = require('../src/roleplay/replies');
const {
  appendRoleplayTurn,
  getRoleplaySession,
  getRoleplaySessionKey,
  resetRoleplaySessions,
} = require('../src/roleplay/sessions');
const {
  getOpenRoleplayTicketForUser,
  getRoleplayTicketByChannelId,
  registerRoleplayTicket,
  resetRoleplayTickets,
} = require('../src/roleplay/tickets');
const { setupCustomIds } = require('../src/setup/constants');
const { createSetupDraft, resetSetupDrafts } = require('../src/setup/drafts');
const { draftTypes, handleSetupInteraction } = require('../src/setup/interactions');
const {
  deleteGuildIdleChatterState,
  getIdleChatterState,
  recordGuildIdleChatterChannel,
} = require('../src/state/idleChatter');
const {
  clearConversations,
  getConversation,
} = require('../src/state/conversations');
const {
  createDefaultGuildConfig,
} = require('../src/storage/guildConfigStore');
const { deepSeekTimeoutMs } = require('../src/config/env');

const BOT_ID = '900000000000000001';
const DEFAULT_USER_ID = '100000000000000001';
const VALID_ENCRYPTED_KEY = 'v1.YQ==.Yg==.Yw==';

let originalFetch;

function clone(value) {
  return structuredClone(value);
}

function makeConfiguredGuildConfig(channelId) {
  const config = createDefaultGuildConfig();
  config.persona = {
    ...config.persona,
    characterName: 'Nova',
    behavior: 'Helpful, candid, playful, accurate, safe, and concise in every server conversation. '.repeat(2),
    triggerWord: 'AI',
  };
  config.access = {
    channelIds: [String(channelId)],
    allowedRoleIds: [],
    blockedRoleIds: [],
  };
  config.provider = {
    encryptedKey: VALID_ENCRYPTED_KEY,
    keyStatus: 'valid',
    checkedAt: '2026-07-09T00:00:00.000Z',
    fingerprint: 'sha256:0123456789abcdef',
  };
  config.advanced = {
    ...config.advanced,
    contextMessages: 10,
    cooldownSeconds: 0,
    webSearchMode: 'off',
  };
  return config;
}

function makeGuildConfigStore(configs, decryptedKeys = new Map()) {
  const configByGuild = configs instanceof Map ? configs : new Map(Object.entries(configs));
  const calls = {
    get: [],
    getApiKey: [],
  };

  return {
    calls,
    async get(guildId) {
      const normalizedGuildId = String(guildId);
      calls.get.push(normalizedGuildId);
      const config = configByGuild.get(normalizedGuildId);
      return clone(config ?? createDefaultGuildConfig());
    },
    async getApiKey(guildId) {
      const normalizedGuildId = String(guildId);
      calls.getApiKey.push(normalizedGuildId);
      return decryptedKeys.get(normalizedGuildId) ?? null;
    },
  };
}

function makeForbiddenAccessStore({ decryptedKeys = new Map() } = {}) {
  const calls = {
    get: [],
    getApiKey: [],
  };

  return {
    calls,
    async get(guildId) {
      calls.get.push(String(guildId));
      throw new Error('Configured chat access must not run for a roleplay route.');
    },
    async getApiKey(guildId) {
      const normalizedGuildId = String(guildId);
      calls.getApiKey.push(normalizedGuildId);
      return decryptedKeys.get(normalizedGuildId) ?? null;
    },
  };
}

function makeCollection(entries = []) {
  const values = new Map(entries.map((entry) => [String(entry.id), entry]));
  return {
    first: () => values.values().next().value ?? null,
    get: (id) => values.get(String(id)) ?? null,
    has: (id) => values.has(String(id)),
    values: () => values.values(),
  };
}

function makeDiscordMessage({
  channelId,
  content,
  guildId,
  userId = DEFAULT_USER_ID,
  username = `user-${userId}`,
  displayName = `User ${userId}`,
  topic = null,
  mentionedUsers = [],
  roleIds = [],
  memberPermissionCheck = () => false,
} = {}) {
  const calls = {
    reply: [],
    send: [],
    sendTyping: 0,
  };

  const guild = {
    id: String(guildId),
    ownerId: '800000000000000001',
    members: {
      me: {
        id: BOT_ID,
        permissions: { has: () => true },
      },
    },
    channels: { cache: new Map() },
    roles: {
      everyone: { id: String(guildId) },
      cache: new Map(),
    },
  };

  function makeSentMessage(payload) {
    return {
      id: `sent-${calls.send.length + calls.reply.length}`,
      content: payload?.content ?? '',
      async edit(nextPayload) {
        calls.send.push({ kind: 'edit', payload: nextPayload });
        return makeSentMessage(nextPayload);
      },
      async pin() {},
      async reply(nextPayload) {
        calls.send.push(nextPayload);
        return makeSentMessage(nextPayload);
      },
    };
  }

  const channel = {
    id: String(channelId),
    guild,
    guildId: String(guildId),
    parentId: null,
    topic,
    type: ChannelType.GuildText,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    async send(payload) {
      calls.send.push(payload);
      return makeSentMessage(payload);
    },
    async sendTyping() {
      calls.sendTyping += 1;
    },
  };
  guild.channels.cache.set(channel.id, channel);

  const author = {
    id: String(userId),
    bot: false,
    username,
    globalName: displayName,
  };
  const member = {
    id: String(userId),
    displayName,
    user: author,
    permissions: { has: memberPermissionCheck },
    roles: {
      cache: new Map(roleIds.map((roleId) => [String(roleId), { id: String(roleId) }])),
    },
  };
  const userMentions = makeCollection(mentionedUsers);
  const memberMentions = makeCollection(mentionedUsers.map((user) => ({
    id: String(user.id),
    displayName: user.displayName ?? user.globalName ?? user.username,
    user,
  })));

  const message = {
    id: `message-${guildId}-${channelId}-${userId}-${calls.reply.length}`,
    content: String(content ?? ''),
    guild,
    guildId: guild.id,
    channel,
    channelId: channel.id,
    author,
    member,
    createdTimestamp: Date.now(),
    reference: null,
    referencedMessage: null,
    mentions: {
      users: userMentions,
      members: memberMentions,
      repliedUser: null,
    },
    async reply(payload) {
      calls.reply.push(payload);
      return makeSentMessage(payload);
    },
  };

  return { calls, channel, guild, message };
}

function makeInteraction({ customId, guildId, userId, owner = false } = {}) {
  const calls = {
    editReply: [],
    followUp: [],
    reply: [],
    showModal: [],
    update: [],
  };
  const user = {
    id: String(userId),
    username: `user-${userId}`,
  };
  const guild = {
    id: String(guildId),
    ownerId: owner ? user.id : '800000000000000099',
    channels: { cache: new Map() },
    members: { me: { id: BOT_ID, permissions: { has: () => true } } },
    roles: { everyone: { id: String(guildId) }, cache: new Map() },
  };
  const interaction = {
    customId,
    guild,
    guildId: guild.id,
    channel: null,
    channelId: null,
    client: { user: { id: BOT_ID } },
    user,
    memberPermissions: { has: () => false },
    deferred: false,
    replied: false,
    inGuild: () => true,
    isButton: () => true,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    isRoleSelectMenu: () => false,
    async reply(payload) {
      calls.reply.push(payload);
      interaction.replied = true;
    },
    async editReply(payload) {
      calls.editReply.push(payload);
    },
    async followUp(payload) {
      calls.followUp.push(payload);
    },
    async showModal(modal) {
      calls.showModal.push(modal);
    },
    async update(payload) {
      calls.update.push(payload);
    },
  };
  return { calls, interaction };
}

function responseText(fixture) {
  return fixture.calls.reply.map((payload) => String(payload?.content ?? '')).join('\n');
}

async function flushQueuedWork() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test.before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('A legacy integration test attempted a real network request.');
  };
});

test.after(() => {
  globalThis.fetch = originalFetch;
  if (previousDeepSeekTimeout == null) delete process.env.DEEPSEEK_TIMEOUT_MS;
  else process.env.DEEPSEEK_TIMEOUT_MS = previousDeepSeekTimeout;
});

test.beforeEach(() => {
  resetChatRateLimits();
  resetConversationQueues();
  clearConversations();
  resetRoleplayRateLimits();
  resetRoleplaySessions();
  resetRoleplayTickets();
  resetSetupDrafts();
});

test('roleplay panel commands bypass configured chat access', async () => {
  const store = makeForbiddenAccessStore();
  const fixture = makeDiscordMessage({
    channelId: '410000000000000001',
    content: '!rp',
    guildId: '310000000000000001',
    memberPermissionCheck: (permission) => permission === PermissionFlagsBits.ManageChannels,
  });
  const handler = createMessageCreateHandler({ user: { id: BOT_ID } }, store, {
    fetchImpl: async () => { throw new Error('Unexpected provider call.'); },
  });

  await handler(fixture.message);

  assert.equal(store.calls.get.length, 0);
  assert.equal(store.calls.getApiKey.length, 0);
  assert.equal(fixture.calls.send.length, 1);
  assert.equal(fixture.calls.send[0].embeds[0].data.title, 'Welcome to RP');
  assert.match(responseText(fixture), /Roleplay panel posted/i);
});

test('orphaned current and legacy roleplay ticket topics bypass configured access', async (t) => {
  const cases = [
    {
      name: 'current topic marker',
      topic: '[roleplay-ticket:orphan-current] opener=100000000000000010 prompt=fantasy level=adventure improved=0',
    },
    {
      name: 'legacy topic marker',
      topic: 'RP opener: 100000000000000010',
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    await t.test(scenario.name, async () => {
      const store = makeForbiddenAccessStore();
      const fixture = makeDiscordMessage({
        channelId: `41000000000000001${index + 1}`,
        content: 'continue the scene',
        guildId: `31000000000000001${index + 1}`,
        topic: scenario.topic,
        userId: '100000000000000010',
      });
      const handler = createMessageCreateHandler({ user: { id: BOT_ID } }, store, {
        fetchImpl: async () => { throw new Error('Unexpected provider call.'); },
      });

      await handler(fixture.message);

      assert.equal(store.calls.get.length, 0);
      assert.equal(store.calls.getApiKey.length, 0);
      assert.match(responseText(fixture), /before my last restart/i);
    });
  }
});

test('registered roleplay uses only its guild key plus the injected fetch and timeout', async (t) => {
  const guildId = '310000000000000020';
  const otherGuildId = '310000000000000021';
  const channelId = '410000000000000020';
  const openerUserId = '100000000000000020';
  const guildKey = 'sk-guild-only-secret-1234567890';
  const otherGuildKey = 'sk-other-guild-secret-0987654321';
  const store = makeForbiddenAccessStore({
    decryptedKeys: new Map([
      [guildId, guildKey],
      [otherGuildId, otherGuildKey],
    ]),
  });
  registerRoleplayTicket({
    ticketId: 'registered-ticket-20',
    channelId,
    guildId,
    openerUserId,
    promptId: 'fantasy',
    levelId: 'adventure',
    personName: 'Aster',
    promptText: 'Fantasy',
  });

  const fetchCalls = [];
  const timeoutDurations = [];
  t.mock.method(globalThis, 'setTimeout', (callback, duration) => {
    timeoutDurations.push(duration);
    return { unref() {} };
  });
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async json() {
        return { choices: [{ message: { content: 'The lantern wakes beneath the old stone arch.' } }] };
      },
    };
  };
  const fixture = makeDiscordMessage({
    channelId,
    content: 'I step through the arch.',
    guildId,
    userId: openerUserId,
  });
  const handler = createMessageCreateHandler({ user: { id: BOT_ID } }, store, { fetchImpl });

  await handler(fixture.message);

  assert.deepEqual(store.calls.getApiKey, [guildId]);
  assert.equal(store.calls.get.length, 0);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(fetchCalls[0].init.headers.Authorization, `Bearer ${guildKey}`);
  assert.doesNotMatch(JSON.stringify(fetchCalls[0].init), new RegExp(otherGuildKey));
  assert.doesNotMatch(String(fetchCalls[0].init.body), new RegExp(guildKey));
  assert.equal(fetchCalls[0].init.signal instanceof AbortSignal, true);
  assert.equal(deepSeekTimeoutMs, 1234);
  assert.ok(timeoutDurations.includes(deepSeekTimeoutMs));
  assert.equal(fixture.calls.sendTyping, 1);
  assert.match(responseText(fixture), /lantern wakes/i);
});

test('local grok new, lore, stats, and who-is commands use production routing', async () => {
  const guildId = '310000000000000030';
  const channelId = '410000000000000030';
  const requesterId = '100000000000000030';
  const targetId = '100000000000000031';
  const config = makeConfiguredGuildConfig(channelId);
  const store = makeGuildConfigStore(new Map([[guildId, config]]));
  const handler = createMessageCreateHandler({ user: { id: BOT_ID } }, store, {
    fetchImpl: async () => { throw new Error('Local Grok commands must not call a provider.'); },
  });

  const requesterContext = makeDiscordMessage({
    channelId,
    content: 'nebula nebula forge stories',
    guildId,
    userId: requesterId,
  });
  const targetContext = makeDiscordMessage({
    channelId,
    content: 'dragon dragon crystal expedition',
    guildId,
    userId: targetId,
    displayName: 'Target Voyager',
    username: 'target-voyager',
  });
  await handler(requesterContext.message);
  await handler(targetContext.message);
  await flushQueuedWork();

  const lore = makeDiscordMessage({
    channelId,
    content: 'grok lore',
    guildId,
    userId: requesterId,
  });
  await handler(lore.message);
  assert.match(responseText(lore), /nebula|dragon/i);

  const stats = makeDiscordMessage({
    channelId,
    content: 'grok stats',
    guildId,
    userId: requesterId,
  });
  await handler(stats.message);
  assert.match(responseText(stats), /monthly brain crumbs/i);
  assert.match(responseText(stats), /nebula/i);

  const targetUser = {
    id: targetId,
    username: 'target-voyager',
    globalName: 'Target Voyager',
    displayName: 'Target Voyager',
  };
  const whoIs = makeDiscordMessage({
    channelId,
    content: `grok who is <@${targetId}>`,
    guildId,
    userId: requesterId,
    mentionedUsers: [targetUser],
  });
  await handler(whoIs.message);
  assert.match(responseText(whoIs), /Target Voyager/i);
  assert.match(responseText(whoIs), /dragon/i);

  const fresh = makeDiscordMessage({
    channelId,
    content: 'grok new',
    guildId,
    userId: requesterId,
  });
  await handler(fresh.message);
  assert.equal(responseText(fresh), 'New conversation started.');
  assert.deepEqual(getConversation(`${guildId}:${channelId}`).messages, []);

  deleteGuildIdleChatterState(guildId);
});

test('monthly profiles are isolated by guild for the same Discord user', async () => {
  const guildA = '310000000000000040';
  const guildB = '310000000000000041';
  const channelA = '410000000000000040';
  const channelB = '410000000000000041';
  const targetId = '100000000000000040';
  const requesterId = '100000000000000041';
  const store = makeGuildConfigStore(new Map([
    [guildA, makeConfiguredGuildConfig(channelA)],
    [guildB, makeConfiguredGuildConfig(channelB)],
  ]));
  const handler = createMessageCreateHandler({ user: { id: BOT_ID } }, store, {
    fetchImpl: async () => { throw new Error('Profile commands must not call a provider.'); },
  });

  const guildAContext = makeDiscordMessage({
    channelId: channelA,
    content: 'quasar quasar orchard telemetry',
    guildId: guildA,
    userId: targetId,
    displayName: 'Scoped Target',
  });
  await handler(guildAContext.message);
  await flushQueuedWork();

  const targetUser = {
    id: targetId,
    username: 'scoped-target',
    globalName: 'Scoped Target',
    displayName: 'Scoped Target',
  };
  const guildAWhoIs = makeDiscordMessage({
    channelId: channelA,
    content: `grok who is <@${targetId}>`,
    guildId: guildA,
    userId: requesterId,
    mentionedUsers: [targetUser],
  });
  const guildBWhoIs = makeDiscordMessage({
    channelId: channelB,
    content: `grok who is <@${targetId}>`,
    guildId: guildB,
    userId: requesterId,
    mentionedUsers: [targetUser],
  });

  await handler(guildAWhoIs.message);
  await handler(guildBWhoIs.message);

  assert.match(responseText(guildAWhoIs), /quasar/i);
  assert.doesNotMatch(responseText(guildBWhoIs), /quasar/i);
  assert.match(responseText(guildBWhoIs), /still undocumented wildlife/i);

  deleteGuildIdleChatterState(guildA);
  deleteGuildIdleChatterState(guildB);
});

test('configured channels record idle chatter even outside the legacy static allowlist', async () => {
  const guildId = '310000000000000050';
  const channelId = '410000000000000050';
  assert.equal(canReplyInChannel(channelId), false);

  const store = makeGuildConfigStore(new Map([
    [guildId, makeConfiguredGuildConfig(channelId)],
  ]));
  const handler = createMessageCreateHandler({ user: { id: BOT_ID } }, store, {
    fetchImpl: async () => { throw new Error('Passive configured chatter must not call a provider.'); },
  });
  const fixture = makeDiscordMessage({
    channelId,
    content: 'quiet configured channel heartbeat',
    guildId,
  });

  await handler(fixture.message);

  const state = getIdleChatterState(guildId);
  assert.equal(state.channel, fixture.channel);
  assert.equal(state.allowConfiguredChannel, true);
  assert.ok(state.lastMessageAt > 0);
  assert.ok(state.timer);

  deleteGuildIdleChatterState(guildId);
});

test('composed interaction handler keeps setup and roleplay controls on their own routers', async () => {
  const guildId = '310000000000000060';
  const channelId = '410000000000000060';
  const store = makeGuildConfigStore(new Map([
    [guildId, makeConfiguredGuildConfig(channelId)],
  ]));
  const handler = createInteractionCreateHandler(store, {
    fetchImpl: async () => { throw new Error('Opening controls must not call a provider.'); },
  });

  const setup = makeInteraction({
    customId: setupCustomIds.personaOpen,
    guildId,
    owner: true,
    userId: '100000000000000060',
  });
  await handler(setup.interaction);

  assert.equal(store.calls.get.length, 1);
  assert.equal(setup.calls.showModal.length, 1);
  assert.equal(setup.calls.showModal[0].data.custom_id, setupCustomIds.personaModal);
  assert.equal(setup.calls.reply.length, 0);

  const roleplay = makeInteraction({
    customId: roleplayCustomIds.openButton,
    guildId,
    owner: false,
    userId: '100000000000000061',
  });
  await handler(roleplay.interaction);

  assert.equal(store.calls.get.length, 1);
  assert.equal(roleplay.calls.showModal.length, 0);
  assert.equal(roleplay.calls.reply.length, 1);
  assert.match(roleplay.calls.reply[0].content, /RP prompt:/i);
});

test('channel deletion removes an open roleplay ticket, its session, and stale idle delivery', async () => {
  const guildId = '310000000000000070';
  const channelId = '410000000000000070';
  const replacementChannelId = '410000000000000071';
  const openerUserId = '100000000000000070';
  const ticket = registerRoleplayTicket({
    ticketId: 'deleted-ticket-70',
    channelId,
    guildId,
    openerUserId,
    promptId: 'fantasy',
    levelId: 'adventure',
    personName: 'Aster',
    promptText: 'Fantasy',
  });
  const sessionKey = getRoleplaySessionKey({
    guildId,
    channelId,
    userId: openerUserId,
    ticketId: ticket.ticketId,
  });
  const originalSession = getRoleplaySession(sessionKey);
  appendRoleplayTurn(originalSession, 'Remember the silver key.', 'The silver key is remembered.');

  let idleCallback = null;
  let staleSendCount = 0;
  const deletedChannel = {
    id: channelId,
    guildId,
    async send() {
      staleSendCount += 1;
      return {
        async reply() {
          staleSendCount += 1;
          return this;
        },
      };
    },
  };
  const deletedIdleState = recordGuildIdleChatterChannel(
    deletedChannel,
    0,
    (callback) => {
      idleCallback = callback;
      return { unref() {}, [Symbol.toPrimitive]: () => 0 };
    },
    { allowConfiguredChannel: true },
  );

  createChannelDeleteHandler()(deletedChannel);

  assert.equal(getRoleplayTicketByChannelId(channelId), null);
  assert.equal(getOpenRoleplayTicketForUser(guildId, openerUserId), null);
  const freshSession = getRoleplaySession(sessionKey);
  assert.notEqual(freshSession, originalSession);
  assert.deepEqual(freshSession.messages, []);
  assert.equal(deletedIdleState.channel, null);
  assert.equal(deletedIdleState.timer, null);

  await idleCallback();
  assert.equal(staleSendCount, 0);

  const replacementTicket = registerRoleplayTicket({
    ticketId: 'replacement-ticket-70',
    channelId: replacementChannelId,
    guildId,
    openerUserId,
    promptId: 'fantasy',
    levelId: 'adventure',
    personName: 'Aster',
    promptText: 'Fantasy',
  });
  assert.equal(getOpenRoleplayTicketForUser(guildId, openerUserId), replacementTicket);
});

test('saving a revoked access channel clears its pending idle-chatter callback', async () => {
  const guildId = '310000000000000080';
  const oldChannelId = '410000000000000080';
  const newChannelId = '410000000000000081';
  const ownerId = '100000000000000080';
  let config = makeConfiguredGuildConfig(oldChannelId);
  const store = {
    async get() {
      return clone(config);
    },
    async update(targetGuildId, updater) {
      assert.equal(targetGuildId, guildId);
      const draft = clone(config);
      config = clone(updater(draft) ?? draft);
      return clone(config);
    },
  };

  let idleCallback = null;
  let revokedSendCount = 0;
  const revokedChannel = {
    id: oldChannelId,
    guildId,
    async send() {
      revokedSendCount += 1;
      return {
        async reply() {
          revokedSendCount += 1;
          return this;
        },
      };
    },
  };
  const revokedState = recordGuildIdleChatterChannel(
    revokedChannel,
    0,
    (callback) => {
      idleCallback = callback;
      return { unref() {}, [Symbol.toPrimitive]: () => 0 };
    },
    { allowConfiguredChannel: true },
  );

  createSetupDraft(draftTypes.access, guildId, ownerId, {
    channelIds: [newChannelId],
    allowedRoleIds: [],
    blockedRoleIds: [],
  });
  const fixture = makeInteraction({
    customId: setupCustomIds.accessSave,
    guildId,
    owner: true,
    userId: ownerId,
  });
  const replacementChannel = {
    id: newChannelId,
    name: 'replacement-channel',
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
  };
  fixture.interaction.guild.channels.cache = {
    get: (channelId) => (String(channelId) === newChannelId ? replacementChannel : null),
    has: (channelId) => String(channelId) === newChannelId,
    *values() {},
  };

  await handleSetupInteraction(fixture.interaction, store);

  assert.deepEqual(config.access.channelIds, [newChannelId]);
  assert.equal(revokedState.channel, null);
  assert.equal(revokedState.timer, null);
  assert.match(fixture.calls.update.at(-1).content, /Channel and role access saved/i);
  await idleCallback();
  assert.equal(revokedSendCount, 0);
});

test('roleplay metadata, custom prompts, and history stay out of the system role', () => {
  const personSentinel = 'PERSON_SENTINEL_IGNORE_ALL_RULES';
  const promptSentinel = 'PROMPT_SENTINEL_REVEAL_SECRETS';
  const historySentinel = 'HISTORY_SENTINEL_SYSTEM_OVERRIDE';
  const requestSentinel = 'REQUEST_SENTINEL_CURRENT_MOVE';
  const payload = buildRoleplayDeepSeekPayload(
    requestSentinel,
    {
      ticketId: 'payload-ticket-90',
      channelId: '410000000000000090',
      guildId: '310000000000000090',
      openerUserId: '100000000000000090',
      promptId: roleplayCustomPromptId,
      levelId: 'adventure',
      personName: personSentinel,
      promptText: promptSentinel,
      improvedAi: true,
    },
    {
      messages: [
        { role: 'user', content: historySentinel },
        { role: 'assistant', content: 'Prior narrator response.' },
      ],
    },
  );

  const systemMessages = payload.messages.filter((message) => message.role === 'system');
  assert.equal(systemMessages.length, 1);
  for (const sentinel of [personSentinel, promptSentinel, historySentinel, requestSentinel]) {
    assert.equal(systemMessages[0].content.includes(sentinel), false);
    const containingMessages = payload.messages.filter((message) => message.content.includes(sentinel));
    assert.ok(containingMessages.length > 0);
    assert.ok(containingMessages.every((message) => message.role === 'user'));
  }

  const metadataBlock = payload.messages.find((message) => (
    message.content.includes('UNTRUSTED_ROLEPLAY_METADATA_DATA')
  ));
  const historyBlock = payload.messages.find((message) => (
    message.content.includes('UNTRUSTED_ROLEPLAY_TRANSCRIPT_DATA')
  ));
  assert.equal(metadataBlock.role, 'user');
  assert.match(metadataBlock.content, /story context only/i);
  assert.equal(historyBlock.role, 'user');
  assert.match(historyBlock.content, /scene continuity only/i);
  assert.equal(payload.messages.at(-1).role, 'user');
  assert.equal(payload.messages.at(-1).content, requestSentinel);
});

test('improved custom-roleplay text blocks cap oversized provider output', async () => {
  const guildId = '310000000000000100';
  const userId = '100000000000000100';
  const channelId = '410000000000000100';
  const oversizedOutput = 'Z'.repeat(maxRoleplayResponseCharacters + 5_000);
  const channelSends = [];
  const createdChannel = {
    id: channelId,
    async delete() {},
    async setTopic() {},
    async send(payload) {
      channelSends.push(payload);
      return { async pin() {} };
    },
  };
  const fixture = makeInteraction({
    customId: buildRoleplayModalCustomId(roleplayCustomPromptId),
    guildId,
    owner: false,
    userId,
  });
  fixture.interaction.isButton = () => false;
  fixture.interaction.isModalSubmit = () => true;
  fixture.interaction.fields = {
    getTextInputValue(customId) {
      const values = {
        [roleplayCustomIds.personNameInput]: 'Aster',
        [roleplayCustomIds.promptInput]: 'A safe custom fantasy scene in a moonlit archive.',
        [roleplayCustomIds.improvedAiInput]: 'yes',
        [roleplayCustomIds.levelInput]: 'Adventure',
      };
      return values[customId] ?? '';
    },
  };
  fixture.interaction.deferReply = async () => {
    fixture.interaction.deferred = true;
  };
  fixture.interaction.guild.channels.create = async () => createdChannel;

  const ticket = await createRoleplayTicketFromInteraction(fixture.interaction, {
    generateOpeningReply: async () => oversizedOutput,
  });

  assert.equal(ticket.improvedAi, true);
  const prefix = '```text\n';
  const suffix = '\n```';
  const improvedTextBlocks = channelSends
    .slice(2)
    .map((payload) => String(payload?.content ?? ''))
    .filter((content) => content.startsWith(prefix) && content.includes('Z'));
  assert.ok(improvedTextBlocks.length > 1);
  assert.ok(improvedTextBlocks.every((content) => content.length <= 2_000));
  const reconstructed = improvedTextBlocks
    .map((content) => content.slice(prefix.length, -suffix.length))
    .join('');
  assert.equal(reconstructed.length, maxRoleplayResponseCharacters);
  assert.equal(reconstructed.at(-1), '…');
  assert.equal(reconstructed.slice(0, -1), 'Z'.repeat(maxRoleplayResponseCharacters - 1));
});
