const assert = require('node:assert/strict');
const test = require('node:test');
const { registerCommands } = require('../scripts/register-commands');

test('command registration upserts grok-config without bulk-replacing unrelated commands', async () => {
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

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'post');
  assert.equal(calls[0][2].body.name, 'grok-config');
  assert.match(calls[0][1], /applications\/1001\/commands$/);
});
