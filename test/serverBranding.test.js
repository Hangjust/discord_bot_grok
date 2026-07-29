const assert = require('node:assert/strict');
const test = require('node:test');
const { PermissionFlagsBits } = require('discord.js');
const { createMessageCreateHandler } = require('../src/events/messageCreate');
const {
  MAX_AVATAR_BYTES,
  canManageServerBranding,
  detectImageMimeType,
  downloadAvatar,
  handleServerBrandingCommand,
  normalizeBotNickname,
  parseServerBrandingCommand,
} = require('../src/commands/serverBranding');

const PNG = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D,
]);

function attachment(overrides = {}) {
  return {
    name: 'avatar.png',
    size: PNG.length,
    url: 'https://cdn.discordapp.com/attachments/1/2/avatar.png',
    ...overrides,
  };
}

function attachments(items = []) {
  return {
    size: items.length,
    first: () => items[0],
    values: () => items.values(),
  };
}

function createMessage(overrides = {}) {
  const edits = [];
  const replies = [];
  const guildMembers = {
    editMe: async (value) => {
      edits.push(value);
      return value;
    },
  };
  const message = {
    attachments: attachments(),
    author: { id: '2001', bot: false },
    guild: {
      id: '1001',
      ownerId: '9999',
      members: guildMembers,
    },
    guildId: '1001',
    member: {
      permissions: {
        has: (flag) => flag === PermissionFlagsBits.Administrator,
      },
    },
    reply: async (value) => {
      replies.push(value);
      return value;
    },
    ...overrides,
  };
  return { edits, guildMembers, message, replies };
}

test('branding commands accept stable AI and configured trigger prefixes exactly', () => {
  assert.deepEqual(parseServerBrandingCommand('!AI name Server Assistant', 'llm'), {
    action: 'name',
    value: 'Server Assistant',
  });
  assert.deepEqual(parseServerBrandingCommand('!llm PFP', 'llm'), {
    action: 'pfp',
    value: '',
  });
  assert.equal(parseServerBrandingCommand('AI name nope', 'AI'), null);
  assert.equal(parseServerBrandingCommand('!AI names nope', 'AI'), null);
});

test('server owner or Discord Administrator can manage branding', () => {
  const administrator = createMessage().message;
  assert.equal(canManageServerBranding(administrator), true);

  const owner = createMessage({
    author: { id: '9999', bot: false },
    member: { permissions: { has: () => false } },
  }).message;
  assert.equal(canManageServerBranding(owner), true);

  const member = createMessage({
    member: { permissions: { has: () => false } },
  }).message;
  assert.equal(canManageServerBranding(member), false);
});

test('nickname input is trimmed, Unicode-aware, and bounded to Discord limits', () => {
  assert.equal(normalizeBotNickname('  Server Assistant  '), 'Server Assistant');
  assert.equal(Array.from(normalizeBotNickname('😀'.repeat(32))).length, 32);
  assert.throws(() => normalizeBotNickname(''), /invalid_name/);
  assert.throws(() => normalizeBotNickname('x'.repeat(33)), /invalid_name/);
  assert.throws(() => normalizeBotNickname('bad\nname'), /invalid_name/);
});

test('administrator name command edits only the current guild member profile', async () => {
  const fixture = createMessage();
  await handleServerBrandingCommand(
    fixture.message,
    parseServerBrandingCommand('!AI name Server Assistant'),
  );

  assert.equal(fixture.edits.length, 1);
  assert.equal(fixture.edits[0].nick, 'Server Assistant');
  assert.match(fixture.edits[0].reason, /2001/);
  assert.equal(fixture.replies[0].content, 'My name has been updated for this server.');
});

test('message routing handles owner/admin branding before normal AI access policy', async () => {
  const fixture = createMessage({
    content: '!AI name Guild Helper',
    webhookId: null,
  });
  fixture.message.author.username = 'admin';
  const handler = createMessageCreateHandler({ user: { id: '9001' } }, {
    accessPolicy: {
      isMessageAllowed: async () => {
        throw new Error('branding should not consult normal AI access policy');
      },
    },
    guildConfigService: {
      getInvocationConfig: async () => ({ triggerWord: 'AI' }),
    },
  });

  await handler(fixture.message);

  assert.equal(fixture.edits.length, 1);
  assert.equal(fixture.edits[0].nick, 'Guild Helper');
});

test('unauthorized members cannot invoke either branding mutation', async () => {
  const fixture = createMessage({
    attachments: attachments([attachment()]),
    member: { permissions: { has: () => false } },
  });
  let fetchCalls = 0;

  await handleServerBrandingCommand(
    fixture.message,
    parseServerBrandingCommand('!AI pfp'),
    { fetchImpl: async () => { fetchCalls += 1; } },
  );

  assert.equal(fetchCalls, 0);
  assert.equal(fixture.edits.length, 0);
  assert.match(fixture.replies[0].content, /server owner.*Administrator/i);
});

test('avatar command downloads one verified Discord image and edits this guild only', async () => {
  const fixture = createMessage({
    attachments: attachments([attachment()]),
  });
  const requests = [];

  await handleServerBrandingCommand(
    fixture.message,
    parseServerBrandingCommand('!AI pfp'),
    {
      fetchImpl: async (url, options) => {
        requests.push({ options, url: String(url) });
        return new Response(PNG, {
          status: 200,
          headers: { 'content-length': String(PNG.length) },
        });
      },
    },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, attachment().url);
  assert.equal(requests[0].options.redirect, 'error');
  assert.deepEqual(fixture.edits[0].avatar, PNG);
  assert.equal(fixture.replies[0].content, 'My profile picture has been updated for this server.');
});

test('avatar reset restores the global profile without downloading an attachment', async () => {
  const fixture = createMessage();
  let fetchCalls = 0;

  await handleServerBrandingCommand(
    fixture.message,
    parseServerBrandingCommand('!AI pfp Reset'),
    { fetchImpl: async () => { fetchCalls += 1; } },
  );

  assert.equal(fetchCalls, 0);
  assert.equal(fixture.edits.length, 1);
  assert.equal(fixture.edits[0].avatar, null);
  assert.match(fixture.edits[0].reason, /reset.*2001/i);
  assert.equal(
    fixture.replies[0].content,
    'My profile picture has been reset to the normal one for this server.',
  );
});

test('avatar validation rejects SSRF URLs, oversized files, and spoofed image bytes', async () => {
  await assert.rejects(
    downloadAvatar(attachment({ url: 'https://example.com/attachments/1/2/avatar.png' })),
    (error) => error.code === 'invalid_avatar',
  );

  const oversized = createMessage({
    attachments: attachments([attachment({ size: MAX_AVATAR_BYTES + 1 })]),
  });
  await handleServerBrandingCommand(
    oversized.message,
    parseServerBrandingCommand('!AI pfp'),
  );
  assert.equal(oversized.edits.length, 0);
  assert.match(oversized.replies[0].content, /6 MiB/);

  const spoofed = createMessage({
    attachments: attachments([attachment()]),
  });
  await handleServerBrandingCommand(
    spoofed.message,
    parseServerBrandingCommand('!AI pfp'),
    { fetchImpl: async () => new Response(Buffer.from('<svg></svg>'), { status: 200 }) },
  );
  assert.equal(spoofed.edits.length, 0);
  assert.match(spoofed.replies[0].content, /valid PNG/);
});

test('supported image signatures are detected without trusting file metadata', () => {
  assert.equal(detectImageMimeType(PNG), 'image/png');
  assert.equal(detectImageMimeType(Buffer.from([0xFF, 0xD8, 0xFF])), 'image/jpeg');
  assert.equal(detectImageMimeType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(detectImageMimeType(Buffer.from('RIFF0000WEBP')), 'image/webp');
  assert.equal(detectImageMimeType(Buffer.from('<svg></svg>')), null);
});
