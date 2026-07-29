const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PROVIDER_KEY_LINKS,
  createProviderKeyEmbed,
  isProviderKeyCommand,
} = require('../src/commands/providerKeys');

test('AI key command is exact, case-insensitive, and follows the configured trigger', () => {
  assert.equal(isProviderKeyCommand('AI key'), true);
  assert.equal(isProviderKeyCommand(' ai KEY '), true);
  assert.equal(isProviderKeyCommand('llm key', 'llm'), true);
  assert.equal(isProviderKeyCommand('AI keys'), false);
  assert.equal(isProviderKeyCommand('AI key please'), false);
  assert.equal(isProviderKeyCommand('AI key', 'llm'), false);
});

test('provider key embed is compact and links only to official key pages', () => {
  const embed = createProviderKeyEmbed().toJSON();
  const serialized = JSON.stringify(embed);

  assert.match(embed.title, /API key/);
  assert.ok(embed.description.length < 500);
  assert.match(serialized, /DeepSeek/);
  assert.match(serialized, /Gemma/);
  assert.match(serialized, /Qwen/);
  assert.equal(PROVIDER_KEY_LINKS.deepseek, 'https://platform.deepseek.com/api_keys');
  assert.equal(PROVIDER_KEY_LINKS.gemini, 'https://aistudio.google.com/app/apikey');
  assert.match(PROVIDER_KEY_LINKS.qwen, /^https:\/\/www\.alibabacloud\.com\/help\/en\/model-studio\//);
  assert.doesNotMatch(serialized, /api[_ -]?key\s*[:=]\s*\w+/i);
});
