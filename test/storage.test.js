'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ConfigEncryptionError,
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
  validateEncryptedSecret,
} = require('../src/storage/crypto');
const {
  GuildConfigStore,
  createDefaultGuildConfig,
  isGuildConfigured,
  normalizeGuildConfig,
} = require('../src/storage/guildConfigStore');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createFileSystem(overrides = {}) {
  return {
    mkdir: (...args) => fs.mkdir(...args),
    open: (...args) => fs.open(...args),
    readFile: (...args) => fs.readFile(...args),
    rename: (...args) => fs.rename(...args),
    unlink: (...args) => fs.unlink(...args),
    ...overrides,
  };
}

async function createTemporaryStore(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-guild-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'guild-config.json');
  const encryptionKey = options.encryptionKey || randomBytes(32);
  const store = new GuildConfigStore({
    filePath,
    encryptionKey,
    fileSystem: options.fileSystem,
    now: options.now,
  });
  return { directory, encryptionKey, filePath, store };
}

test('encryption keys accept 64 hex characters or base64-encoded 32-byte values', () => {
  const key = randomBytes(32);

  assert.deepEqual(parseEncryptionKey(key.toString('hex')), key);
  assert.deepEqual(parseEncryptionKey(key.toString('base64')), key);
  assert.deepEqual(parseEncryptionKey(key), key);

  assert.throws(
    () => parseEncryptionKey('too-short'),
    (error) => error instanceof ConfigEncryptionError
      && error.code === 'CONFIG_ENCRYPTION_KEY_INVALID'
      && !error.message.includes('too-short'),
  );
  assert.throws(
    () => parseEncryptionKey(''),
    (error) => error instanceof ConfigEncryptionError
      && error.code === 'CONFIG_ENCRYPTION_KEY_MISSING',
  );
});

test('AES-GCM binds encrypted secrets to the guild ID', () => {
  const encryptionKey = randomBytes(32);
  const plaintext = 'sk-private-value-for-one-guild';
  const encrypted = encryptSecret(plaintext, 'guild-one', encryptionKey);

  assert.notEqual(encrypted, plaintext);
  assert.equal(decryptSecret(encrypted, 'guild-one', encryptionKey), plaintext);
  assert.equal(validateEncryptedSecret(encrypted, 'guild-one', encryptionKey), true);
  assert.throws(
    () => decryptSecret(encrypted, 'guild-two', encryptionKey),
    (error) => error instanceof ConfigEncryptionError
      && error.code === 'CONFIG_DECRYPTION_FAILED'
      && !error.message.includes(plaintext),
  );
});

test('default configurations are complete, independent, and not ready', async (t) => {
  const { store } = await createTemporaryStore(t);
  const expected = createDefaultGuildConfig();
  const first = await store.get('guild-defaults');
  const second = await store.get('guild-defaults');

  assert.deepEqual(first, expected);
  assert.equal(isGuildConfigured(first), false);
  first.persona.characterName = 'mutated outside the store';
  first.access.channelIds.push('channel-outside');
  assert.deepEqual(second, expected);
  assert.deepEqual(await store.get('guild-defaults'), expected);
});

test('validated patches persist atomically and reads are deep clones', async (t) => {
  const fixedDate = new Date('2026-07-09T12:00:00.000Z');
  const { encryptionKey, filePath, store } = await createTemporaryStore(t, {
    now: () => fixedDate,
  });
  const behavior = 'Always answer truthfully, stay playful, be confident, and keep the conversation engaging. '
    + 'Never pretend that guesses are proven facts.';

  const updated = await store.update('guild-persisted', {
    persona: {
      name: 'Orbit',
      behavior,
      profanity: 'strict',
      textStyle: 'underline',
      responseFormat: 'embed',
    },
    access: {
      channelIds: ['channel-one'],
      allowedRoleIds: ['role-allowed'],
      blockedRoleIds: ['role-blocked'],
    },
    advanced: {
      webSearchMode: 'on_request',
      responseLength: 'detailed',
      contextMessages: 20,
      cooldownSeconds: 15,
    },
  }, 'admin-user');

  assert.equal(updated.persona.characterName, 'Orbit');
  assert.equal(Object.hasOwn(updated.persona, 'name'), false);
  assert.equal(updated.updatedAt, fixedDate.toISOString());
  assert.equal(updated.updatedBy, 'admin-user');

  updated.persona.behavior = 'outside mutation';
  assert.equal((await store.get('guild-persisted')).persona.behavior, behavior);

  const reloaded = new GuildConfigStore({ filePath, encryptionKey });
  const persisted = await reloaded.get('guild-persisted');
  assert.equal(persisted.persona.characterName, 'Orbit');
  assert.deepEqual(persisted.access.channelIds, ['channel-one']);
  assert.equal(persisted.advanced.cooldownSeconds, 15);

  const beforeInvalidUpdate = await fs.readFile(filePath, 'utf8');
  assert.equal(beforeInvalidUpdate, `${JSON.stringify(JSON.parse(beforeInvalidUpdate))}\n`);
  await assert.rejects(
    store.update('guild-persisted', { persona: { behavior: 'too short' } }),
    (error) => error.code === 'GUILD_CONFIG_INVALID',
  );
  await assert.rejects(
    store.update('guild-persisted', { isAdmin: true }),
    (error) => error.code === 'GUILD_CONFIG_INVALID',
  );
  assert.equal(await fs.readFile(filePath, 'utf8'), beforeInvalidUpdate);
});

test('API keys are never persisted as plaintext and survive store reloads', async (t) => {
  const { encryptionKey, filePath, store } = await createTemporaryStore(t);
  const apiKey = `sk-deepseek-${randomBytes(20).toString('hex')}`;

  const config = await store.setApiKey('guild-secret', apiKey, 'valid', 'admin-user');
  const fileContents = await fs.readFile(filePath, 'utf8');

  assert.equal(await store.hasApiKey('guild-secret'), true);
  assert.equal(await store.getApiKey('guild-secret'), apiKey);
  assert.deepEqual(await store.getApiKeySnapshot('guild-secret'), {
    apiKey,
    fingerprint: config.provider.fingerprint,
    keyStatus: 'valid',
  });
  assert.equal(fileContents.includes(apiKey), false);
  assert.match(config.provider.encryptedKey, /^v1\./);
  assert.match(config.provider.fingerprint, /^sha256:[a-f0-9]{16}$/);
  assert.equal(config.provider.keyStatus, 'valid');
  assert.notEqual(config.provider.checkedAt, null);
  assert.equal(config.updatedBy, 'admin-user');

  const reloaded = new GuildConfigStore({ filePath, encryptionKey });
  assert.equal(await reloaded.validateStoredApiKeys(), 1);
  assert.equal(await reloaded.getApiKey('guild-secret'), apiKey);

  const cleared = await reloaded.clearApiKey('guild-secret');
  assert.equal(cleared.provider.encryptedKey, null);
  assert.equal(cleared.provider.fingerprint, null);
  assert.equal(cleared.provider.keyStatus, 'unchecked');
  assert.equal(await reloaded.hasApiKey('guild-secret'), false);
  assert.equal(await reloaded.getApiKey('guild-secret'), null);
});

test('missing or bad encryption settings only block operations that need encryption', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'discord-guild-config-no-key-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'guild-config.json');
  const store = new GuildConfigStore({ filePath, encryptionKey: 'bad-key' });

  const saved = await store.update('guild-no-key', {
    access: { channelIds: ['channel-one'] },
  });
  assert.deepEqual(saved.access.channelIds, ['channel-one']);
  assert.equal(await store.hasApiKey('guild-no-key'), false);
  assert.equal(await store.getApiKey('guild-no-key'), null);

  assert.throws(
    () => store.setApiKey('guild-no-key', 'sk-will-not-be-written'),
    (error) => error instanceof ConfigEncryptionError
      && error.code === 'CONFIG_ENCRYPTION_KEY_INVALID',
  );
  assert.equal((await fs.readFile(filePath, 'utf8')).includes('sk-will-not-be-written'), false);
});

test('readiness requires persona, channel access, and a stored encrypted API key', async (t) => {
  const { store } = await createTemporaryStore(t);
  const behavior = 'Be energetic and entertaining while remaining accurate and transparent about uncertainty. '
    + 'Stay in character without inventing factual claims.';

  await store.update('guild-ready', {
    persona: {
      characterName: 'Nova',
      behavior,
    },
    access: {
      channelIds: ['channel-one'],
    },
  });
  assert.equal(isGuildConfigured(await store.get('guild-ready')), false);

  await store.setApiKey('guild-ready', 'sk-ready-key', 'unchecked');
  assert.equal(isGuildConfigured(await store.get('guild-ready')), true);

  await store.setApiKey('guild-ready', 'sk-no-balance-key', 'no_balance');
  assert.equal(isGuildConfigured(await store.get('guild-ready')), true);
});

test('normalization fills missing fields and rejects unsupported option values', () => {
  const normalized = normalizeGuildConfig({
    persona: { name: 'Assistant' },
  });
  assert.equal(normalized.persona.characterName, 'Assistant');
  assert.equal(normalized.persona.triggerWord, 'AI');
  assert.deepEqual(normalized.access.channelIds, []);

  assert.throws(
    () => normalizeGuildConfig({ advanced: { contextMessages: 7 } }),
    (error) => error.code === 'GUILD_CONFIG_INVALID',
  );
  assert.throws(
    () => normalizeGuildConfig({ persona: { profanity: 'anything-goes' } }),
    (error) => error.code === 'GUILD_CONFIG_INVALID',
  );
});

test('updater functions, setup metadata, and guild deletion use the same persistent store', async (t) => {
  const { encryptionKey, filePath, store } = await createTemporaryStore(t);

  const changed = await store.update('guild-lifecycle', (draft) => {
    draft.advanced.contextMessages = 5;
    draft.advanced.cooldownSeconds = 30;
  }, 'admin-lifecycle');
  assert.equal(changed.advanced.contextMessages, 5);
  assert.equal(changed.updatedBy, 'admin-lifecycle');

  const withSetup = await store.setSetupMessage(
    'guild-lifecycle',
    'setup-channel',
    'setup-message',
  );
  assert.deepEqual(withSetup.setup, {
    channelId: 'setup-channel',
    messageId: 'setup-message',
  });

  const reloaded = new GuildConfigStore({ filePath, encryptionKey });
  assert.equal((await reloaded.get('guild-lifecycle')).advanced.cooldownSeconds, 30);
  assert.equal(await reloaded.delete('guild-lifecycle'), true);
  assert.equal(await reloaded.delete('guild-lifecycle'), false);
  assert.deepEqual(await reloaded.get('guild-lifecycle'), createDefaultGuildConfig());
});

test('concurrent mutations execute in FIFO order without losing updates', async (t) => {
  const { encryptionKey, filePath, store } = await createTemporaryStore(t);
  const observations = [];

  const firstUpdate = store.update('guild-concurrent', (draft) => {
    observations.push(['first', draft.advanced.contextMessages]);
    draft.advanced.contextMessages = 5;
  });
  const secondUpdate = store.update('guild-concurrent', (draft) => {
    observations.push(['second', draft.advanced.contextMessages]);
    draft.advanced.cooldownSeconds = 30;
  });
  const setupUpdate = store.setSetupMessage(
    'guild-concurrent',
    'concurrent-channel',
    'concurrent-message',
  );

  const [first, second, withSetup] = await Promise.all([
    firstUpdate,
    secondUpdate,
    setupUpdate,
  ]);

  assert.deepEqual(observations, [['first', 10], ['second', 5]]);
  assert.equal(first.advanced.contextMessages, 5);
  assert.equal(first.advanced.cooldownSeconds, 0);
  assert.equal(second.advanced.contextMessages, 5);
  assert.equal(second.advanced.cooldownSeconds, 30);
  assert.deepEqual(withSetup.setup, {
    channelId: 'concurrent-channel',
    messageId: 'concurrent-message',
  });

  const reloaded = new GuildConfigStore({ filePath, encryptionKey });
  const persisted = await reloaded.get('guild-concurrent');
  assert.equal(persisted.advanced.contextMessages, 5);
  assert.equal(persisted.advanced.cooldownSeconds, 30);
  assert.deepEqual(persisted.setup, withSetup.setup);
});

test('a failed atomic rename leaves committed state intact and does not poison later writes', async (t) => {
  let failNextRename = false;
  const fileSystem = createFileSystem({
    async rename(...args) {
      if (failNextRename) {
        failNextRename = false;
        const error = new Error('Simulated atomic rename failure.');
        error.code = 'SIMULATED_RENAME_FAILURE';
        throw error;
      }
      return fs.rename(...args);
    },
  });
  const { directory, filePath, store } = await createTemporaryStore(t, { fileSystem });
  await store.update('guild-recovery', { access: { channelIds: ['channel-before'] } });
  const beforeFailure = await fs.readFile(filePath, 'utf8');
  const apiKey = `sk-failed-${randomBytes(20).toString('hex')}`;

  failNextRename = true;
  await assert.rejects(
    store.setApiKey('guild-recovery', apiKey, 'valid'),
    (error) => error.code === 'SIMULATED_RENAME_FAILURE',
  );

  assert.equal(await fs.readFile(filePath, 'utf8'), beforeFailure);
  assert.equal(await store.hasApiKey('guild-recovery'), false);
  assert.equal((await fs.readFile(filePath, 'utf8')).includes(apiKey), false);
  assert.deepEqual(
    (await fs.readdir(directory)).filter((name) => name.endsWith('.tmp')),
    [],
  );

  const recovered = await store.update('guild-recovery', {
    advanced: { cooldownSeconds: 30 },
  });
  assert.equal(recovered.advanced.cooldownSeconds, 30);
  assert.deepEqual(recovered.access.channelIds, ['channel-before']);
  assert.equal(recovered.provider.encryptedKey, null);
});

test('durable file synchronization does not block the event loop', async (t) => {
  const syncStarted = createDeferred();
  const releaseSync = createDeferred();
  let wrappedHandle = false;
  const fileSystem = createFileSystem({
    async open(...args) {
      const handle = await fs.open(...args);
      if (wrappedHandle) {
        return handle;
      }
      wrappedHandle = true;
      return {
        close: handle.close.bind(handle),
        async sync() {
          syncStarted.resolve();
          await releaseSync.promise;
          await handle.sync();
        },
        writeFile: handle.writeFile.bind(handle),
      };
    },
  });
  const { store } = await createTemporaryStore(t, { fileSystem });
  let updateSettled = false;
  const pendingUpdate = store.update('guild-nonblocking', {
    access: { channelIds: ['channel-one'] },
  });
  pendingUpdate.then(
    () => { updateSettled = true; },
    () => { updateSettled = true; },
  );

  await syncStarted.promise;
  let eventLoopTurnRan = false;
  await new Promise((resolve) => {
    setImmediate(() => {
      eventLoopTurnRan = true;
      resolve();
    });
  });
  const settledBeforeRelease = updateSettled;
  releaseSync.resolve();
  await pendingUpdate;

  assert.equal(eventLoopTurnRan, true);
  assert.equal(settledBeforeRelease, false);
});

test('no-op updates and absent deletes do not write the configuration file', async (t) => {
  let renameCount = 0;
  const fileSystem = createFileSystem({
    async rename(...args) {
      renameCount += 1;
      return fs.rename(...args);
    },
  });
  const { store } = await createTemporaryStore(t, { fileSystem });

  assert.equal(await store.delete('guild-no-op'), false);
  assert.equal(renameCount, 0);

  const created = await store.update('guild-no-op', {
    access: { channelIds: ['channel-one'] },
  });
  assert.equal(renameCount, 1);

  const unchanged = await store.update('guild-no-op', {
    access: { channelIds: ['channel-one'] },
  });
  assert.equal(renameCount, 1);
  assert.equal(unchanged.updatedAt, created.updatedAt);

  assert.equal(await store.delete('guild-no-op'), true);
  assert.equal(renameCount, 2);
  assert.equal(await store.delete('guild-no-op'), false);
  assert.equal(renameCount, 2);
});
