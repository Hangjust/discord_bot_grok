const {
  createDefaultGuildConfig,
  immutableSnapshot,
  normalizeId,
  normalizeIdList,
} = require('../config/guildConfigSchema');

function parseBoolean(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function parseInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, minimum), maximum);
}

function parseLegacyIds(value) {
  return [...new Set(String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^\d+$/.test(entry)))].sort();
}

function buildLegacyRuntimeConfig(guildId, env) {
  const deepseekApiKey = String(env.DEEPSEEK_API_KEY ?? '').trim();

  if (!deepseekApiKey) {
    return null;
  }

  const webSearchEnabled = parseBoolean(env.WEB_SEARCH_ENABLED);
  const braveApiKey = String(env.WEB_SEARCH_API_KEY ?? '').trim();

  return {
    guildId,
    configured: true,
    source: 'legacy-env',
    deepseek: {
      apiKey: deepseekApiKey,
      baseUrl: String(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim(),
      model: String(env.DEEPSEEK_MODEL || 'deepseek-v4-flash').trim(),
      timeoutMs: parseInteger(env.DEEPSEEK_TIMEOUT_MS, 30000, 1000, 120000),
    },
    webSearch: {
      enabled: webSearchEnabled,
      provider: 'brave',
      apiKey: webSearchEnabled ? braveApiKey : '',
      maxResults: parseInteger(env.WEB_SEARCH_MAX_RESULTS, 3, 1, 20),
      timeoutMs: parseInteger(env.WEB_SEARCH_TIMEOUT_MS, 5000, 1000, 30000),
    },
    access: {
      allowedChannelIds: parseLegacyIds(env.DISCORD_REPLY_ALLOWED_CHANNEL_IDS),
      ignoredChannelIds: parseLegacyIds(env.DISCORD_READ_EXCLUDED_CHANNEL_IDS),
      allowedRoleIds: [],
      ignoredRoleIds: [],
    },
  };
}

function createGuildConfigService(options = {}) {
  const { store, cipher } = options;
  const env = options.env || process.env;
  const now = options.now || (() => new Date());

  if (!store || typeof store.getGuild !== 'function' || typeof store.updateGuild !== 'function') {
    throw new TypeError('guild config store is required');
  }

  if (!cipher || typeof cipher.encrypt !== 'function' || typeof cipher.decrypt !== 'function') {
    throw new TypeError('guild secret cipher is required');
  }

  function timestamp() {
    return now().toISOString();
  }

  function deploymentConfig() {
    return {
      deepseekBaseUrl: String(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim(),
      deepseekModel: String(env.DEEPSEEK_MODEL || 'deepseek-v4-flash').trim(),
      deepseekTimeoutMs: parseInteger(env.DEEPSEEK_TIMEOUT_MS, 30000, 1000, 120000),
      webSearchMaxResults: parseInteger(env.WEB_SEARCH_MAX_RESULTS, 3, 1, 20),
      webSearchTimeoutMs: parseInteger(env.WEB_SEARCH_TIMEOUT_MS, 5000, 1000, 30000),
    };
  }

  async function getStoredConfig(guildId) {
    return store.getGuild(normalizeId(guildId, 'guildId'));
  }

  async function getConfigSnapshot(guildId) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const record = await store.getGuild(normalizedGuildId);
    return record || immutableSnapshot(createDefaultGuildConfig(normalizedGuildId));
  }

  async function getStatus(guildId) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const record = await store.getGuild(normalizedGuildId);

    if (record) {
      return immutableSnapshot({
        guildId: normalizedGuildId,
        source: record.configured ? 'stored' : 'tombstone',
        configured: record.configured,
        revision: record.revision,
        hasDeepseekKey: Boolean(record.deepseekKey),
        webSearchEnabled: record.webSearch.enabled,
        hasBraveKey: Boolean(record.webSearch.braveKey),
        access: record.access,
        onboardingPanel: record.onboardingPanel,
        updatedAt: record.updatedAt,
      });
    }

    const legacy = parseBoolean(env.ALLOW_LEGACY_GUILD_CONFIG)
      ? buildLegacyRuntimeConfig(normalizedGuildId, env)
      : null;

    return immutableSnapshot({
      guildId: normalizedGuildId,
      source: legacy ? 'legacy-env' : 'none',
      configured: Boolean(legacy),
      revision: 0,
      hasDeepseekKey: Boolean(legacy?.deepseek.apiKey),
      webSearchEnabled: Boolean(legacy?.webSearch.enabled),
      hasBraveKey: Boolean(legacy?.webSearch.apiKey),
      access: legacy?.access || createDefaultGuildConfig(normalizedGuildId).access,
      onboardingPanel: { channelId: null, messageId: null },
      updatedAt: null,
    });
  }

  async function resolveRuntimeConfig(guildId) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const record = await store.getGuild(normalizedGuildId);

    if (record) {
      if (!record.configured) {
        return immutableSnapshot({
          guildId: normalizedGuildId,
          configured: false,
          source: 'tombstone',
        });
      }

      const deployment = deploymentConfig();
      const deepseekApiKey = cipher.decrypt(normalizedGuildId, 'deepseek', record.deepseekKey);
      const braveApiKey = record.webSearch.braveKey
        ? cipher.decrypt(normalizedGuildId, 'brave', record.webSearch.braveKey)
        : '';

      return immutableSnapshot({
        guildId: normalizedGuildId,
        configured: true,
        source: 'stored',
        revision: record.revision,
        deepseek: {
          apiKey: deepseekApiKey,
          baseUrl: deployment.deepseekBaseUrl,
          model: deployment.deepseekModel,
          timeoutMs: deployment.deepseekTimeoutMs,
        },
        webSearch: {
          enabled: record.webSearch.enabled,
          provider: 'brave',
          apiKey: braveApiKey,
          maxResults: deployment.webSearchMaxResults,
          timeoutMs: deployment.webSearchTimeoutMs,
        },
        access: record.access,
      });
    }

    if (parseBoolean(env.ALLOW_LEGACY_GUILD_CONFIG)) {
      const legacy = buildLegacyRuntimeConfig(normalizedGuildId, env);

      if (legacy) {
        return immutableSnapshot(legacy);
      }
    }

    return immutableSnapshot({
      guildId: normalizedGuildId,
      configured: false,
      source: 'none',
    });
  }

  async function configureGuild(guildId, input) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const actorUserId = normalizeId(input?.configuredByUserId, 'configuredByUserId');
    const deepseekApiKey = String(input?.deepseekApiKey ?? '').trim();
    const webSearchEnabled = input?.webSearchEnabled === true;
    const braveApiKey = String(input?.braveApiKey ?? '').trim();

    if (!deepseekApiKey) {
      throw new TypeError('DeepSeek key is required');
    }

    if (webSearchEnabled && !braveApiKey) {
      throw new TypeError('Brave key is required when web search is enabled');
    }

    const encryptedDeepseekKey = cipher.encrypt(normalizedGuildId, 'deepseek', deepseekApiKey);
    const encryptedBraveKey = braveApiKey ? cipher.encrypt(normalizedGuildId, 'brave', braveApiKey) : null;
    const setupChannelIds = input?.setupChannelId
      ? [normalizeId(input.setupChannelId, 'setupChannelId')]
      : normalizeIdList(input?.allowedChannelIds, 'allowedChannelIds');

    return store.updateGuild(normalizedGuildId, (current) => {
      const updatedAt = timestamp();
      return {
        ...current,
        configured: true,
        revision: current.revision + 1,
        createdAt: current.createdAt || updatedAt,
        updatedAt,
        configuredAt: updatedAt,
        configuredByUserId: actorUserId,
        deepseekKey: encryptedDeepseekKey,
        webSearch: {
          enabled: webSearchEnabled,
          braveKey: encryptedBraveKey,
        },
        access: {
          allowedChannelIds: setupChannelIds,
          ignoredChannelIds: [],
          allowedRoleIds: [],
          ignoredRoleIds: [],
        },
      };
    });
  }

  async function setOnboardingPanel(guildId, channelId, messageId) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const normalizedChannelId = normalizeId(channelId, 'channelId');
    const normalizedMessageId = normalizeId(messageId, 'messageId');

    return store.updateGuild(normalizedGuildId, (current) => ({
      ...current,
      revision: current.revision + 1,
      createdAt: current.createdAt || timestamp(),
      updatedAt: timestamp(),
      onboardingPanel: {
        channelId: normalizedChannelId,
        messageId: normalizedMessageId,
      },
    }));
  }

  async function moveAccessEntry(guildId, kind, action, id) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const normalizedId = normalizeId(id, `${kind}Id`);
    const fields = kind === 'channel'
      ? ['allowedChannelIds', 'ignoredChannelIds']
      : kind === 'role'
        ? ['allowedRoleIds', 'ignoredRoleIds']
        : null;

    if (!fields || !['allow', 'ignore', 'remove'].includes(action)) {
      throw new TypeError('access update is not supported');
    }

    return store.updateGuild(normalizedGuildId, (current) => {
      if (!current.configured) {
        throw new Error('Guild is not configured');
      }

      const [allowedField, ignoredField] = fields;
      const access = {
        ...current.access,
        [allowedField]: current.access[allowedField].filter((entry) => entry !== normalizedId),
        [ignoredField]: current.access[ignoredField].filter((entry) => entry !== normalizedId),
      };

      if (action === 'allow') {
        access[allowedField].push(normalizedId);
        access[allowedField].sort();
      } else if (action === 'ignore') {
        access[ignoredField].push(normalizedId);
        access[ignoredField].sort();
      }

      return {
        ...current,
        revision: current.revision + 1,
        updatedAt: timestamp(),
        access,
      };
    });
  }

  async function setWebSearch(guildId, enabled, braveApiKey) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const plaintext = String(braveApiKey ?? '').trim();
    const encryptedBraveKey = plaintext ? cipher.encrypt(normalizedGuildId, 'brave', plaintext) : null;

    return store.updateGuild(normalizedGuildId, (current) => {
      if (!current.configured) {
        throw new Error('Guild is not configured');
      }

      const storedBraveKey = encryptedBraveKey || current.webSearch.braveKey;

      if (enabled && !storedBraveKey) {
        throw new TypeError('Brave key is required when web search is enabled');
      }

      return {
        ...current,
        revision: current.revision + 1,
        updatedAt: timestamp(),
        webSearch: {
          enabled: enabled === true,
          braveKey: storedBraveKey,
        },
      };
    });
  }

  async function rotateSecret(guildId, field, plaintext) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const normalizedField = String(field ?? '').trim().toLowerCase();
    const encrypted = cipher.encrypt(normalizedGuildId, normalizedField, String(plaintext ?? '').trim());

    return store.updateGuild(normalizedGuildId, (current) => {
      if (!current.configured) {
        throw new Error('Guild is not configured');
      }

      if (normalizedField === 'deepseek') {
        return {
          ...current,
          revision: current.revision + 1,
          updatedAt: timestamp(),
          deepseekKey: encrypted,
        };
      }

      if (normalizedField === 'brave') {
        return {
          ...current,
          revision: current.revision + 1,
          updatedAt: timestamp(),
          webSearch: { ...current.webSearch, braveKey: encrypted },
        };
      }

      throw new TypeError('secret field is not supported');
    });
  }

  async function resetGuild(guildId, resetByUserId) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    normalizeId(resetByUserId, 'resetByUserId');

    return store.updateGuild(normalizedGuildId, (current) => ({
      ...current,
      configured: false,
      revision: current.revision + 1,
      createdAt: current.createdAt || timestamp(),
      updatedAt: timestamp(),
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
    }));
  }

  return Object.freeze({
    configureGuild,
    getConfigSnapshot,
    getStatus,
    getStoredConfig,
    moveAccessEntry,
    resetGuild,
    resolveRuntimeConfig,
    rotateSecret,
    setOnboardingPanel,
    setWebSearch,
  });
}

module.exports = {
  buildLegacyRuntimeConfig,
  createGuildConfigService,
  parseBoolean,
  parseLegacyIds,
};
