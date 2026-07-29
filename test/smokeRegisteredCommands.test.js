const assert = require('node:assert/strict');
const test = require('node:test');
const { commandDefinitions } = require('../src/interactions/commandDefinitions');
const {
  compareRegisteredCommands,
  smokeRegisteredCommands,
} = require('../scripts/smoke-registered-commands');

test('read-only command smoke accepts matching owned definitions and ignores unrelated commands', async () => {
  const calls = [];
  const registered = [
    ...structuredClone(commandDefinitions).map((definition, index) => ({
      id: String(index + 1),
      application_id: '1001',
      version: '9',
      ...definition,
    })),
    { name: 'unrelated', description: 'must remain untouched', type: 1 },
  ];
  const result = await smokeRegisteredCommands({
    token: 'test-token',
    discordApplicationId: '1001',
    rest: {
      get: async (...args) => {
        calls.push(['get', ...args]);
        return registered;
      },
      post: async () => assert.fail('smoke must be read-only'),
      put: async () => assert.fail('smoke must be read-only'),
      delete: async () => assert.fail('smoke must be read-only'),
    },
    logger: { log: () => {} },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.checkedNames, [
    'ai-help', 'ai-setup',
  ]);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /applications\/1001\/commands$/);
});

test('read-only command comparison reports mismatched owned names without data leakage', () => {
  const registered = structuredClone(commandDefinitions);
  registered[0].description = 'wrong';
  const result = compareRegisteredCommands(registered);

  assert.equal(result.ok, false);
  assert.deepEqual(result.differences, [
    'ai-help: definition differs',
  ]);
  assert.doesNotMatch(result.differences.join(' '), /token|authorization|ciphertext/i);
});

test('read-only smoke rejects missing definitions with an actionable failure for nonzero CLI handling', async () => {
  await assert.rejects(
    smokeRegisteredCommands({
      token: 'test-token',
      discordApplicationId: '1001',
      rest: {
      get: async () => structuredClone(commandDefinitions.slice(0, 1)),
        post: async () => assert.fail('smoke must not write'),
        put: async () => assert.fail('smoke must not write'),
        delete: async () => assert.fail('smoke must not write'),
      },
      logger: { log: () => {} },
    }),
    (error) => {
      assert.match(error.message, /ai-setup: missing/);
      assert.doesNotMatch(error.message, /test-token/);
      return true;
    },
  );
});
