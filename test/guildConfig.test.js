const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const test = require('node:test');
const {
  createDefaultGuildConfig,
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

  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.guilds['1001'].schemaVersion, 1);
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
  assert.throws(() => normalizeGuildConfigDocument({ schemaVersion: 2, guilds: {} }), /newer/);
  assert.throws(() => normalizeGuildConfigDocument({ guilds: [] }), /guilds must be an object/);
  assert.throws(
    () => normalizeGuildConfig('1001', { guildId: '1002', configured: false }),
    /does not match/,
  );
  assert.throws(
    () => normalizeGuildConfig('1001', { schemaVersion: 2, guildId: '1001' }),
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
  assert.deepEqual(runtime, { guildId: '1001', configured: false, source: 'tombstone' });
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
