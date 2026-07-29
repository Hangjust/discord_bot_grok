const DOCUMENT_SCHEMA_VERSION = 4;
const GUILD_CONFIG_SCHEMA_VERSION = 4;
const MAX_AGENT_DOCUMENT_CHARACTERS = 4_000;
const DEFAULT_TRIGGER_WORD = 'AI';
const MAX_TRIGGER_WORD_CHARACTERS = 24;
const AI_PROVIDERS = Object.freeze(['deepseek', 'gemma4']);
const SECRET_FIELDS = Object.freeze(['deepseek', 'gemini', 'brave']);

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

function cloneUnknownProperties(value, knownKeys) {
  const unknown = {};
  for (const [key, child] of Object.entries(value)) {
    if (!knownKeys.has(key)) {
      unknown[key] = cloneValue(child);
    }
  }
  return unknown;
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

function normalizeTriggerWord(value, fieldName = 'trigger word') {
  const triggerWord = String(value ?? '').trim();

  if (!triggerWord) {
    throw new TypeError(`${fieldName} must not be empty`);
  }

  if (triggerWord.length > MAX_TRIGGER_WORD_CHARACTERS
    || !/^[A-Za-z0-9_-]+$/.test(triggerWord)) {
    throw new TypeError(
      `${fieldName} must be 1-${MAX_TRIGGER_WORD_CHARACTERS} letters, numbers, underscores, or hyphens`,
    );
  }

  return triggerWord;
}

function normalizeInvocationConfig(value) {
  if (value === undefined || value === null) {
    return {
      triggerWord: DEFAULT_TRIGGER_WORD,
      updatedAt: null,
      updatedByUserId: null,
    };
  }

  if (!isPlainObject(value)) {
    throw new TypeError('invocation must be an object');
  }

  return {
    ...cloneUnknownProperties(value, new Set(['triggerWord', 'updatedAt', 'updatedByUserId'])),
    triggerWord: normalizeTriggerWord(
      value.triggerWord ?? DEFAULT_TRIGGER_WORD,
      'invocation.triggerWord',
    ),
    updatedAt: normalizeTimestamp(value.updatedAt, 'invocation.updatedAt'),
    updatedByUserId: normalizeOptionalId(
      value.updatedByUserId,
      'invocation.updatedByUserId',
    ),
  };
}

function normalizeAgentContent(value, fieldName = 'agent content') {
  if (typeof value !== 'string') {
    throw new TypeError(`${fieldName} must be a string`);
  }

  const content = value.trim();

  if (!content) {
    throw new TypeError(`${fieldName} must not be empty`);
  }

  if ([...content].length > MAX_AGENT_DOCUMENT_CHARACTERS) {
    throw new TypeError(
      `${fieldName} must be at most ${MAX_AGENT_DOCUMENT_CHARACTERS} characters`,
    );
  }

  return content;
}

function normalizeAgentDocument(value, fieldName = 'agent document') {
  if (value === undefined || value === null) {
    return null;
  }

  if (!isPlainObject(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }

  const updatedAt = normalizeTimestamp(value.updatedAt, `${fieldName}.updatedAt`);

  if (!updatedAt) {
    throw new TypeError(`${fieldName}.updatedAt is required`);
  }

  return {
    ...cloneUnknownProperties(value, new Set(['content', 'updatedAt', 'updatedByUserId'])),
    content: normalizeAgentContent(value.content, `${fieldName}.content`),
    updatedAt,
    updatedByUserId: normalizeId(value.updatedByUserId, `${fieldName}.updatedByUserId`),
  };
}

function normalizeAgentConfig(value) {
  if (value === undefined || value === null) {
    return {
      server: null,
      channels: {},
    };
  }

  if (!isPlainObject(value)) {
    throw new TypeError('agent must be an object');
  }

  const channels = value.channels ?? {};

  if (!isPlainObject(channels)) {
    throw new TypeError('agent.channels must be an object');
  }

  const normalizedChannels = {};

  for (const [channelId, document] of Object.entries(channels)) {
    const normalizedChannelId = normalizeId(channelId, 'agent channelId');

    if (Object.hasOwn(normalizedChannels, normalizedChannelId)) {
      throw new TypeError(`agent.channels contains duplicate channel ID ${normalizedChannelId}`);
    }

    normalizedChannels[normalizedChannelId] = normalizeAgentDocument(
      document,
      `agent.channels.${normalizedChannelId}`,
    );

    if (normalizedChannels[normalizedChannelId] === null) {
      throw new TypeError(`agent.channels.${normalizedChannelId} must be a document`);
    }
  }

  return {
    ...cloneUnknownProperties(value, new Set(['server', 'channels'])),
    server: normalizeAgentDocument(value.server, 'agent.server'),
    channels: normalizedChannels,
  };
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
    ...cloneUnknownProperties(value, new Set([
      'formatVersion', 'keyId', 'algorithm', 'iv', 'ciphertext', 'tag',
    ])),
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
    aiProvider: 'deepseek',
    deepseekKey: null,
    geminiKey: null,
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
    invocation: {
      triggerWord: DEFAULT_TRIGGER_WORD,
      updatedAt: null,
      updatedByUserId: null,
    },
    agent: {
      server: null,
      channels: {},
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
  const hasNestedAccess = isPlainObject(input.access);
  const access = hasNestedAccess ? input.access : input;
  const onboardingPanel = isPlainObject(input.onboardingPanel) ? input.onboardingPanel : {};
  const configured = input.configured === true;

  const record = {
    ...defaults,
    ...cloneUnknownProperties(input, new Set([
      'schemaVersion',
      'version',
      'guildId',
      'configured',
      'revision',
      'createdAt',
      'updatedAt',
      'configuredAt',
      'configuredByUserId',
      'aiProvider',
      'deepseekKey',
      'geminiKey',
      'webSearch',
      'access',
      'onboardingPanel',
      'invocation',
      'agent',
      'allowedChannelIds',
      'ignoredChannelIds',
      'allowedRoleIds',
      'ignoredRoleIds',
    ])),
    schemaVersion: GUILD_CONFIG_SCHEMA_VERSION,
    configured,
    revision: normalizeRevision(input.revision),
    createdAt: normalizeTimestamp(input.createdAt, 'createdAt'),
    updatedAt: normalizeTimestamp(input.updatedAt, 'updatedAt'),
    configuredAt: normalizeTimestamp(input.configuredAt, 'configuredAt'),
    configuredByUserId: normalizeOptionalId(input.configuredByUserId, 'configuredByUserId'),
    aiProvider: AI_PROVIDERS.includes(String(input.aiProvider || 'deepseek').toLowerCase())
      ? String(input.aiProvider || 'deepseek').toLowerCase()
      : (() => { throw new TypeError('aiProvider is not supported'); })(),
    deepseekKey: configured ? normalizeEncryptedSecret(input.deepseekKey, 'deepseekKey') : null,
    geminiKey: configured ? normalizeEncryptedSecret(input.geminiKey, 'geminiKey') : null,
    webSearch: {
      ...cloneValue(webSearch),
      enabled: configured && webSearch.enabled === true,
      braveKey: configured ? normalizeEncryptedSecret(webSearch.braveKey, 'webSearch.braveKey') : null,
    },
    access: {
      ...(hasNestedAccess ? cloneValue(access) : {}),
      allowedChannelIds: normalizeIdList(access.allowedChannelIds, 'allowedChannelIds'),
      ignoredChannelIds: normalizeIdList(access.ignoredChannelIds, 'ignoredChannelIds'),
      allowedRoleIds: normalizeIdList(access.allowedRoleIds, 'allowedRoleIds'),
      ignoredRoleIds: normalizeIdList(access.ignoredRoleIds, 'ignoredRoleIds'),
    },
    onboardingPanel: {
      ...cloneValue(onboardingPanel),
      channelId: normalizeOptionalId(onboardingPanel.channelId, 'onboardingPanel.channelId'),
      messageId: normalizeOptionalId(onboardingPanel.messageId, 'onboardingPanel.messageId'),
    },
    invocation: normalizeInvocationConfig(input.invocation),
    agent: normalizeAgentConfig(input.agent),
  };

  if (configured && record.aiProvider === 'deepseek' && !record.deepseekKey) {
    throw new TypeError('configured DeepSeek guild config requires an encrypted DeepSeek key');
  }

  if (configured && record.aiProvider === 'gemma4' && !record.geminiKey) {
    throw new TypeError('configured Gemma 4 guild config requires an encrypted Gemini key');
  }

  if (record.webSearch.enabled && !record.webSearch.braveKey) {
    throw new TypeError('enabled web search requires an encrypted Brave key');
  }

  if (!record.onboardingPanel.channelId || !record.onboardingPanel.messageId) {
    record.onboardingPanel = {
      ...record.onboardingPanel,
      channelId: null,
      messageId: null,
    };
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
    ...cloneUnknownProperties(input, new Set(['schemaVersion', 'version', 'guilds', 'records'])),
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    guilds: normalizedGuilds,
  };
}

module.exports = {
  AI_PROVIDERS,
  DOCUMENT_SCHEMA_VERSION,
  DEFAULT_TRIGGER_WORD,
  GUILD_CONFIG_SCHEMA_VERSION,
  MAX_AGENT_DOCUMENT_CHARACTERS,
  MAX_TRIGGER_WORD_CHARACTERS,
  SECRET_FIELDS,
  cloneValue,
  createDefaultGuildConfig,
  createEmptyDocument,
  immutableSnapshot,
  normalizeAgentConfig,
  normalizeAgentContent,
  normalizeAgentDocument,
  normalizeGuildConfig,
  normalizeGuildConfigDocument,
  normalizeId,
  normalizeIdList,
  normalizeInvocationConfig,
  normalizeTriggerWord,
};
