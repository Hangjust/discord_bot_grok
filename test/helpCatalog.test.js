const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DISCORD_MESSAGE_LIMIT,
  getAiHelpMessage,
  getAiHelpPages,
  getHelpCatalog,
  getHelpEmbedPages,
  helpCatalog,
  helpNotes,
  isAiHelpCommand,
  isHelpCommand,
} = require('../src/commands/help');
const { commandDefinitions } = require('../src/interactions/commandDefinitions');

test('canonical help catalog has unique entries for every supported command surface', () => {
  assert.equal(new Set(helpCatalog.map((entry) => entry.id)).size, helpCatalog.length);
  assert.equal(new Set(helpCatalog.map((entry) => entry.invocation)).size, helpCatalog.length);

  for (const expected of [
    'AI/@bot <message>',
    'AI new',
    '/ai-setup status',
    '/ai-setup api',
    '/ai-setup channel',
    '/ai-setup role',
    '/ai-setup web',
    '/ai-setup prompt',
    '/ai-setup trigger',
    '!AI name <new name>',
    '!AI pfp + image',
    '!AI pfp reset',
    '/ai-setup reset',
  ]) {
    assert.equal(helpCatalog.filter((entry) => entry.invocation === expected).length, 1, expected);
  }

  assert.doesNotMatch(
    helpCatalog.map(({ invocation }) => invocation).join('\n'),
    /\b(?:lore|stats|blud|funmute|ratio)\b|who\s+is/i,
  );
});

test('canonical help documents every setup action without duplicate aliases', () => {
  const documented = helpCatalog.map(({ invocation }) => invocation);
  const expected = [];

  const setup = commandDefinitions.find(({ name }) => name === 'ai-setup');
  for (const option of setup.options) {
    expected.push(`/ai-setup ${option.name}`);
  }

  for (const invocation of expected) {
    assert.equal(
      documented.filter((entry) => entry === invocation || entry.startsWith(`${invocation} [`)).length,
      1,
      invocation,
    );
  }

  assert.deepEqual(commandDefinitions.map(({ name }) => name), ['ai-help', 'ai-setup']);
});

test('help render is Discord-safe, complete, and split within message limits', () => {
  const pages = getAiHelpPages();
  const rendered = getAiHelpMessage();

  assert.ok(pages.length >= 1);
  assert.ok(pages.every((page) => page.length <= DISCORD_MESSAGE_LIMIT));
  for (const entry of helpCatalog) {
    assert.ok(rendered.includes(`\`${entry.invocation}\``));
    if (entry.permission === 'Administrators') {
      assert.match(rendered, /Permission: Administrators/);
    }
  }

  for (const note of helpNotes) {
    assert.ok(rendered.includes(note));
  }
});

test('AI help alias remains exact and case-insensitive', () => {
  assert.equal(isAiHelpCommand(' !AI-HELP '), true);
  assert.equal(isAiHelpCommand('!AI-help now'), false);
  assert.equal(isHelpCommand(' help '), true);
  assert.equal(isHelpCommand('Ai Help'), true);
  assert.equal(isHelpCommand('llm help', 'llm'), true);
  assert.equal(isHelpCommand('AI help now'), false);
});

test('help embeds adapt to the configured trigger and remain inside Discord embed limits', () => {
  const dynamicCatalog = getHelpCatalog('llm');
  assert.equal(dynamicCatalog[0].invocation, 'llm/@bot <message>');

  const pages = getHelpEmbedPages({
    triggerWord: 'llm',
    configured: true,
    webSearchEnabled: true,
    promptSource: 'channel',
    guildName: 'Test Guild',
  }).map((embed) => embed.toJSON());

  assert.equal(pages.length, 2);
  assert.ok(pages.every(({ fields = [] }) => fields.every(({ value }) => value.length <= 1024)));
  assert.ok(pages.every(({ description = '' }) => description.length <= 4096));
  assert.match(JSON.stringify(pages), /llm\/@bot <message>/);
  assert.match(JSON.stringify(pages[1]), /Type .*\/ai-setup.* administrator setup commands/);
  assert.match(JSON.stringify(pages[1]), /\/ai-setup status/);
  assert.doesNotMatch(JSON.stringify(pages), /🧰 Utilities|⚡ Slash help|!ping|\/ai-help/);
  assert.doesNotMatch(
    JSON.stringify(pages),
    /Setup areas|Current setup status|Configuration:|Web search:|Effective prompt:|How prompt selection works|Custom prompt precedence|This page contains safe status only|Messages that pass access policy/,
  );
  assert.doesNotMatch(JSON.stringify(pages), /Help guide|help \| llm help \| !AI-help/);
});
