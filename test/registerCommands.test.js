const assert = require('node:assert/strict');
const test = require('node:test');
const { registerCommands } = require('../scripts/register-commands');

test('command registration upserts every owned command without bulk-replacing unrelated commands', async () => {
  const calls = [];
  const rest = {
    post: async (...args) => calls.push(['post', ...args]),
    put: async () => assert.fail('bulk replacement must not be used'),
  };

  await registerCommands({
    token: 'test-token',
    discordApplicationId: '1001',
    rest,
    logger: { log: () => {} },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call[2].body.name), [
    'ai-help', 'ai-setup',
  ]);
  assert.ok(calls.every((call) => call[0] === 'post'));
  assert.ok(calls.every((call) => /applications\/1001\/commands$/.test(call[1])));
});

test('owned command definitions serialize exact guild/admin and agent input contracts', () => {
  const { PermissionFlagsBits } = require('discord.js');
  const { commandDefinitions } = require('../src/interactions/commandDefinitions');
  const [aiHelp, aiSetup] = commandDefinitions;

  assert.deepEqual(commandDefinitions.map(({ name }) => name), [
    'ai-help', 'ai-setup',
  ]);
  assert.deepEqual(aiHelp.contexts, [0]);
  assert.equal(
    aiHelp.default_member_permissions,
    String(PermissionFlagsBits.ManageMessages),
  );
  assert.deepEqual(aiSetup.contexts, [0]);
  assert.equal(aiSetup.default_member_permissions, String(PermissionFlagsBits.ManageMessages));
  assert.deepEqual(aiSetup.options.map(({ name }) => name), [
    'status', 'api', 'channel', 'role', 'web', 'prompt', 'trigger', 'reset',
  ]);
  const trigger = aiSetup.options.find(({ name }) => name === 'trigger');
  assert.equal(trigger.options[0].required, true);
  assert.equal(trigger.options[0].max_length, 24);
  const prompt = aiSetup.options.find(({ name }) => name === 'prompt');
  assert.deepEqual(prompt.options.map(({ name }) => name), ['action', 'scope', 'channel', 'text', 'file']);
  assert.equal(prompt.options.find(({ name }) => name === 'text').max_length, 4000);
  assert.deepEqual(prompt.options.find(({ name }) => name === 'channel').channel_types, [0, 5, 11, 12, 10]);
  const api = aiSetup.options.find(({ name }) => name === 'api');
  assert.deepEqual(api.options.map(({ name }) => name), ['provider', 'web-search']);
  assert.deepEqual(api.options[0].choices.map(({ name, value }) => ({ name, value })), [
    { name: 'DeepSeek', value: 'deepseek' },
    { name: 'Gemma 4 (Gemini API)', value: 'gemma4' },
    { name: 'Qwen (image analysis)', value: 'qwen' },
  ]);
});

test('repeated named registration skips unchanged definitions and never invokes destructive methods', async () => {
  const names = [];
  const registered = [];
  const rest = {
    get: async () => registered,
    post: async (route, { body }) => {
      names.push(body.name);
      registered.push(structuredClone(body));
      return body;
    },
    put: async () => assert.fail('bulk replacement must not be used'),
    delete: async () => assert.fail('owned upsert must not delete commands'),
    set: async () => assert.fail('command set must not be used'),
  };
  const options = {
    token: 'test-token',
    discordApplicationId: '1001',
    rest,
    logger: { log: () => {} },
  };

  await registerCommands(options);
  await registerCommands(options);

  assert.deepEqual(names, [
    'ai-help', 'ai-setup',
  ]);
});
