const DOCUMENT_SCHEMA_VERSION = 1;
const GUILD_CONFIG_SCHEMA_VERSION = 1;
const SECRET_FIELDS = Object.freeze(['deepseek', 'brave']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return value;
}

function cloneValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function immutableSnapshot(value) {
  return deepFreeze(cloneValue(value));
}

function normalizeId(value, fieldName) {
  const normalized = String(value ?? '').trim();

  if (!normalized || !/^\d+$/.test(normalized)) {
    throw new TypeError(`${fieldName} must be a numeric Discord ID`);
  }

  return normalized;
}

function normalizeOptionalId(value, fieldName) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  return normalizeId(value, fieldName);
}

function normalizeIdList(value, fieldName) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an array`);
  }

  return [...new Set(value.map((entry) => normalizeId(entry, fieldName)))].sort();
}

function normalizeTimestamp(value, fieldName, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${fieldName} must be an ISO timestamp`);
  }

  return date.toISOString();
}

function normalizeRevision(value) {
  const revision = Number(value ?? 0);

  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError('revision must be a non-negative safe integer');
  }

  return revision;
}

function normalizeBase64Part(value, fieldName, expectedBytes) {
  const encoded = String(value ?? '').trim();
  const decoded = Buffer.from(encoded, 'base64');

  if (!encoded || decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new TypeError(`${fieldName} is not valid base64`);
  }

  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new TypeError(`${fieldName} has an invalid length`);
  }

  return encoded;
}

function normalizeEncryptedSecret(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }

  if (!isPlainObject(value)) {
    throw new TypeError(`${fieldName} must be an encrypted secret object`);
  }

  const formatVersion = Number(value.formatVersion);
  const keyId = String(value.keyId ?? '').trim();
  const algorithm = String(value.algorithm ?? '').trim();

  if (formatVersion !== 1 || !keyId || algorithm !== 'aes-256-gcm') {
    throw new TypeError(`${fieldName} is not a supported encrypted secret`);
  }

  return {
    formatVersion,
    keyId,
    algorithm,
    iv: normalizeBase64Part(value.iv, `${fieldName}.iv`, 12),
    ciphertext: normalizeBase64Part(value.ciphertext, `${fieldName}.ciphertext`),
    tag: normalizeBase64Part(value.tag, `${fieldName}.tag`, 16),
  };
}

function createDefaultGuildConfig(guildId) {
  return {
    schemaVersion: GUILD_CONFIG_SCHEMA_VERSION,
    guildId: normalizeId(guildId, 'guildId'),
    configured: false,
    revision: 0,
    createdAt: null,
    updatedAt: null,
    configuredAt: null,
    configuredByUserId: null,
    deepseekKey: null,
    webSearch: {
      enabled: false,
      braveKey: null,
    },
    access: {
      allowedChannelIds: [],
      ignoredChannelIds: [],
      allowedRoleIds: [],
      ignoredRoleIds: [],
    },
    onboardingPanel: {
      channelId: null,
      messageId: null,
    },
  };
}

function normalizeGuildConfig(guildId, input = {}) {
  if (!isPlainObject(input)) {
    throw new TypeError('guild config must be an object');
  }

  const schemaVersion = Number(input.schemaVersion ?? input.version ?? GUILD_CONFIG_SCHEMA_VERSION);

  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new TypeError('guild config schema version is invalid');
  }

  if (schemaVersion > GUILD_CONFIG_SCHEMA_VERSION) {
    throw new Error('guild config schema version is newer than this application supports');
  }

  const normalizedGuildId = normalizeId(input.guildId ?? guildId, 'guildId');

  if (normalizedGuildId !== normalizeId(guildId, 'guildId')) {
    throw new TypeError('guild config guildId does not match its document key');
  }

  const defaults = createDefaultGuildConfig(normalizedGuildId);
  const webSearch = isPlainObject(input.webSearch) ? input.webSearch : {};
  const access = isPlainObject(input.access) ? input.access : input;
  const onboardingPanel = isPlainObject(input.onboardingPanel) ? input.onboardingPanel : {};
  const configured = input.configured === true;

  const record = {
    ...defaults,
    schemaVersion: GUILD_CONFIG_SCHEMA_VERSION,
    configured,
    revision: normalizeRevision(input.revision),
    createdAt: normalizeTimestamp(input.createdAt, 'createdAt'),
    updatedAt: normalizeTimestamp(input.updatedAt, 'updatedAt'),
    configuredAt: normalizeTimestamp(input.configuredAt, 'configuredAt'),
    configuredByUserId: normalizeOptionalId(input.configuredByUserId, 'configuredByUserId'),
    deepseekKey: configured ? normalizeEncryptedSecret(input.deepseekKey, 'deepseekKey') : null,
    webSearch: {
      enabled: configured && webSearch.enabled === true,
      braveKey: configured ? normalizeEncryptedSecret(webSearch.braveKey, 'webSearch.braveKey') : null,
    },
    access: {
      allowedChannelIds: normalizeIdList(access.allowedChannelIds, 'allowedChannelIds'),
      ignoredChannelIds: normalizeIdList(access.ignoredChannelIds, 'ignoredChannelIds'),
      allowedRoleIds: normalizeIdList(access.allowedRoleIds, 'allowedRoleIds'),
      ignoredRoleIds: normalizeIdList(access.ignoredRoleIds, 'ignoredRoleIds'),
    },
    onboardingPanel: {
      channelId: normalizeOptionalId(onboardingPanel.channelId, 'onboardingPanel.channelId'),
      messageId: normalizeOptionalId(onboardingPanel.messageId, 'onboardingPanel.messageId'),
    },
  };

  if (configured && !record.deepseekKey) {
    throw new TypeError('configured guild config requires an encrypted DeepSeek key');
  }

  if (record.webSearch.enabled && !record.webSearch.braveKey) {
    throw new TypeError('enabled web search requires an encrypted Brave key');
  }

  if (!record.onboardingPanel.channelId || !record.onboardingPanel.messageId) {
    record.onboardingPanel = { channelId: null, messageId: null };
  }

  return record;
}

function createEmptyDocument() {
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    guilds: {},
  };
}

function normalizeGuildConfigDocument(input) {
  if (input === undefined || input === null) {
    return createEmptyDocument();
  }

  if (!isPlainObject(input)) {
    throw new TypeError('guild config document must be an object');
  }

  const schemaVersion = Number(input.schemaVersion ?? input.version ?? DOCUMENT_SCHEMA_VERSION);

  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new TypeError('guild config document schema version is invalid');
  }

  if (schemaVersion > DOCUMENT_SCHEMA_VERSION) {
    throw new Error('guild config document schema version is newer than this application supports');
  }

  const guilds = input.guilds ?? input.records ?? {};

  if (!isPlainObject(guilds)) {
    throw new TypeError('guild config document guilds must be an object');
  }

  const normalizedGuilds = {};

  for (const [guildId, record] of Object.entries(guilds)) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    normalizedGuilds[normalizedGuildId] = normalizeGuildConfig(normalizedGuildId, record);
  }

  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    guilds: normalizedGuilds,
  };
}

module.exports = {
  DOCUMENT_SCHEMA_VERSION,
  GUILD_CONFIG_SCHEMA_VERSION,
  SECRET_FIELDS,
  cloneValue,
  createDefaultGuildConfig,
  createEmptyDocument,
  immutableSnapshot,
  normalizeGuildConfig,
  normalizeGuildConfigDocument,
  normalizeId,
  normalizeIdList,
};
