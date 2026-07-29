const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const test = require('node:test');
const {
  createDefaultGuildConfig,
  immutableSnapshot,
  normalizeGuildConfig,
  normalizeGuildConfigDocument,
} = require('../src/config/guildConfigSchema');
const { createSecretCipher } = require('../src/security/secretCipher');
const { createGuildConfigStore, writeJsonAtomic } = require('../src/storage/guildConfigStore');
const { createGuildConfigService } = require('../src/services/guildConfigService');

async function createFixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'guild-config-test-'));
  const filePath = join(directory, 'nested', 'guild-config.json');
  const cipher = createSecretCipher({
    masterKey: randomBytes(32).toString('base64'),
    keyId: 'primary',
  });
  const store = createGuildConfigStore({ filePath, atomicWriter: options.atomicWriter });
  const service = createGuildConfigService({
    store,
    cipher,
    env: options.env || {},
    now: options.now || (() => new Date('2026-07-27T12:00:00.000Z')),
  });

  return {
    cipher,
    directory,
    filePath,
    service,
    store,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('schema normalizes defaults, IDs, duplicates, and legacy version fields', () => {
  const defaults = createDefaultGuildConfig('1001');
  const normalized = normalizeGuildConfigDocument({
    version: 1,
    records: {
      1001: {
        guildId: defaults.guildId,
        configured: false,
        version: 1,
        allowedChannelIds: ['30', '20', '30'],
        ignoredRoleIds: ['50', '40', '50'],
      },
    },
  });

  assert.equal(normalized.schemaVersion, 4);
  assert.equal(normalized.guilds['1001'].schemaVersion, 4);
  assert.equal(normalized.guilds['1001'].aiProvider, 'deepseek');
  assert.equal(normalized.guilds['1001'].geminiKey, null);
  assert.deepEqual(normalized.guilds['1001'].agent, { server: null, channels: {} });
  assert.deepEqual(normalized.guilds['1001'].invocation, {
    triggerWord: 'AI',
    updatedAt: null,
    updatedByUserId: null,
  });
  assert.deepEqual(normalized.guilds['1001'].access.allowedChannelIds, ['20', '30']);
  assert.deepEqual(normalized.guilds['1001'].access.ignoredRoleIds, ['40', '50']);
  assert.deepEqual(defaults.access, {
    allowedChannelIds: [],
    ignoredChannelIds: [],
    allowedRoleIds: [],
    ignoredRoleIds: [],
  });
});

test('schema rejects malformed, mismatched, and future data', () => {
  assert.throws(() => normalizeGuildConfigDocument([]), /must be an object/);
  assert.throws(() => normalizeGuildConfigDocument({ schemaVersion: 5, guilds: {} }), /newer/);
  assert.throws(() => normalizeGuildConfigDocument({ guilds: [] }), /guilds must be an object/);
  assert.throws(
    () => normalizeGuildConfig('1001', { guildId: '1002', configured: false }),
    /does not match/,
  );
  assert.throws(
    () => normalizeGuildConfig('1001', { schemaVersion: 5, guildId: '1001' }),
    /newer/,
  );
  assert.throws(
    () => normalizeGuildConfig('1001', {
      guildId: '1001',
      configured: true,
      deepseekKey: {
        formatVersion: 1,
        keyId: 'primary',
        algorithm: 'aes-256-gcm',
        iv: 'not-base64',
        ciphertext: 'also-not-base64',
        tag: 'bad',
      },
    }),
    /valid base64|invalid length/,
  );
});

test('schema v2 normalizes agent documents, IDs, Markdown, and character bounds', () => {
  const exactlyFourThousand = `  ${'x'.repeat(4_000)}  `;
  const normalized = normalizeGuildConfig('1001', {
    schemaVersion: 2,
    guildId: '1001',
    configured: false,
    agent: {
      server: {
        content: exactlyFourThousand,
        updatedAt: '2026-07-27T12:00:00Z',
        updatedByUserId: ' 2001 ',
      },
      channels: {
        ' 3001 ': {
          content: '\n# Channel rules\n\nPreserve **Markdown**.\n',
          updatedAt: '2026-07-27T13:00:00+00:00',
          updatedByUserId: '2002',
        },
      },
    },
  });

  assert.equal(normalized.agent.server.content.length, 4_000);
  assert.equal(normalized.agent.server.updatedByUserId, '2001');
  assert.equal(normalized.agent.server.updatedAt, '2026-07-27T12:00:00.000Z');
  assert.equal(normalized.agent.channels['3001'].content, '# Channel rules\n\nPreserve **Markdown**.');
  assert.equal(Object.isFrozen(immutableSnapshot(normalized).agent.channels['3001']), true);

  assert.throws(
    () => normalizeGuildConfig('1001', {
      guildId: '1001',
      agent: {
        server: {
          content: 'x'.repeat(4_001),
          updatedAt: '2026-07-27T12:00:00Z',
          updatedByUserId: '2001',
        },
      },
    }),
    /at most 4000 characters/,
  );
  assert.throws(
    () => normalizeGuildConfig('1001', {
      guildId: '1001',
      agent: {
        channels: {
          3001: {
            content: 'one',
            updatedAt: '2026-07-27T12:00:00Z',
            updatedByUserId: '2001',
          },
          ' 3001 ': {
            content: 'two',
            updatedAt: '2026-07-27T12:00:00Z',
            updatedByUserId: '2001',
          },
        },
      },
    }),
    /duplicate channel ID/,
  );
  assert.throws(
    () => normalizeGuildConfig('1001', {
      guildId: '1001',
      agent: { server: { content: ' ', updatedAt: null, updatedByUserId: '2001' } },
    }),
    /updatedAt is required|must not be empty/,
  );
});

test('store migration upgrades configured, tombstone, aliases, and multiple guilds atomically', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const encryptedDeepseek = fixture.cipher.encrypt('1001', 'deepseek', 'configured-secret');
  const encryptedBrave = fixture.cipher.encrypt('1001', 'brave', 'brave-secret');
  const legacyDocument = {
    version: 1,
    operatorMetadata: { migrationLabel: 'preserve-me' },
    records: {
      1001: {
        version: 1,
        guildId: '1001',
        configured: true,
        revision: 7,
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
        configuredAt: '2026-07-20T00:00:00.000Z',
        configuredByUserId: '2001',
        deepseekKey: encryptedDeepseek,
        webSearch: { enabled: true, braveKey: encryptedBrave },
        allowedChannelIds: ['3002', '3001', '3002'],
        ignoredRoleIds: ['5001'],
        onboardingPanel: { channelId: '3001', messageId: '7001' },
        unrelatedMetadata: { ownerNote: 'keep this too' },
      },
      1002: {
        schemaVersion: 1,
        guildId: '1002',
        configured: false,
        revision: 3,
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
        configuredAt: null,
        configuredByUserId: null,
        deepseekKey: null,
        webSearch: { enabled: false, braveKey: null },
        access: {
          allowedChannelIds: [],
          ignoredChannelIds: ['4001'],
          allowedRoleIds: [],
          ignoredRoleIds: [],
        },
        onboardingPanel: { channelId: null, messageId: null, operatorNote: 'preserve nested metadata' },
      },
    },
  };
  await mkdir(join(fixture.directory, 'nested'), { recursive: true });
  await writeFile(fixture.filePath, `${JSON.stringify(legacyDocument, null, 2)}\n`, 'utf8');

  const migrated = await fixture.store.initialize();
  const persisted = JSON.parse(await readFile(fixture.filePath, 'utf8'));

  assert.equal(migrated.schemaVersion, 4);
  assert.deepEqual(Object.keys(migrated.guilds), ['1001', '1002']);
  assert.equal(migrated.guilds['1001'].schemaVersion, 4);
  assert.deepEqual(migrated.guilds['1001'].agent, { server: null, channels: {} });
  assert.equal(migrated.guilds['1001'].invocation.triggerWord, 'AI');
  assert.deepEqual(migrated.guilds['1001'].access.allowedChannelIds, ['3001', '3002']);
  assert.deepEqual(migrated.guilds['1001'].access.ignoredRoleIds, ['5001']);
  assert.equal(Object.hasOwn(migrated.guilds['1001'].access, 'deepseekKey'), false);
  assert.deepEqual(migrated.guilds['1001'].onboardingPanel, {
    channelId: '3001',
    messageId: '7001',
  });
  assert.equal(migrated.guilds['1002'].configured, false);
  assert.equal(migrated.guilds['1002'].revision, 3);
  assert.deepEqual(migrated.guilds['1002'].access.ignoredChannelIds, ['4001']);
  assert.equal(
    migrated.guilds['1002'].onboardingPanel.operatorNote,
    'preserve nested metadata',
  );
  assert.deepEqual(persisted, migrated);
  assert.deepEqual(persisted.guilds['1001'].deepseekKey, encryptedDeepseek);
  assert.deepEqual(persisted.guilds['1001'].webSearch.braveKey, encryptedBrave);
  assert.deepEqual(persisted.operatorMetadata, { migrationLabel: 'preserve-me' });
  assert.deepEqual(persisted.guilds['1001'].unrelatedMetadata, { ownerNote: 'keep this too' });

  const reloaded = createGuildConfigStore({ filePath: fixture.filePath });
  assert.deepEqual(await reloaded.initialize(), migrated);
});

test('failed migration write preserves source bytes, publishes nothing, and permits retry', async (t) => {
  let migrationWrites = 0;
  const atomicWriter = async (filePath, document) => {
    migrationWrites += 1;

    if (migrationWrites === 1) {
      throw new Error('injected migration failure');
    }

    await writeJsonAtomic(filePath, document);
  };
  const fixture = await createFixture({ atomicWriter });
  t.after(fixture.cleanup);
  const legacyDocument = {
    schemaVersion: 1,
    guilds: {
      1001: {
        schemaVersion: 1,
        guildId: '1001',
        configured: false,
        revision: 1,
      },
    },
  };
  const sourceBytes = Buffer.from(`${JSON.stringify(legacyDocument, null, 2)}\n`);
  await mkdir(join(fixture.directory, 'nested'), { recursive: true });
  await writeFile(fixture.filePath, sourceBytes);

  await assert.rejects(fixture.store.initialize(), /injected migration failure/);
  assert.deepEqual(await readFile(fixture.filePath), sourceBytes);
  assert.equal(migrationWrites, 1);

  const migrated = await fixture.store.initialize();
  assert.equal(migrationWrites, 2);
  assert.equal(migrated.schemaVersion, 4);
  assert.deepEqual(migrated.guilds['1001'].agent, { server: null, channels: {} });
});

test('v2 migration rejects malformed agent data and v4 rejects future data without rewriting it', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const malformed = {
    schemaVersion: 2,
    guilds: {
      1001: {
        schemaVersion: 2,
        guildId: '1001',
        configured: false,
        agent: {
          server: null,
          channels: {
            3001: {
              content: '',
              updatedAt: 'not-a-date',
              updatedByUserId: '2001',
            },
          },
        },
      },
    },
  };
  const malformedBytes = Buffer.from(`${JSON.stringify(malformed)}\n`);
  await mkdir(join(fixture.directory, 'nested'), { recursive: true });
  await writeFile(fixture.filePath, malformedBytes);
  await assert.rejects(fixture.store.initialize(), /ISO timestamp|must not be empty/);
  assert.deepEqual(await readFile(fixture.filePath), malformedBytes);

  const future = Buffer.from('{"schemaVersion":5,"guilds":{}}\n');
  await writeFile(fixture.filePath, future);
  await assert.rejects(fixture.store.initialize(), /newer/);
  assert.deepEqual(await readFile(fixture.filePath), future);
});

test('serialized store writes ciphertext only and reloads records', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const deepseekApiKey = 'deepseek-plaintext-must-not-persist';
  const braveApiKey = 'brave-plaintext-must-not-persist';

  await fixture.service.configureGuild('1001', {
    configuredByUserId: '2001',
    setupChannelId: '3001',
    deepseekApiKey,
    webSearchEnabled: true,
    braveApiKey,
  });

  const serialized = await readFile(fixture.filePath, 'utf8');
  const reloaded = createGuildConfigStore({ filePath: fixture.filePath });
  const record = await reloaded.getGuild('1001');

  assert.doesNotMatch(serialized, new RegExp(deepseekApiKey));
  assert.doesNotMatch(serialized, new RegExp(braveApiKey));
  assert.match(serialized, /aes-256-gcm/);
  assert.equal(record.configured, true);
  assert.deepEqual(record.access.allowedChannelIds, ['3001']);
});

test('Gemma 4 uses an encrypted Gemini key and resolves the official Gemini API model', async (t) => {
  const fixture = await createFixture({
    env: {
      GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta',
      GEMINI_MODEL: 'gemma-4-26b-a4b-it',
      GEMINI_TIMEOUT_MS: '4321',
    },
  });
  t.after(fixture.cleanup);
  const geminiApiKey = 'gemini-plaintext-must-not-persist';

  await fixture.service.configureGuild('1001', {
    configuredByUserId: '2001',
    setupChannelId: '3001',
    aiProvider: 'gemma4',
    geminiApiKey,
    webSearchEnabled: false,
  });

  const status = await fixture.service.getStatus('1001');
  const runtime = await fixture.service.resolveRuntimeConfig('1001', '3001');
  const serialized = await readFile(fixture.filePath, 'utf8');

  assert.equal(status.aiProvider, 'gemma4');
  assert.equal(status.hasGeminiKey, true);
  assert.equal(status.hasDeepseekKey, false);
  assert.equal(runtime.aiProvider, 'gemma4');
  assert.equal(runtime.ai.provider, 'gemma4');
  assert.equal(runtime.ai.apiKey, geminiApiKey);
  assert.equal(runtime.ai.model, 'gemma-4-26b-a4b-it');
  assert.equal(runtime.ai.timeoutMs, 4321);
  assert.equal(runtime.deepseek, undefined);
  assert.doesNotMatch(serialized, new RegExp(geminiApiKey));
  assert.match(serialized, /aes-256-gcm/);
});

test('store serializes concurrent updates without lost writes', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  await Promise.all(Array.from({ length: 20 }, (_, index) => fixture.store.updateGuild('1001', async (current) => {
    await new Promise((resolve) => setTimeout(resolve, index % 3));
    return {
      ...current,
      revision: current.revision + 1,
      access: {
        ...current.access,
        allowedChannelIds: [...current.access.allowedChannelIds, String(4000 + index)],
      },
    };
  })));

  const record = await fixture.store.getGuild('1001');
  assert.equal(record.revision, 20);
  assert.equal(record.access.allowedChannelIds.length, 20);
});

test('failed atomic writes leave the in-memory and on-disk record unchanged', async (t) => {
  let failNextWrite = false;
  const atomicWriter = async (filePath, document) => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('injected plaintext secret should not escape');
    }

    await writeJsonAtomic(filePath, document);
  };
  const fixture = await createFixture({ atomicWriter });
  t.after(fixture.cleanup);

  await fixture.service.configureGuild('1001', {
    configuredByUserId: '2001',
    setupChannelId: '3001',
    deepseekApiKey: 'first-secret',
    webSearchEnabled: false,
  });
  const before = await fixture.store.getGuild('1001');
  const beforeFile = await readFile(fixture.filePath, 'utf8');
  failNextWrite = true;

  await assert.rejects(
    fixture.service.rotateSecret('1001', 'deepseek', 'replacement-plaintext-secret'),
    (error) => {
      assert.doesNotMatch(error.message, /replacement-plaintext-secret/);
      return true;
    },
  );

  assert.deepEqual(await fixture.store.getGuild('1001'), before);
  assert.equal(await readFile(fixture.filePath, 'utf8'), beforeFile);

  await fixture.service.moveAccessEntry('1001', 'channel', 'allow', '3002');
  assert.deepEqual((await fixture.store.getGuild('1001')).access.allowedChannelIds, ['3001', '3002']);
});

test('stored configured record wins over legacy environment credentials', async (t) => {
  const fixture = await createFixture({
    env: {
      ALLOW_LEGACY_GUILD_CONFIG: 'true',
      DEEPSEEK_API_KEY: 'legacy-deepseek',
      WEB_SEARCH_ENABLED: 'true',
      WEB_SEARCH_API_KEY: 'legacy-brave',
      DISCORD_REPLY_ALLOWED_CHANNEL_IDS: '9001',
    },
  });
  t.after(fixture.cleanup);

  await fixture.service.configureGuild('1001', {
    configuredByUserId: '2001',
    setupChannelId: '3001',
    deepseekApiKey: 'stored-deepseek',
    webSearchEnabled: true,
    braveApiKey: 'stored-brave',
  });

  const runtime = await fixture.service.resolveRuntimeConfig('1001');
  assert.equal(runtime.source, 'stored');
  assert.equal(runtime.deepseek.apiKey, 'stored-deepseek');
  assert.equal(runtime.webSearch.apiKey, 'stored-brave');
  assert.deepEqual(runtime.access.allowedChannelIds, ['3001']);
});

test('reset creates a tombstone that removes secrets and suppresses legacy fallback', async (t) => {
  const fixture = await createFixture({
    env: {
      ALLOW_LEGACY_GUILD_CONFIG: 'true',
      DEEPSEEK_API_KEY: 'legacy-deepseek',
      WEB_SEARCH_ENABLED: 'true',
      WEB_SEARCH_API_KEY: 'legacy-brave',
    },
  });
  t.after(fixture.cleanup);

  await fixture.service.configureGuild('1001', {
    configuredByUserId: '2001',
    setupChannelId: '3001',
    deepseekApiKey: 'stored-deepseek',
    webSearchEnabled: true,
    braveApiKey: 'stored-brave',
  });
  await fixture.service.setOnboardingPanel('1001', '3001', '7001');
  const tombstone = await fixture.service.resetGuild('1001', '2001');
  const runtime = await fixture.service.resolveRuntimeConfig('1001');
  const serialized = await readFile(fixture.filePath, 'utf8');

  assert.equal(tombstone.configured, false);
  assert.equal(tombstone.deepseekKey, null);
  assert.deepEqual(tombstone.webSearch, { enabled: false, braveKey: null });
  assert.deepEqual(tombstone.onboardingPanel, { channelId: '3001', messageId: '7001' });
  assert.deepEqual(runtime, {
    guildId: '1001',
    configured: false,
    source: 'tombstone',
    triggerWord: 'AI',
  });
  assert.doesNotMatch(serialized, /stored-deepseek|stored-brave|legacy-deepseek|legacy-brave/);
});

test('legacy environment fallback is opt-in and only applies without a stored record', async (t) => {
  const env = {
    ALLOW_LEGACY_GUILD_CONFIG: 'true',
    DEEPSEEK_API_KEY: 'legacy-deepseek',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.example',
    DEEPSEEK_MODEL: 'legacy-model',
    WEB_SEARCH_ENABLED: 'true',
    WEB_SEARCH_API_KEY: 'legacy-brave',
    DISCORD_REPLY_ALLOWED_CHANNEL_IDS: '3002,3001,invalid',
    DISCORD_READ_EXCLUDED_CHANNEL_IDS: '4001',
  };
  const fixture = await createFixture({ env });
  t.after(fixture.cleanup);

  const runtime = await fixture.service.resolveRuntimeConfig('1001');
  assert.equal(runtime.source, 'legacy-env');
  assert.equal(runtime.deepseek.apiKey, 'legacy-deepseek');
  assert.equal(runtime.webSearch.apiKey, 'legacy-brave');
  assert.deepEqual(runtime.access.allowedChannelIds, ['3001', '3002']);
  assert.deepEqual(runtime.access.ignoredChannelIds, ['4001']);

  env.ALLOW_LEGACY_GUILD_CONFIG = 'false';
  assert.deepEqual(await fixture.service.resolveRuntimeConfig('1002'), {
    guildId: '1002',
    configured: false,
    source: 'none',
    triggerWord: 'AI',
  });
});

test('access moves reject unconfigured guilds without creating misleading state', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  await assert.rejects(
    fixture.service.moveAccessEntry('1001', 'channel', 'allow', '3001'),
    /not configured/i,
  );

  assert.equal(await fixture.service.getStoredConfig('1001'), null);
});

test('access moves are exclusive and onboarding metadata is retained', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  await fixture.service.configureGuild('1001', {
    configuredByUserId: '2001',
    setupChannelId: '3001',
    deepseekApiKey: 'stored-deepseek',
    webSearchEnabled: false,
  });
  await fixture.service.moveAccessEntry('1001', 'channel', 'ignore', '3001');
  await fixture.service.moveAccessEntry('1001', 'channel', 'allow', '3001');
  await fixture.service.moveAccessEntry('1001', 'role', 'ignore', '5001');
  await fixture.service.moveAccessEntry('1001', 'role', 'remove', '5001');
  await fixture.service.setOnboardingPanel('1001', '3001', '7001');

  const record = await fixture.service.getConfigSnapshot('1001');
  assert.deepEqual(record.access, {
    allowedChannelIds: ['3001'],
    ignoredChannelIds: [],
    allowedRoleIds: [],
    ignoredRoleIds: [],
  });
  assert.deepEqual(record.onboardingPanel, { channelId: '3001', messageId: '7001' });
});

test('service and store return immutable defensive snapshots', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  await fixture.service.configureGuild('1001', {
    configuredByUserId: '2001',
    setupChannelId: '3001',
    deepseekApiKey: 'stored-deepseek',
    webSearchEnabled: false,
  });

  const first = await fixture.service.getConfigSnapshot('1001');
  const runtime = await fixture.service.resolveRuntimeConfig('1001');
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.access), true);
  assert.equal(Object.isFrozen(first.access.allowedChannelIds), true);
  assert.equal(Object.isFrozen(runtime.deepseek), true);
  assert.throws(() => first.access.allowedChannelIds.push('9999'), /object is not extensible|read only/i);

  const second = await fixture.service.getConfigSnapshot('1001');
  assert.deepEqual(second.access.allowedChannelIds, ['3001']);
});

test('agent behavior precedence is exact channel then server then built-in without parent inheritance', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  for (const [guildId, userId, channelId] of [
    ['1001', '2001', '3001'],
    ['1002', '2002', '3002'],
  ]) {
    await fixture.service.configureGuild(guildId, {
      configuredByUserId: userId,
      setupChannelId: channelId,
      deepseekApiKey: `stored-${guildId}`,
      webSearchEnabled: false,
    });
  }

  const builtIn = await fixture.service.resolveAgentBehavior('1001', '3001');
  assert.equal(builtIn.source, 'built-in');
  assert.ok(builtIn.content.includes('You are an AI assistant for this Discord server.'));

  const serverSet = await fixture.service.setAgentBehavior('1001', {
    scope: 'server',
    content: '  # Server behavior\n\nBe precise.  ',
    updatedByUserId: '2001',
  });
  assert.equal(serverSet.changed, true);
  assert.equal(serverSet.source, 'server');
  assert.equal(serverSet.characterCount, '# Server behavior\n\nBe precise.'.length);

  await fixture.service.setAgentBehavior('1001', {
    scope: 'channel',
    channelId: '3001',
    content: '# Parent channel\n\nUse terse answers.',
    updatedByUserId: '2001',
  });
  await fixture.service.setAgentBehavior('1001', {
    scope: 'channel',
    channelId: '3999',
    content: 'x'.repeat(4_000),
    updatedByUserId: '2001',
  });

  const matrix = await Promise.all([
    fixture.service.resolveAgentBehavior('1001', '3001'),
    fixture.service.resolveAgentBehavior('1001', '3002'),
    fixture.service.resolveAgentBehavior('1001', '3999'),
    fixture.service.resolveAgentBehavior('1002', '3001'),
  ]);
  assert.deepEqual(matrix.map(({ source, characterCount }) => ({ source, characterCount })), [
    { source: 'channel', characterCount: '# Parent channel\n\nUse terse answers.'.length },
    { source: 'server', characterCount: '# Server behavior\n\nBe precise.'.length },
    { source: 'channel', characterCount: 4_000 },
    { source: 'built-in', characterCount: builtIn.characterCount },
  ]);

  // A thread is resolved by its own ID. The exact parent override is not inherited.
  const exactThread = await fixture.service.resolveAgentBehavior('1001', '3888');
  assert.equal(exactThread.source, 'server');
  assert.equal(exactThread.content, '# Server behavior\n\nBe precise.');

  const runtime = await fixture.service.resolveRuntimeConfig('1001', '3001');
  assert.equal(runtime.behaviorSource, 'channel');
  assert.equal(runtime.effectiveBehavior, '# Parent channel\n\nUse terse answers.');
  assert.equal(runtime.channelId, '3001');
  assert.equal(Object.hasOwn(runtime, 'updatedAt'), false);
  assert.equal(Object.hasOwn(runtime, 'updatedByUserId'), false);
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(matrix[0]), true);
  assert.throws(() => {
    matrix[0].channelOverrideIds.push('9999');
  }, /object is not extensible|read only/i);
});

test('agent behavior set and clear are idempotent and server clear retains channel overrides', async (t) => {
  let writes = 0;
  const fixture = await createFixture({
    atomicWriter: async (...args) => {
      writes += 1;
      return writeJsonAtomic(...args);
    },
  });
  t.after(fixture.cleanup);

  await fixture.service.configureGuild('1001', {
    configuredByUserId: '2001',
    setupChannelId: '3001',
    deepseekApiKey: 'stored-deepseek',
    webSearchEnabled: false,
  });
  const configuredWrites = writes;

  const first = await fixture.service.setAgentBehavior('1001', {
    scope: 'server',
    content: 'Server behavior',
    updatedByUserId: '2001',
  });
  const afterFirstWrites = writes;
  const identical = await fixture.service.setAgentBehavior('1001', {
    scope: 'server',
    content: '\nServer behavior \n',
    updatedByUserId: '2999',
  });

  assert.equal(first.revision, 2);
  assert.equal(identical.changed, false);
  assert.equal(identical.revision, first.revision);
  assert.equal(writes, afterFirstWrites);
  assert.equal(afterFirstWrites, configuredWrites + 1);

  const redundantOverride = await fixture.service.setAgentBehavior('1001', {
    scope: 'channel',
    channelId: '3888',
    content: 'Server behavior',
    updatedByUserId: '2001',
  });
  assert.equal(redundantOverride.changed, true);
  assert.equal(redundantOverride.effectiveChanged, false);
  const redundantClear = await fixture.service.clearAgentBehavior('1001', {
    scope: 'channel',
    channelId: '3888',
  });
  assert.equal(redundantClear.changed, true);
  assert.equal(redundantClear.effectiveChanged, false);

  const absentClear = await fixture.service.clearAgentBehavior('1001', {
    scope: 'channel',
    channelId: '3999',
  });
  assert.equal(absentClear.changed, false);
  assert.equal(absentClear.revision, redundantClear.revision);
  assert.equal(writes, afterFirstWrites + 2);

  await fixture.service.setAgentBehavior('1001', {
    scope: 'channel',
    channelId: '3001',
    content: 'Channel behavior',
    updatedByUserId: '2001',
  });
  const serverClear = await fixture.service.clearAgentBehavior('1001', { scope: 'server' });
  assert.equal(serverClear.changed, true);
  assert.equal(serverClear.source, 'built-in');
  assert.deepEqual(serverClear.channelOverrideIds, ['3001']);

  const channelExport = await fixture.service.exportAgentBehavior('1001', {
    scope: 'channel',
    channelId: '3001',
  });
  assert.equal(channelExport.source, 'channel');
  assert.equal(channelExport.content, 'Channel behavior');
  assert.equal(channelExport.updatedByUserId, '2001');
  assert.equal(Object.isFrozen(channelExport), true);

  const serverStatus = await fixture.service.getAgentBehaviorStatus('1001', { scope: 'server' });
  assert.equal(serverStatus.source, 'built-in');
  assert.equal(Object.hasOwn(serverStatus, 'content'), false);
  assert.deepEqual(serverStatus.channelOverrideIds, ['3001']);
});

test('agent behavior mutations require a stored configured guild while reads allow fallback', async (t) => {
  const fixture = await createFixture({
    env: {
      ALLOW_LEGACY_GUILD_CONFIG: 'true',
      DEEPSEEK_API_KEY: 'legacy-secret',
    },
  });
  t.after(fixture.cleanup);

  const fallbackStatus = await fixture.service.getAgentBehaviorStatus('1001', { scope: 'server' });
  const fallbackExport = await fixture.service.exportAgentBehavior('1001', {
    scope: 'channel',
    channelId: '3001',
  });
  assert.equal(fallbackStatus.source, 'built-in');
  assert.equal(fallbackStatus.revision, 0);
  assert.equal(fallbackExport.source, 'built-in');
  assert.ok(fallbackExport.content.includes('You are an AI assistant for this Discord server.'));
  assert.equal(JSON.stringify(fallbackStatus).includes('legacy-secret'), false);
  assert.equal(JSON.stringify(fallbackExport).includes('legacy-secret'), false);

  for (const operation of [
    () => fixture.service.setAgentBehavior('1001', {
      scope: 'server',
      content: 'No implicit setup',
      updatedByUserId: '2001',
    }),
    () => fixture.service.clearAgentBehavior('1001', { scope: 'server' }),
  ]) {
    await assert.rejects(operation(), /not configured/i);
  }
  assert.equal(await fixture.service.getStoredConfig('1001'), null);

  await fixture.service.resetGuild('1002', '2001');
  const tombstone = await fixture.service.getStoredConfig('1002');
  for (const operation of [
    () => fixture.service.setAgentBehavior('1002', {
      scope: 'channel',
      channelId: '3002',
      content: 'No tombstone mutation',
      updatedByUserId: '2001',
    }),
    () => fixture.service.clearAgentBehavior('1002', {
      scope: 'channel',
      channelId: '3002',
    }),
  ]) {
    await assert.rejects(operation(), /not configured/i);
  }
  assert.deepEqual(await fixture.service.getStoredConfig('1002'), tombstone);
});

test('trigger words are validated, persisted idempotently, exposed safely, and reset to AI', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  assert.deepEqual(await fixture.service.getInvocationConfig('1001'), {
    guildId: '1001',
    triggerWord: 'AI',
    source: 'default',
    revision: 0,
  });
  await assert.rejects(
    fixture.service.setTriggerWord('1001', 'llm', '2001'),
    /not configured/i,
  );

  await fixture.service.configureGuild('1001', {
    configuredByUserId: '2001',
    setupChannelId: '3001',
    deepseekApiKey: 'stored-deepseek',
    webSearchEnabled: false,
  });
  const first = await fixture.service.setTriggerWord('1001', 'llm-bot', '2001');
  const second = await fixture.service.setTriggerWord('1001', 'llm-bot', '2001');
  const invocation = await fixture.service.getInvocationConfig('1001');

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.revision, first.revision);
  assert.deepEqual(invocation, {
    guildId: '1001',
    triggerWord: 'llm-bot',
    source: 'stored',
    revision: first.revision,
  });
  assert.equal(Object.isFrozen(invocation), true);

  for (const invalid of ['', 'two words', '💥', 'a'.repeat(25)]) {
    await assert.rejects(
      fixture.service.setTriggerWord('1001', invalid, '2001'),
      /trigger/i,
    );
  }

  await fixture.service.setAgentBehavior('1001', {
    scope: 'server',
    content: 'Temporary custom behavior',
    updatedByUserId: '2001',
  });
  const tombstone = await fixture.service.resetGuild('1001', '2001');
  assert.equal(tombstone.invocation.triggerWord, 'AI');
  assert.deepEqual(tombstone.agent, { server: null, channels: {} });
});
