'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');

const { resetChatRateLimits } = require('../src/chat/rateLimit');
const { clearConversations } = require('../src/state/conversations');
const { resetFunmuteCooldown } = require('../src/commands/funmute');
const { handleFunmuteCommand } = require('../src/events/legacyCommands');
const {
  clearProviderKeyIfCurrent,
  createMessageCreateHandler,
  updateProviderState,
} = require('../src/events/messageCreate');
const {
  DeepSeekApiError,
  NO_BALANCE_MESSAGE,
} = require('../src/services/deepseek');
const { createDefaultGuildConfig } = require('../src/storage/guildConfigStore');

const BOT_ID = 'bot-1';
const CHANNEL_ID = 'channel-1';
const VALID_ENCRYPTED_KEY = 'v1.YQ==.Yg==.Yw==';
const TEST_API_KEY = `sk-${'K'.repeat(32)}`;

function clone(value) {
  return structuredClone(value);
}

function configuredGuildConfig() {
  const config = createDefaultGuildConfig();
  config.persona = {
    ...config.persona,
    characterName: 'Nova',
    behavior: 'Helpful, candid, playful, accurate, and concise in every server conversation. '.repeat(2),
    triggerWord: 'AI',
    profanity: 'casual',
    textStyle: 'normal',
    responseFormat: 'text',
  };
  config.access = {
    channelIds: [CHANNEL_ID],
    allowedRoleIds: [],
    blockedRoleIds: [],
  };
  config.provider = {
    ...config.provider,
    encryptedKey: VALID_ENCRYPTED_KEY,
    keyStatus: 'valid',
  };
  config.advanced = {
    ...config.advanced,
    webSearchMode: 'off',
    cooldownSeconds: 0,
  };
  return config;
}

function makeStore(initialConfig, apiKey = TEST_API_KEY) {
  let config = clone(initialConfig);
  const calls = {
    get: 0,
    getApiKey: 0,
    update: [],
    clearApiKey: 0,
  };

  return {
    calls,
    inspect: () => clone(config),
    async get() {
      calls.get += 1;
      return clone(config);
    },
    async getApiKey() {
      calls.getApiKey += 1;
      return apiKey;
    },
    async update(guildId, updater, updatedBy) {
      const draft = clone(config);
      const result = typeof updater === 'function' ? updater(draft) : { ...draft, ...updater };
      config = clone(result === undefined ? draft : result);
      calls.update.push({ guildId, updatedBy });
      return clone(config);
    },
    async clearApiKey() {
      calls.clearApiKey += 1;
      config.provider = {
        ...config.provider,
        encryptedKey: null,
        keyStatus: 'unchecked',
      };
      return clone(config);
    },
  };
}

function makeMessage({
  content = 'AI hello',
  guildId = 'guild-1',
  userId = 'user-1',
  roleIds = [],
  reference = null,
  referencedMessage = null,
  repliedUserId = referencedMessage?.author?.id ?? null,
} = {}) {
  const calls = {
    reply: [],
    send: [],
    sendTyping: 0,
    fetchReference: 0,
  };
  const channel = {
    id: CHANNEL_ID,
    permissionsFor: () => ({ has: () => true }),
    isThread: () => false,
    async sendTyping() {
      calls.sendTyping += 1;
    },
    async send(payload) {
      calls.send.push(payload);
      return payload;
    },
  };
  const guild = {
    id: guildId,
    ownerId: 'owner-1',
    systemChannel: null,
    members: { me: { id: BOT_ID } },
    channels: { cache: new Map() },
  };
  const message = {
    content,
    guild,
    guildId,
    channel,
    channelId: CHANNEL_ID,
    author: {
      id: userId,
      bot: false,
      username: `user-${userId}`,
      globalName: `User ${userId}`,
    },
    member: {
      displayName: `User ${userId}`,
      roles: { cache: new Map(roleIds.map((id) => [id, { id }])) },
      permissions: { has: () => false },
    },
    mentions: {
      users: { has: (id) => id === BOT_ID && /<@!?bot-1>/.test(content) },
      members: { first: () => null },
      repliedUser: repliedUserId == null ? null : { id: repliedUserId },
    },
    reference,
    async fetchReference() {
      calls.fetchReference += 1;
      return referencedMessage;
    },
    async reply(payload) {
      calls.reply.push(payload);
      return payload;
    },
  };
  return { message, calls };
}

function makeNoNetworkFetch(counter) {
  return async function noNetworkFetch() {
    counter.count += 1;
    throw new Error('A test attempted a real provider path.');
  };
}

test.beforeEach(() => {
  resetChatRateLimits();
  resetFunmuteCooldown();
  clearConversations();
});

test('channel and blocked-role denial happen before reply fetch, key access, generation, typing, or fetch', async (t) => {
  const cases = [
    {
      name: 'empty channel allowlist defaults to deny',
      configure(config) {
        config.access.channelIds = [];
        return [];
      },
    },
    {
      name: 'blocked role overrides otherwise allowed access',
      configure(config) {
        config.access.blockedRoleIds = ['blocked-role'];
        return ['blocked-role'];
      },
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    await t.test(scenario.name, async () => {
      resetChatRateLimits();
      clearConversations();
      const config = configuredGuildConfig();
      const roleIds = scenario.configure(config);
      const store = makeStore(config);
      const network = { count: 0 };
      let generateCalls = 0;
      const generateChatResponse = async () => {
        generateCalls += 1;
        return 'must not run';
      };
      const { message, calls } = makeMessage({
        guildId: `guild-denied-${index}`,
        userId: `user-denied-${index}`,
        roleIds,
        reference: { messageId: 'referenced-1' },
        referencedMessage: { author: { id: BOT_ID }, content: 'previous answer' },
      });
      const handler = createMessageCreateHandler(
        { user: { id: BOT_ID } },
        store,
        { generateChatResponse, fetchImpl: makeNoNetworkFetch(network) },
      );

      await handler(message);

      assert.equal(store.calls.get, 1);
      assert.equal(store.calls.getApiKey, 0);
      assert.equal(calls.fetchReference, 0);
      assert.equal(calls.sendTyping, 0);
      assert.equal(calls.reply.length, 0);
      assert.equal(generateCalls, 0);
      assert.equal(network.count, 0);
    });
  }
});

test('wake word, mention, and reply-to-bot each trigger the configured generation path', async (t) => {
  const cases = [
    {
      name: 'wake word',
      content: 'AI explain this',
      expectedRequest: 'explain this',
    },
    {
      name: 'bot mention',
      content: '<@bot-1> explain this',
      expectedRequest: 'explain this',
    },
    {
      name: 'reply to bot',
      content: 'explain this',
      expectedRequest: 'explain this',
      reference: { messageId: 'bot-reply-1' },
      referencedMessage: { author: { id: BOT_ID }, content: 'Earlier bot answer' },
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    await t.test(scenario.name, async () => {
      resetChatRateLimits();
      clearConversations();
      const store = makeStore(configuredGuildConfig());
      const network = { count: 0 };
      const generated = [];
      const generateChatResponse = async (options) => {
        generated.push(options);
        return `answer-${index}`;
      };
      const { message, calls } = makeMessage({
        content: scenario.content,
        guildId: `guild-trigger-${index}`,
        userId: `user-trigger-${index}`,
        reference: scenario.reference,
        referencedMessage: scenario.referencedMessage,
      });
      const handler = createMessageCreateHandler(
        { user: { id: BOT_ID } },
        store,
        { generateChatResponse, fetchImpl: makeNoNetworkFetch(network) },
      );

      await handler(message);

      assert.equal(generated.length, 1);
      assert.equal(generated[0].currentMessage, scenario.expectedRequest);
      if (scenario.reference) assert.equal(calls.fetchReference, 0);
      assert.equal(calls.reply.length, 1);
      assert.equal(calls.reply[0].content, `answer-${index}`);
      assert.equal(network.count, 0);
    });
  }
});

test('zero-context replies fetch and quote the referenced bot message once', async () => {
  const config = configuredGuildConfig();
  config.advanced.contextMessages = 0;
  const store = makeStore(config);
  const generated = [];
  const { message, calls } = makeMessage({
    content: 'explain this',
    guildId: 'guild-zero-context',
    userId: 'user-zero-context',
    reference: { messageId: 'bot-reply-zero' },
    referencedMessage: { author: { id: BOT_ID }, content: 'Earlier bot answer' },
  });
  const handler = createMessageCreateHandler(
    { user: { id: BOT_ID } },
    store,
    { generateChatResponse: async (options) => { generated.push(options); return 'answer'; } },
  );

  await handler(message);

  assert.equal(calls.fetchReference, 1);
  assert.match(generated[0].currentMessage, /UNTRUSTED REFERENCED BOT MESSAGE/);
  assert.match(generated[0].currentMessage, /Earlier bot answer/);
  assert.match(generated[0].currentMessage, /Current request: explain this/);
});

test('ordinary replies use gateway author metadata and avoid reference REST fetches', async () => {
  const store = makeStore(configuredGuildConfig());
  let generateCalls = 0;
  const { message, calls } = makeMessage({
    content: 'conversation between users',
    guildId: 'guild-ordinary-reply',
    reference: { messageId: 'user-reply-1' },
    referencedMessage: { author: { id: 'other-user' }, content: 'hello' },
  });
  const handler = createMessageCreateHandler(
    { user: { id: BOT_ID } },
    store,
    { generateChatResponse: async () => { generateCalls += 1; return 'unused'; } },
  );

  await handler(message);

  assert.equal(calls.fetchReference, 0);
  assert.equal(generateCalls, 0);
  assert.equal(calls.reply.length, 0);
});

test('typing feedback never blocks provider generation', async () => {
  const store = makeStore(configuredGuildConfig());
  let generationStarted = false;
  const { message, calls } = makeMessage({ guildId: 'guild-typing' });
  message.channel.sendTyping = () => {
    calls.sendTyping += 1;
    return new Promise(() => {});
  };
  const handler = createMessageCreateHandler(
    { user: { id: BOT_ID } },
    store,
    { generateChatResponse: async () => { generationStarted = true; return 'fast answer'; } },
  );

  await handler(message);

  assert.equal(calls.sendTyping, 1);
  assert.equal(generationStarted, true);
  assert.equal(calls.reply[0].content, 'fast answer');
});

test('stateless legacy commands do not allocate conversation state', async () => {
  const store = makeStore(configuredGuildConfig());
  const { message, calls } = makeMessage({ content: '!ping', guildId: 'guild-ping' });
  const handler = createMessageCreateHandler({ user: { id: BOT_ID } }, store);

  await handler(message);

  assert.equal(calls.reply[0].content, 'Pong!');
  assert.equal(clearConversations(), 0);
});

test('bot help shows the configured trigger while grok help keeps legacy UI', async () => {
  const store = makeStore(configuredGuildConfig());
  const botHelp = makeMessage({ content: '!bot help', guildId: 'guild-bot-help' });
  const grokHelp = makeMessage({ content: '!grok help', guildId: 'guild-grok-help' });
  const handler = createMessageCreateHandler({ user: { id: BOT_ID } }, store);

  await handler(botHelp.message);
  await handler(grokHelp.message);

  assert.match(botHelp.calls.reply[0].content, /`AI <message>`/);
  assert.match(botHelp.calls.reply[0].content, /`!bot help`/);
  assert.match(grokHelp.calls.reply[0].content, /Grok command menu/);
  assert.match(grokHelp.calls.reply[0].content, /`!grok help`/);
});

test('configured web search receives the guild scope and reaches the injected provider', async (t) => {
  const previousEnabled = process.env.WEB_SEARCH_ENABLED;
  const previousKey = process.env.WEB_SEARCH_API_KEY;
  process.env.WEB_SEARCH_ENABLED = 'true';
  process.env.WEB_SEARCH_API_KEY = 'test-search-key';
  t.after(() => {
    if (previousEnabled == null) delete process.env.WEB_SEARCH_ENABLED;
    else process.env.WEB_SEARCH_ENABLED = previousEnabled;
    if (previousKey == null) delete process.env.WEB_SEARCH_API_KEY;
    else process.env.WEB_SEARCH_API_KEY = previousKey;
  });

  const config = configuredGuildConfig();
  config.advanced.webSearchMode = 'on_request';
  const store = makeStore(config);
  let searchCalls = 0;
  const generated = [];
  const fetchImpl = async () => {
    searchCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        web: { results: [{ title: 'Source', url: 'https://example.com/', description: 'Fresh result' }] },
      }),
    };
  };
  const { message } = makeMessage({
    content: 'AI search the web for a fresh result',
    guildId: 'guild-web-search',
  });
  const handler = createMessageCreateHandler(
    { user: { id: BOT_ID } },
    store,
    {
      fetchImpl,
      generateChatResponse: async (options) => { generated.push(options); return 'searched'; },
    },
  );

  await handler(message);

  assert.equal(searchCalls, 1);
  assert.match(generated[0].webSearchContext, /Fresh result/);
});

test('triggered messages in an incomplete setup receive setup guidance without key access or generation', async () => {
  const config = createDefaultGuildConfig();
  config.access.channelIds = [CHANNEL_ID];
  const store = makeStore(config);
  const network = { count: 0 };
  let generateCalls = 0;
  const { message, calls } = makeMessage({ guildId: 'guild-incomplete', userId: 'user-incomplete' });
  const handler = createMessageCreateHandler(
    { user: { id: BOT_ID } },
    store,
    {
      generateChatResponse: async () => {
        generateCalls += 1;
        return 'must not run';
      },
      fetchImpl: makeNoNetworkFetch(network),
    },
  );

  await handler(message);

  assert.equal(calls.reply.length, 1);
  assert.equal(
    calls.reply[0].content,
    'This server has not finished the required bot setup yet. An owner or administrator can use `!setup`.',
  );
  assert.equal(store.calls.getApiKey, 0);
  assert.equal(calls.sendTyping, 0);
  assert.equal(generateCalls, 0);
  assert.equal(network.count, 0);
});

test('a configured server reads its stored key, calls the injected generator, and renders the response', async () => {
  const store = makeStore(configuredGuildConfig());
  const network = { count: 0 };
  const generated = [];
  const { message, calls } = makeMessage({
    content: 'AI give me a concise answer',
    guildId: 'guild-configured',
    userId: 'user-configured',
  });
  const handler = createMessageCreateHandler(
    { user: { id: BOT_ID } },
    store,
    {
      generateChatResponse: async (options) => {
        generated.push(options);
        return 'Configured answer';
      },
      fetchImpl: makeNoNetworkFetch(network),
    },
  );

  await handler(message);

  assert.equal(store.calls.getApiKey, 1);
  assert.equal(generated.length, 1);
  assert.equal(generated[0].apiKey, TEST_API_KEY);
  assert.equal(generated[0].currentMessage, 'give me a concise answer');
  assert.equal(calls.sendTyping, 1);
  assert.equal(calls.reply.length, 1);
  assert.equal(calls.reply[0].content, 'Configured answer');
  assert.deepEqual(calls.reply[0].allowedMentions.parse, []);
  assert.equal(network.count, 0);
});

test('a 402 returns the exact provider-neutral balance message and updates setup status', async (t) => {
  t.mock.method(console, 'error', () => {});
  const store = makeStore(configuredGuildConfig());
  const network = { count: 0 };
  const { message, calls } = makeMessage({
    content: 'AI are you there?',
    guildId: 'guild-no-balance',
    userId: 'user-no-balance',
  });
  const handler = createMessageCreateHandler(
    { user: { id: BOT_ID } },
    store,
    {
      generateChatResponse: async () => {
        throw new DeepSeekApiError(402);
      },
      fetchImpl: makeNoNetworkFetch(network),
    },
  );

  await handler(message);

  assert.equal(NO_BALANCE_MESSAGE, 'My bot has no balance. Please add your balance to the API console.');
  assert.equal(calls.reply.length, 1);
  assert.equal(calls.reply[0].content, NO_BALANCE_MESSAGE);
  assert.doesNotMatch(calls.reply[0].content, /deepseek/i);
  assert.equal(store.inspect().provider.keyStatus, 'no_balance');
  assert.ok(Date.parse(store.inspect().provider.checkedAt));
  assert.equal(store.calls.update.length, 1);
  assert.equal(store.calls.clearApiKey, 0);
  assert.equal(network.count, 0);
});

test('an old in-flight request cannot mutate a newly replaced API key', async () => {
  const config = configuredGuildConfig();
  config.provider.fingerprint = 'sha256:new-key';
  const store = makeStore(config, `sk-${'N'.repeat(32)}`);

  assert.equal(await updateProviderState(store, 'guild-race', 'no_balance', 'sha256:old-key'), false);
  assert.equal(await clearProviderKeyIfCurrent(store, 'guild-race', 'sha256:old-key'), false);
  assert.equal(store.inspect().provider.fingerprint, 'sha256:new-key');
  assert.equal(store.inspect().provider.keyStatus, 'valid');
  assert.ok(store.inspect().provider.encryptedKey);
});

test('funmute starts Discord moderation immediately and edits concurrent progress feedback', async () => {
  let resolveTimeout;
  let timeoutCalls = 0;
  const edits = [];
  const replies = [];
  const timeoutFinished = new Promise((resolve) => { resolveTimeout = resolve; });
  const targetRole = { id: 'target-role' };
  const targetMember = {
    id: 'target-user',
    guild: { id: 'guild-funmute' },
    user: { tag: 'Target#0001', bot: false },
    roles: { highest: targetRole },
    moderatable: true,
    timeout() {
      timeoutCalls += 1;
      return timeoutFinished;
    },
  };
  const requesterMember = {
    id: 'requester-user',
    user: { tag: 'Admin#0001' },
    permissions: { has: (permission) => permission === PermissionFlagsBits.ModerateMembers },
    roles: { highest: { comparePositionTo: () => 1 } },
  };
  const botMember = {
    permissions: { has: (permission) => permission === PermissionFlagsBits.ModerateMembers },
    roles: { highest: { comparePositionTo: () => 1 } },
  };
  const progressMessage = {
    async edit(payload) {
      edits.push(payload);
      return this;
    },
  };
  const message = {
    content: '!funmute <@target-user> 3',
    guildId: 'guild-funmute',
    guild: { id: 'guild-funmute', ownerId: 'owner-user', members: { me: botMember } },
    member: requesterMember,
    mentions: { members: { first: () => targetMember } },
    async reply(payload) {
      replies.push(payload);
      return progressMessage;
    },
  };

  const pending = handleFunmuteCommand(message, configuredGuildConfig());

  assert.equal(timeoutCalls, 1);
  assert.match(replies[0].content, /⏳/u);
  assert.equal(edits.length, 0);

  resolveTimeout();
  await pending;

  assert.equal(edits.length, 1);
  assert.match(edits[0].content, /Bonk\. Target#0001 is timed out for 3 second/);
  assert.deepEqual(edits[0].allowedMentions.parse, []);
});
