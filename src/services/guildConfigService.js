const {
  DEFAULT_TRIGGER_WORD,
  createDefaultGuildConfig,
  immutableSnapshot,
  normalizeAgentContent,
  normalizeId,
  normalizeIdList,
  normalizeTriggerWord,
} = require('../config/guildConfigSchema');
const { builtInBehavior } = require('./deepseek');

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
    triggerWord: DEFAULT_TRIGGER_WORD,
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
      geminiBaseUrl: String(env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').trim(),
      geminiModel: String(env.GEMINI_MODEL || 'gemma-4-26b-a4b-it').trim(),
      geminiTimeoutMs: parseInteger(env.GEMINI_TIMEOUT_MS, 30000, 1000, 120000),
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
        aiProvider: record.aiProvider,
        hasDeepseekKey: Boolean(record.deepseekKey),
        hasGeminiKey: Boolean(record.geminiKey),
        webSearchEnabled: record.webSearch.enabled,
        hasBraveKey: Boolean(record.webSearch.braveKey),
        access: record.access,
        onboardingPanel: record.onboardingPanel,
        triggerWord: record.invocation.triggerWord,
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
      aiProvider: 'deepseek',
      hasDeepseekKey: Boolean(legacy?.deepseek.apiKey),
      hasGeminiKey: false,
      webSearchEnabled: Boolean(legacy?.webSearch.enabled),
      hasBraveKey: Boolean(legacy?.webSearch.apiKey),
      access: legacy?.access || createDefaultGuildConfig(normalizedGuildId).access,
      onboardingPanel: { channelId: null, messageId: null },
      triggerWord: DEFAULT_TRIGGER_WORD,
      updatedAt: null,
    });
  }

  async function getInvocationConfig(guildId) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const record = await store.getGuild(normalizedGuildId);

    return immutableSnapshot({
      guildId: normalizedGuildId,
      triggerWord: record?.invocation?.triggerWord || DEFAULT_TRIGGER_WORD,
      source: record ? (record.configured ? 'stored' : 'tombstone') : 'default',
      revision: record?.revision || 0,
    });
  }

  async function setTriggerWord(guildId, triggerWord, updatedByUserId) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const normalizedTriggerWord = normalizeTriggerWord(triggerWord);
    const normalizedUserId = normalizeId(updatedByUserId, 'updatedByUserId');
    let changed = false;

    const record = await store.updateGuild(normalizedGuildId, (current) => {
      if (!current.configured) {
        throw new Error('Guild is not configured');
      }

      if (current.invocation.triggerWord === normalizedTriggerWord) {
        return current;
      }

      changed = true;
      const updatedAt = timestamp();
      return {
        ...current,
        revision: current.revision + 1,
        updatedAt,
        invocation: {
          ...current.invocation,
          triggerWord: normalizedTriggerWord,
          updatedAt,
          updatedByUserId: normalizedUserId,
        },
      };
    });

    return immutableSnapshot({
      guildId: normalizedGuildId,
      changed,
      triggerWord: record.invocation.triggerWord,
      revision: record.revision,
      updatedAt: record.invocation.updatedAt,
      updatedByUserId: record.invocation.updatedByUserId,
    });
  }

  function normalizeAgentTarget(target = {}) {
    const scope = String(target.scope ?? '').trim().toLowerCase();

    if (!['server', 'channel'].includes(scope)) {
      throw new TypeError('agent behavior scope must be server or channel');
    }

    return {
      scope,
      channelId: scope === 'channel'
        ? normalizeId(target.channelId, 'channelId')
        : null,
    };
  }

  function resolveAgentDocument(record, channelId = null) {
    const normalizedChannelId = channelId === null || channelId === undefined
      ? null
      : normalizeId(channelId, 'channelId');
    const channelDocument = normalizedChannelId
      ? record?.agent?.channels?.[normalizedChannelId]
      : null;
    const document = channelDocument || record?.agent?.server || null;

    return {
      channelId: normalizedChannelId,
      source: channelDocument ? 'channel' : document ? 'server' : 'built-in',
      content: document?.content || builtInBehavior,
      updatedAt: document?.updatedAt || null,
      updatedByUserId: document?.updatedByUserId || null,
    };
  }

  function buildAgentResult(record, target, options = {}) {
    const effective = resolveAgentDocument(
      record,
      target.scope === 'channel' ? target.channelId : null,
    );

    return immutableSnapshot({
      guildId: target.guildId,
      scope: target.scope,
      channelId: target.channelId,
      targetId: target.channelId || target.guildId,
      changed: options.changed === true,
      effectiveChanged: options.effectiveChanged === true,
      source: effective.source,
      characterCount: [...effective.content].length,
      revision: record?.revision || 0,
      channelOverrideIds: Object.keys(record?.agent?.channels || {}).sort(),
      updatedAt: effective.updatedAt,
      updatedByUserId: effective.updatedByUserId,
      ...(options.includeContent ? { content: effective.content } : {}),
    });
  }

  async function resolveAgentBehavior(guildId, channelId = null) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const normalizedChannelId = channelId === null || channelId === undefined
      ? null
      : normalizeId(channelId, 'channelId');
    const record = await store.getGuild(normalizedGuildId);
    const effective = resolveAgentDocument(record, normalizedChannelId);

    return immutableSnapshot({
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      source: effective.source,
      content: effective.content,
      characterCount: [...effective.content].length,
      revision: record?.revision || 0,
      channelOverrideIds: Object.keys(record?.agent?.channels || {}).sort(),
    });
  }

  async function getAgentBehaviorStatus(guildId, input = {}) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const target = {
      guildId: normalizedGuildId,
      ...normalizeAgentTarget(input),
    };
    const record = await store.getGuild(normalizedGuildId);
    return buildAgentResult(record, target);
  }

  async function exportAgentBehavior(guildId, input = {}) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const target = {
      guildId: normalizedGuildId,
      ...normalizeAgentTarget(input),
    };
    const record = await store.getGuild(normalizedGuildId);
    return buildAgentResult(record, target, { includeContent: true });
  }

  async function setAgentBehavior(guildId, input = {}) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const target = {
      guildId: normalizedGuildId,
      ...normalizeAgentTarget(input),
    };
    const content = normalizeAgentContent(input.content, 'behavior document');
    const updatedByUserId = normalizeId(
      input.updatedByUserId ?? input.editorUserId,
      'updatedByUserId',
    );
    let changed = false;
    let effectiveChanged = false;

    const record = await store.updateGuild(normalizedGuildId, (current) => {
      if (!current.configured) {
        throw new Error('Guild is not configured');
      }

      const existing = target.scope === 'server'
        ? current.agent.server
        : current.agent.channels[target.channelId];

      if (existing?.content === content) {
        return current;
      }

      changed = true;
      effectiveChanged = resolveAgentDocument(
        current,
        target.scope === 'channel' ? target.channelId : null,
      ).content !== content;
      const updatedAt = timestamp();
      const document = { content, updatedAt, updatedByUserId };
      const agent = target.scope === 'server'
        ? { ...current.agent, server: document }
        : {
          ...current.agent,
          channels: { ...current.agent.channels, [target.channelId]: document },
        };

      return {
        ...current,
        revision: current.revision + 1,
        updatedAt,
        agent,
      };
    });

    return buildAgentResult(record, target, { changed, effectiveChanged });
  }

  async function clearAgentBehavior(guildId, input = {}) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const target = {
      guildId: normalizedGuildId,
      ...normalizeAgentTarget(input),
    };
    let changed = false;
    let effectiveChanged = false;

    const record = await store.updateGuild(normalizedGuildId, (current) => {
      if (!current.configured) {
        throw new Error('Guild is not configured');
      }

      const existing = target.scope === 'server'
        ? current.agent.server
        : current.agent.channels[target.channelId];

      if (!existing) {
        return current;
      }

      changed = true;
      const beforeContent = resolveAgentDocument(
        current,
        target.scope === 'channel' ? target.channelId : null,
      ).content;
      const afterContent = target.scope === 'server'
        ? builtInBehavior
        : current.agent.server?.content || builtInBehavior;
      effectiveChanged = beforeContent !== afterContent;
      const updatedAt = timestamp();
      let agent;

      if (target.scope === 'server') {
        agent = { ...current.agent, server: null };
      } else {
        const channels = { ...current.agent.channels };
        delete channels[target.channelId];
        agent = { ...current.agent, channels };
      }

      return {
        ...current,
        revision: current.revision + 1,
        updatedAt,
        agent,
      };
    });

    return buildAgentResult(record, target, { changed, effectiveChanged });
  }

  async function resolveRuntimeConfig(guildId, channelId = null) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const normalizedChannelId = channelId === null || channelId === undefined
      ? null
      : normalizeId(channelId, 'channelId');
    const record = await store.getGuild(normalizedGuildId);

    if (record) {
      if (!record.configured) {
        return immutableSnapshot({
          guildId: normalizedGuildId,
          ...(normalizedChannelId ? { channelId: normalizedChannelId } : {}),
          configured: false,
          source: 'tombstone',
          triggerWord: record.invocation.triggerWord,
        });
      }

      const deployment = deploymentConfig();
      const behavior = resolveAgentDocument(record, normalizedChannelId);
      const aiProvider = record.aiProvider || 'deepseek';
      const apiKey = aiProvider === 'gemma4'
        ? cipher.decrypt(normalizedGuildId, 'gemini', record.geminiKey)
        : cipher.decrypt(normalizedGuildId, 'deepseek', record.deepseekKey);
      const braveApiKey = record.webSearch.braveKey
        ? cipher.decrypt(normalizedGuildId, 'brave', record.webSearch.braveKey)
        : '';
      const ai = aiProvider === 'gemma4'
        ? {
          provider: 'gemma4',
          apiKey,
          baseUrl: deployment.geminiBaseUrl,
          model: deployment.geminiModel,
          timeoutMs: deployment.geminiTimeoutMs,
        }
        : {
          provider: 'deepseek',
          apiKey,
          baseUrl: deployment.deepseekBaseUrl,
          model: deployment.deepseekModel,
          timeoutMs: deployment.deepseekTimeoutMs,
        };

      return immutableSnapshot({
        guildId: normalizedGuildId,
        ...(normalizedChannelId ? { channelId: normalizedChannelId } : {}),
        configured: true,
        source: 'stored',
        revision: record.revision,
        aiProvider,
        triggerWord: record.invocation.triggerWord,
        behaviorSource: behavior.source,
        effectiveBehavior: behavior.source === 'built-in' ? null : behavior.content,
        ai,
        ...(aiProvider === 'deepseek' ? { deepseek: ai } : { gemini: ai }),
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
        return immutableSnapshot({
          ...legacy,
          ...(normalizedChannelId ? { channelId: normalizedChannelId } : {}),
          behaviorSource: 'built-in',
          effectiveBehavior: null,
          triggerWord: DEFAULT_TRIGGER_WORD,
        });
      }
    }

    return immutableSnapshot({
      guildId: normalizedGuildId,
      ...(normalizedChannelId ? { channelId: normalizedChannelId } : {}),
      configured: false,
      source: 'none',
      triggerWord: DEFAULT_TRIGGER_WORD,
    });
  }

  async function configureGuild(guildId, input) {
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const actorUserId = normalizeId(input?.configuredByUserId, 'configuredByUserId');
    const aiProvider = String(input?.aiProvider || 'deepseek').trim().toLowerCase();
    const deepseekApiKey = String(input?.deepseekApiKey ?? '').trim();
    const geminiApiKey = String(input?.geminiApiKey ?? '').trim();
    const webSearchEnabled = input?.webSearchEnabled === true;
    const braveApiKey = String(input?.braveApiKey ?? '').trim();

    if (!['deepseek', 'gemma4'].includes(aiProvider)) {
      throw new TypeError('AI provider is not supported');
    }

    if (aiProvider === 'deepseek' && !deepseekApiKey) {
      throw new TypeError('DeepSeek key is required');
    }

    if (aiProvider === 'gemma4' && !geminiApiKey) {
      throw new TypeError('Gemini key is required for Gemma 4');
    }

    if (webSearchEnabled && !braveApiKey) {
      throw new TypeError('Brave key is required when web search is enabled');
    }

    const encryptedDeepseekKey = deepseekApiKey
      ? cipher.encrypt(normalizedGuildId, 'deepseek', deepseekApiKey)
      : null;
    const encryptedGeminiKey = geminiApiKey
      ? cipher.encrypt(normalizedGuildId, 'gemini', geminiApiKey)
      : null;
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
        aiProvider,
        deepseekKey: encryptedDeepseekKey || current.deepseekKey,
        geminiKey: encryptedGeminiKey || current.geminiKey,
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

      if (normalizedField === 'gemini') {
        return {
          ...current,
          revision: current.revision + 1,
          updatedAt: timestamp(),
          geminiKey: encrypted,
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
    const normalizedUserId = normalizeId(resetByUserId, 'resetByUserId');

    return store.updateGuild(normalizedGuildId, (current) => {
      const updatedAt = timestamp();
      return {
        ...current,
        configured: false,
        revision: current.revision + 1,
        createdAt: current.createdAt || updatedAt,
        updatedAt,
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
        invocation: {
          triggerWord: DEFAULT_TRIGGER_WORD,
          updatedAt,
          updatedByUserId: normalizedUserId,
        },
        agent: {
          server: null,
          channels: {},
        },
      };
    });
  }

  return Object.freeze({
    clearAgentBehavior,
    configureGuild,
    exportAgentBehavior,
    getAgentBehaviorStatus,
    getConfigSnapshot,
    getInvocationConfig,
    getStatus,
    getStoredConfig,
    moveAccessEntry,
    resetGuild,
    resolveAgentBehavior,
    resolveRuntimeConfig,
    rotateSecret,
    setOnboardingPanel,
    setTriggerWord,
    setAgentBehavior,
    setWebSearch,
  });
}

module.exports = {
  buildLegacyRuntimeConfig,
  createGuildConfigService,
  parseBoolean,
  parseLegacyIds,
};
