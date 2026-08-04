'use strict';

const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  ConfigEncryptionError,
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
  validateEncryptedSecret,
} = require('./crypto');

const PROFANITY_VALUES = new Set(['strict', 'casual', 'unfiltered']);
const TEXT_STYLE_VALUES = new Set([
  'normal',
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'spoiler',
  'codeblock',
]);
const RESPONSE_FORMAT_VALUES = new Set(['text', 'embed']);
const WEB_SEARCH_MODE_VALUES = new Set(['off', 'on_request', 'automatic']);
const RESPONSE_LENGTH_VALUES = new Set(['brief', 'balanced', 'detailed']);
const CONTEXT_MESSAGE_VALUES = new Set([0, 5, 10, 20]);
const COOLDOWN_VALUES = new Set([0, 5, 15, 30]);
const KEY_STATUS_VALUES = new Set(['unchecked', 'valid', 'no_balance']);

const SCHEMA_KEYS = Object.freeze({
  root: new Set(['persona', 'access', 'provider', 'advanced', 'setup', 'updatedAt', 'updatedBy']),
  persona: new Set([
    'characterName',
    'name', // Accepted as an input alias; never emitted or persisted.
    'behavior',
    'customPrompt',
    'triggerWord',
    'profanity',
    'textStyle',
    'responseFormat',
  ]),
  access: new Set(['channelIds', 'allowedRoleIds', 'blockedRoleIds']),
  provider: new Set(['encryptedKey', 'keyStatus', 'checkedAt', 'fingerprint']),
  advanced: new Set(['webSearchMode', 'responseLength', 'contextMessages', 'cooldownSeconds']),
  setup: new Set(['channelId', 'messageId']),
});

const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ENCRYPTED_KEY_PATTERN = /^v1\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{16}$/;

function createDefaultGuildConfig() {
  return {
    persona: {
      characterName: '',
      behavior: '',
      customPrompt: '',
      triggerWord: 'AI',
      profanity: 'casual',
      textStyle: 'normal',
      responseFormat: 'text',
    },
    access: {
      channelIds: [],
      allowedRoleIds: [],
      blockedRoleIds: [],
    },
    provider: {
      encryptedKey: null,
      keyStatus: 'unchecked',
      checkedAt: null,
      fingerprint: null,
    },
    advanced: {
      webSearchMode: 'off',
      responseLength: 'balanced',
      contextMessages: 10,
      cooldownSeconds: 0,
    },
    setup: {
      channelId: null,
      messageId: null,
    },
    updatedAt: null,
    updatedBy: null,
  };
}

function cloneGuildConfig(config) {
  return {
    persona: { ...config.persona },
    access: {
      channelIds: [...config.access.channelIds],
      allowedRoleIds: [...config.access.allowedRoleIds],
      blockedRoleIds: [...config.access.blockedRoleIds],
    },
    provider: { ...config.provider },
    advanced: { ...config.advanced },
    setup: { ...config.setup },
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
  };
}

function deepClone(value) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError('Value is not JSON-compatible.');
    }
    return JSON.parse(serialized);
  } catch (error) {
    if (error && error.code === 'GUILD_CONFIG_INVALID') {
      throw error;
    }
    throw validationError('Guild configuration values must be JSON-compatible.');
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validationError(message) {
  const error = new TypeError(message);
  error.code = 'GUILD_CONFIG_INVALID';
  return error;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw validationError(`${label} must be an object.`);
  }
  return value;
}

function assertKnownKeys(value, allowedKeys, label) {
  for (const key of Object.keys(value)) {
    if (DANGEROUS_OBJECT_KEYS.has(key) || !allowedKeys.has(key)) {
      throw validationError(`${label} contains an unsupported field: ${key}.`);
    }
  }
}

function validateString(value, label, { min = 0, max, trim = true } = {}) {
  if (typeof value !== 'string') {
    throw validationError(`${label} must be a string.`);
  }

  const normalized = trim ? value.trim() : value;
  if (normalized.length < min || (max !== undefined && normalized.length > max)) {
    const range = min > 0 ? `between ${min} and ${max}` : `at most ${max}`;
    throw validationError(`${label} must be ${range} characters long.`);
  }

  return normalized;
}

function validateOptionalDate(value, label) {
  if (value === null) {
    return null;
  }

  const normalized = validateString(value, label, { min: 1, max: 64 });
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== normalized) {
    throw validationError(`${label} must be an ISO-8601 timestamp or null.`);
  }
  return normalized;
}

function validateId(value, label, { nullable = false } = {}) {
  if (nullable && value === null) {
    return null;
  }

  const id = validateString(value, label, { min: 1, max: 128 });
  if (DANGEROUS_OBJECT_KEYS.has(id)) {
    throw validationError(`${label} is invalid.`);
  }
  return id;
}

function validateIdArray(value, label) {
  if (!Array.isArray(value) || value.length > 100) {
    throw validationError(`${label} must be an array containing at most 100 IDs.`);
  }

  const ids = value.map((id, index) => validateId(id, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) {
    throw validationError(`${label} cannot contain duplicate IDs.`);
  }
  return ids;
}

function validateEnum(value, allowedValues, label) {
  if (!allowedValues.has(value)) {
    throw validationError(`${label} has an unsupported value.`);
  }
  return value;
}

function normalizePersona(input, defaults) {
  const persona = requirePlainObject(input, 'persona');
  assertKnownKeys(persona, SCHEMA_KEYS.persona, 'persona');

  // `name` is a compatibility alias for older callers. When it is present it
  // intentionally wins over a characterName inherited through a deep patch.
  const characterName = persona.name ?? persona.characterName ?? defaults.characterName;
  const behavior = validateString(persona.behavior ?? defaults.behavior, 'persona.behavior', {
    max: 1500,
    trim: true,
  });
  if (behavior.length > 0 && behavior.length < 100) {
    throw validationError('persona.behavior must be empty or at least 100 characters long.');
  }

  return {
    characterName: validateString(characterName, 'persona.characterName', { max: 80 }),
    behavior,
    customPrompt: validateString(persona.customPrompt ?? defaults.customPrompt, 'persona.customPrompt', {
      max: 2000,
      trim: true,
    }),
    triggerWord: validateString(persona.triggerWord ?? defaults.triggerWord, 'persona.triggerWord', {
      min: 1,
      max: 32,
    }),
    profanity: validateEnum(persona.profanity ?? defaults.profanity, PROFANITY_VALUES, 'persona.profanity'),
    textStyle: validateEnum(persona.textStyle ?? defaults.textStyle, TEXT_STYLE_VALUES, 'persona.textStyle'),
    responseFormat: validateEnum(
      persona.responseFormat ?? defaults.responseFormat,
      RESPONSE_FORMAT_VALUES,
      'persona.responseFormat',
    ),
  };
}

function normalizeAccess(input, defaults) {
  const access = requirePlainObject(input, 'access');
  assertKnownKeys(access, SCHEMA_KEYS.access, 'access');
  return {
    channelIds: validateIdArray(access.channelIds ?? defaults.channelIds, 'access.channelIds'),
    allowedRoleIds: validateIdArray(access.allowedRoleIds ?? defaults.allowedRoleIds, 'access.allowedRoleIds'),
    blockedRoleIds: validateIdArray(access.blockedRoleIds ?? defaults.blockedRoleIds, 'access.blockedRoleIds'),
  };
}

function normalizeProvider(input, defaults) {
  const provider = requirePlainObject(input, 'provider');
  assertKnownKeys(provider, SCHEMA_KEYS.provider, 'provider');

  const encryptedKey = provider.encryptedKey ?? defaults.encryptedKey;
  if (encryptedKey !== null
    && (typeof encryptedKey !== 'string' || !ENCRYPTED_KEY_PATTERN.test(encryptedKey))) {
    throw validationError('provider.encryptedKey must contain an encrypted key payload or null.');
  }

  const fingerprint = provider.fingerprint ?? defaults.fingerprint;
  if (fingerprint !== null
    && (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint))) {
    throw validationError('provider.fingerprint must contain a safe key fingerprint or null.');
  }

  return {
    encryptedKey,
    keyStatus: validateEnum(provider.keyStatus ?? defaults.keyStatus, KEY_STATUS_VALUES, 'provider.keyStatus'),
    checkedAt: validateOptionalDate(provider.checkedAt ?? defaults.checkedAt, 'provider.checkedAt'),
    fingerprint,
  };
}

function normalizeAdvanced(input, defaults) {
  const advanced = requirePlainObject(input, 'advanced');
  assertKnownKeys(advanced, SCHEMA_KEYS.advanced, 'advanced');
  return {
    webSearchMode: validateEnum(
      advanced.webSearchMode ?? defaults.webSearchMode,
      WEB_SEARCH_MODE_VALUES,
      'advanced.webSearchMode',
    ),
    responseLength: validateEnum(
      advanced.responseLength ?? defaults.responseLength,
      RESPONSE_LENGTH_VALUES,
      'advanced.responseLength',
    ),
    contextMessages: validateEnum(
      advanced.contextMessages ?? defaults.contextMessages,
      CONTEXT_MESSAGE_VALUES,
      'advanced.contextMessages',
    ),
    cooldownSeconds: validateEnum(
      advanced.cooldownSeconds ?? defaults.cooldownSeconds,
      COOLDOWN_VALUES,
      'advanced.cooldownSeconds',
    ),
  };
}

function normalizeSetup(input, defaults) {
  const setup = requirePlainObject(input, 'setup');
  assertKnownKeys(setup, SCHEMA_KEYS.setup, 'setup');
  return {
    channelId: validateId(setup.channelId ?? defaults.channelId, 'setup.channelId', { nullable: true }),
    messageId: validateId(setup.messageId ?? defaults.messageId, 'setup.messageId', { nullable: true }),
  };
}

function normalizeGuildConfig(input = {}) {
  const config = requirePlainObject(input, 'Guild configuration');
  assertKnownKeys(config, SCHEMA_KEYS.root, 'Guild configuration');
  const defaults = createDefaultGuildConfig();

  return {
    persona: normalizePersona(config.persona ?? defaults.persona, defaults.persona),
    access: normalizeAccess(config.access ?? defaults.access, defaults.access),
    provider: normalizeProvider(config.provider ?? defaults.provider, defaults.provider),
    advanced: normalizeAdvanced(config.advanced ?? defaults.advanced, defaults.advanced),
    setup: normalizeSetup(config.setup ?? defaults.setup, defaults.setup),
    updatedAt: validateOptionalDate(config.updatedAt ?? defaults.updatedAt, 'updatedAt'),
    updatedBy: validateId(config.updatedBy ?? defaults.updatedBy, 'updatedBy', { nullable: true }),
  };
}

function isNormalizedGuildConfigReady(config) {
  return typeof config?.persona?.characterName === 'string'
    && config.persona.characterName.length > 0
    && typeof config.persona.behavior === 'string'
    && config.persona.behavior.length >= 100
    && Array.isArray(config?.access?.channelIds)
    && config.access.channelIds.length > 0
    && typeof config?.provider?.encryptedKey === 'string'
    && ENCRYPTED_KEY_PATTERN.test(config.provider.encryptedKey);
}

function isGuildConfigured(input) {
  try {
    return isNormalizedGuildConfigReady(normalizeGuildConfig(input));
  } catch {
    return false;
  }
}

function mergeObjects(base, patch, ancestors = new WeakSet()) {
  if (!isPlainObject(patch)) {
    throw validationError('Guild configuration updates must be objects.');
  }
  if (ancestors.has(patch)) {
    throw validationError('Guild configuration updates cannot contain circular references.');
  }

  ancestors.add(patch);
  const output = deepClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (DANGEROUS_OBJECT_KEYS.has(key)) {
      throw validationError(`Guild configuration contains an unsupported field: ${key}.`);
    }

    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = mergeObjects(output[key], value, ancestors);
    } else {
      output[key] = deepClone(value);
    }
  }
  ancestors.delete(patch);
  return output;
}

function normalizeGuildId(guildId) {
  return validateId(guildId, 'guildId');
}

function normalizeUpdatedBy(updatedBy) {
  if (updatedBy === undefined || updatedBy === null) {
    return null;
  }
  return validateId(updatedBy, 'updatedBy');
}

function makeFingerprint(apiKey) {
  return `sha256:${createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 16)}`;
}

class GuildConfigStore {
  constructor(options = {}, legacyOptions = {}) {
    const normalizedOptions = typeof options === 'string'
      ? { ...legacyOptions, filePath: options }
      : options;
    requirePlainObject(normalizedOptions, 'GuildConfigStore options');

    const configuredPath = normalizedOptions.filePath
      || normalizedOptions.path
      || process.env.GUILD_CONFIG_PATH
      || path.join(process.cwd(), 'data', 'guild-config.json');

    this.filePath = path.resolve(configuredPath);
    this.encryptionKey = normalizedOptions.encryptionKey;
    this._fileSystem = normalizedOptions.fileSystem || fs;
    this._now = typeof normalizedOptions.now === 'function'
      ? normalizedOptions.now
      : () => new Date();
    this._guilds = Object.create(null);
    this._loaded = false;
    this._loadPromise = null;
    this._mutationTail = Promise.resolve();
  }

  _timestamp() {
    const value = this._now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw validationError('The GuildConfigStore clock returned an invalid date.');
    }
    return date.toISOString();
  }

  async _load() {
    let raw;
    try {
      raw = await this._fileSystem.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this._loaded = true;
        return;
      }
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const wrapped = new Error('The guild configuration file contains invalid JSON.', { cause: error });
      wrapped.code = 'GUILD_CONFIG_FILE_INVALID';
      throw wrapped;
    }

    if (!isPlainObject(parsed)) {
      const error = new Error('The guild configuration file must contain an object.');
      error.code = 'GUILD_CONFIG_FILE_INVALID';
      throw error;
    }

    const loadedGuilds = Object.create(null);
    for (const [guildId, config] of Object.entries(parsed)) {
      const normalizedGuildId = normalizeGuildId(guildId);
      loadedGuilds[normalizedGuildId] = normalizeGuildConfig(config);
    }

    this._guilds = loadedGuilds;
    this._loaded = true;
  }

  _ensureLoaded() {
    if (this._loaded) {
      return Promise.resolve();
    }

    if (!this._loadPromise) {
      const pendingLoad = this._load().catch((error) => {
        if (this._loadPromise === pendingLoad) {
          this._loadPromise = null;
        }
        throw error;
      });
      this._loadPromise = pendingLoad;
    }
    return this._loadPromise;
  }

  _enqueueMutation(operation) {
    const result = this._mutationTail.then(async () => {
      await this._ensureLoaded();
      return operation();
    });
    this._mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async _persist(guilds) {
    const directory = path.dirname(this.filePath);
    await this._fileSystem.mkdir(directory, { recursive: true });

    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
    );
    const contents = `${JSON.stringify(guilds)}\n`;
    let handle = null;

    try {
      handle = await this._fileSystem.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await this._fileSystem.rename(temporaryPath, this.filePath);
      if (this._fileSystem === fs) {
        let directoryHandle;
        try {
          directoryHandle = await fs.open(directory, 'r');
          await directoryHandle.sync();
        } catch {
          // Some platforms (notably Windows) do not permit directory handles.
        } finally {
          await directoryHandle?.close().catch(() => null);
        }
      }
    } catch (error) {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          // Preserve the original persistence error.
        }
      }
      try {
        await this._fileSystem.unlink(temporaryPath);
      } catch (cleanupError) {
        if (!cleanupError || cleanupError.code !== 'ENOENT') {
          // Preserve the original persistence error.
        }
      }
      throw error;
    }
  }

  async get(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    await this._ensureLoaded();
    return cloneGuildConfig(this._guilds[normalizedGuildId] || createDefaultGuildConfig());
  }

  _update(guildId, updaterOrPatch, updatedBy) {
    return this._enqueueMutation(async () => {
      const current = this._guilds[guildId] || createDefaultGuildConfig();
      let candidate;

      if (typeof updaterOrPatch === 'function') {
        const draft = cloneGuildConfig(current);
        const result = updaterOrPatch(draft);
        if (result && typeof result.then === 'function') {
          throw validationError('Guild configuration updater functions must be synchronous.');
        }
        candidate = result === undefined ? draft : mergeObjects(draft, result);
      } else {
        candidate = mergeObjects(current, updaterOrPatch);
      }

      const unchangedCandidate = normalizeGuildConfig(candidate);
      if (JSON.stringify(unchangedCandidate) === JSON.stringify(current)) {
        return cloneGuildConfig(current);
      }

      candidate.updatedAt = this._timestamp();
      candidate.updatedBy = normalizeUpdatedBy(updatedBy);
      const normalized = normalizeGuildConfig(candidate);
      const nextGuilds = Object.assign(Object.create(null), this._guilds);
      nextGuilds[guildId] = normalized;
      await this._persist(nextGuilds);
      this._guilds = nextGuilds;
      return cloneGuildConfig(normalized);
    });
  }

  update(guildId, updaterOrPatch, updatedBy) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (typeof updaterOrPatch !== 'function' && !isPlainObject(updaterOrPatch)) {
      throw validationError('Guild configuration updates must be an object or updater function.');
    }
    const actorId = normalizeUpdatedBy(updatedBy);
    const queuedUpdate = typeof updaterOrPatch === 'function'
      ? updaterOrPatch
      : deepClone(updaterOrPatch);
    return this._update(normalizedGuildId, queuedUpdate, actorId);
  }

  setApiKey(guildId, apiKey, status = 'unchecked', updatedBy) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedKey = validateString(apiKey, 'apiKey', { min: 1, max: 4096 });
    const normalizedStatus = validateEnum(status, KEY_STATUS_VALUES, 'provider.keyStatus');
    const actorId = normalizeUpdatedBy(updatedBy);
    const encryptedKey = encryptSecret(normalizedKey, normalizedGuildId, this.encryptionKey);
    const checkedAt = normalizedStatus === 'unchecked' ? null : this._timestamp();

    return this._update(normalizedGuildId, {
      provider: {
        encryptedKey,
        keyStatus: normalizedStatus,
        checkedAt,
        fingerprint: makeFingerprint(normalizedKey),
      },
    }, actorId);
  }

  async getApiKey(guildId) {
    return (await this.getApiKeySnapshot(guildId)).apiKey;
  }

  async getApiKeySnapshot(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    await this._ensureLoaded();
    const provider = this._guilds[normalizedGuildId]?.provider;
    if (!provider?.encryptedKey) {
      return { apiKey: null, fingerprint: null, keyStatus: 'unchecked' };
    }
    return {
      apiKey: decryptSecret(provider.encryptedKey, normalizedGuildId, this.encryptionKey),
      fingerprint: provider.fingerprint,
      keyStatus: provider.keyStatus,
    };
  }

  clearApiKey(guildId, updatedBy) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const actorId = normalizeUpdatedBy(updatedBy);
    return this._update(normalizedGuildId, {
      provider: {
        encryptedKey: null,
        keyStatus: 'unchecked',
        checkedAt: null,
        fingerprint: null,
      },
    }, actorId);
  }

  async hasApiKey(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    await this._ensureLoaded();
    const encryptedKey = this._guilds[normalizedGuildId]?.provider?.encryptedKey;
    return typeof encryptedKey === 'string' && encryptedKey.length > 0;
  }

  async validateStoredApiKeys() {
    await this._ensureLoaded();
    let validatedCount = 0;
    for (const [guildId, config] of Object.entries(this._guilds)) {
      if (!config.provider.encryptedKey) continue;
      validateEncryptedSecret(config.provider.encryptedKey, guildId, this.encryptionKey);
      validatedCount += 1;
    }
    return validatedCount;
  }

  setSetupMessage(guildId, channelId, messageId, updatedBy) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedChannelId = validateId(channelId, 'channelId');
    const normalizedMessageId = validateId(messageId, 'messageId');
    const actorId = normalizeUpdatedBy(updatedBy);
    return this._update(normalizedGuildId, {
      setup: {
        channelId: normalizedChannelId,
        messageId: normalizedMessageId,
      },
    }, actorId);
  }

  delete(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    return this._enqueueMutation(async () => {
      if (!Object.prototype.hasOwnProperty.call(this._guilds, normalizedGuildId)) {
        return false;
      }
      const nextGuilds = Object.assign(Object.create(null), this._guilds);
      delete nextGuilds[normalizedGuildId];
      await this._persist(nextGuilds);
      this._guilds = nextGuilds;
      return true;
    });
  }
}

module.exports = {
  ConfigEncryptionError,
  GuildConfigStore,
  createDefaultGuildConfig,
  decryptSecret,
  encryptSecret,
  isGuildConfigured,
  isNormalizedGuildConfigReady,
  normalizeGuildConfig,
  parseEncryptionKey,
};
