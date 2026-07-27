const assert = require('node:assert/strict');
const test = require('node:test');
const { Events, PermissionFlagsBits } = require('discord.js');
const { wireBotEvents } = require('../src/events/bot');
const {
  createGuildCreateHandler,
  createReadyHandler,
  ensureGuildSetupPanel,
  findSetupChannel,
} = require('../src/events/ready');

function createChannel(id, writable = true) {
  const sent = [];
  return {
    id,
    sent,
    isTextBased: () => true,
    permissionsFor: () => ({
      has: (flag) => writable && (flag === PermissionFlagsBits.ViewChannel || flag === PermissionFlagsBits.SendMessages),
    }),
    send: async (payload) => {
      sent.push(payload);
      return { id: `${id}01` };
    },
  };
}

function createGuild(overrides = {}) {
  const fallback = createChannel('3002');
  return {
    id: '1001',
    members: { me: { id: 'bot' } },
    systemChannel: createChannel('3001'),
    channels: { cache: new Map([[fallback.id, fallback]]) },
    ...overrides,
  };
}

test('ready posts and persists one setup panel for an unconfigured guild', async () => {
  const calls = [];
  const service = {
    getStatus: async () => ({
      configured: false,
      onboardingPanel: { channelId: null, messageId: null },
    }),
    setOnboardingPanel: async (...args) => calls.push(args),
  };
  const guild = createGuild();

  const message = await ensureGuildSetupPanel(guild, service);
  assert.equal(message.id, '300101');
  assert.equal(guild.systemChannel.sent.length, 1);
  assert.match(guild.systemChannel.sent[0].content, /setup is required/i);
  assert.deepEqual(calls, [['1001', '3001', '300101']]);
});

test('persisted panel metadata suppresses duplicate ready-time posts', async () => {
  const service = {
    getStatus: async () => ({
      configured: false,
      onboardingPanel: { channelId: '3001', messageId: '7001' },
    }),
    setOnboardingPanel: async () => assert.fail('must not rewrite panel metadata'),
  };
  const guild = createGuild();

  assert.equal(await ensureGuildSetupPanel(guild, service), null);
  assert.equal(guild.systemChannel.sent.length, 0);
});

test('configured guilds receive no setup panel', async () => {
  const service = {
    getStatus: async () => ({
      configured: true,
      onboardingPanel: { channelId: null, messageId: null },
    }),
  };
  const guild = createGuild();

  assert.equal(await ensureGuildSetupPanel(guild, service), null);
  assert.equal(guild.systemChannel.sent.length, 0);
});

test('setup channel falls back to the first writable text channel', () => {
  const blockedSystem = createChannel('3001', false);
  const blocked = createChannel('3002', false);
  const writable = createChannel('3003', true);
  const guild = createGuild({
    systemChannel: blockedSystem,
    channels: { cache: new Map([[blocked.id, blocked], [writable.id, writable]]) },
  });

  assert.equal(findSetupChannel(guild), writable);
});

test('guild create reconciles a setup panel for a newly joined guild', async () => {
  const calls = [];
  const guild = createGuild({ id: '1002' });
  const handler = createGuildCreateHandler({
    guildConfigService: {
      getStatus: async () => ({
        configured: false,
        onboardingPanel: { channelId: null, messageId: null },
      }),
      setOnboardingPanel: async (...args) => calls.push(args),
    },
  });

  const message = await handler(guild);

  assert.equal(message.id, '300101');
  assert.deepEqual(calls, [['1002', '3001', '300101']]);
});

test('bot wiring subscribes to guild-create onboarding', () => {
  const subscriptions = [];
  const client = {
    once: (event) => subscriptions.push(['once', event]),
    on: (event) => subscriptions.push(['on', event]),
  };
  const guildConfigService = {
    getStatus: async () => ({ configured: true }),
  };

  wireBotEvents(client, { guildConfigService });

  assert.ok(subscriptions.some(([method, event]) => method === 'on' && event === Events.GuildCreate));
});

test('ready reconciles panels without automatically registering commands', async () => {
  let commandSetCalls = 0;
  const guild = createGuild();
  const readyClient = {
    user: {
      tag: 'Bot#0001',
      setPresence: () => {},
    },
    application: {
      commands: { set: async () => { commandSetCalls += 1; } },
    },
    guilds: { cache: new Map([[guild.id, guild]]) },
    channels: { cache: new Map() },
  };
  const service = {
    getStatus: async () => ({ configured: true, onboardingPanel: { channelId: null, messageId: null } }),
  };
  const handler = createReadyHandler({ guildConfigService: service });
  const originalLog = console.log;
  console.log = () => {};

  try {
    await handler(readyClient);
  } finally {
    console.log = originalLog;
  }

  assert.equal(commandSetCalls, 0);
});
