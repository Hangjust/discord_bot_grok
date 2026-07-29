const { PermissionFlagsBits } = require('discord.js');

function normalizeIds(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.map((value) => String(value));
}

function getGuildId(subject) {
  return subject?.guildId ?? subject?.guild?.id ?? null;
}

function getChannelIds(subject) {
  const channel = subject?.channel ?? subject;
  const currentChannelId = subject?.channelId ?? channel?.id ?? null;
  const parentChannelId = channel?.parentId ?? channel?.parent?.id ?? null;

  return {
    currentChannelId: currentChannelId ? String(currentChannelId) : null,
    parentChannelId: parentChannelId ? String(parentChannelId) : null,
  };
}

function getMemberRoleIds(member) {
  if (!member) {
    return null;
  }

  const roleCache = member.roles?.cache;

  if (roleCache && typeof roleCache.keys === 'function') {
    return [...roleCache.keys()].map(String);
  }

  if (Array.isArray(member.roles)) {
    return member.roles.map((role) => String(role?.id ?? role));
  }

  if (Array.isArray(member.roleIds)) {
    return member.roleIds.map(String);
  }

  return null;
}

function hasManageMessagesPermission(subject) {
  const member = subject?.member;
  const channel = subject?.channel;

  if (!member) {
    return false;
  }

  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) {
    return true;
  }

  let permissions = null;
  try {
    permissions = channel?.permissionsFor?.(member) ?? member.permissions;
  } catch {
    return false;
  }

  return Boolean(permissions?.has?.(PermissionFlagsBits.ManageMessages));
}

function evaluateGuildChannelAccess(subject, config) {
  if (!getGuildId(subject)) {
    return { allowed: false, reason: 'dm' };
  }

  if (!config?.configured) {
    return { allowed: false, reason: 'unconfigured' };
  }

  const access = config.access || {};
  const ignoredChannelIds = new Set(normalizeIds(access.ignoredChannelIds));
  const allowedChannelIds = new Set(normalizeIds(access.allowedChannelIds));
  const { currentChannelId, parentChannelId } = getChannelIds(subject);

  if (!currentChannelId) {
    return { allowed: false, reason: 'missing-channel' };
  }

  if (ignoredChannelIds.has(currentChannelId) || (parentChannelId && ignoredChannelIds.has(parentChannelId))) {
    return { allowed: false, reason: 'ignored-channel' };
  }

  if (allowedChannelIds.size > 0
    && !allowedChannelIds.has(currentChannelId)
    && (!parentChannelId || !allowedChannelIds.has(parentChannelId))) {
    return { allowed: false, reason: 'channel-not-allowed' };
  }

  return { allowed: true, reason: 'allowed-channel' };
}

function evaluateMessageAccess(message, config) {
  if (message?.author?.bot) {
    return { allowed: false, reason: 'bot' };
  }

  if (message?.webhookId || message?.webhook) {
    return { allowed: false, reason: 'webhook' };
  }

  const channelDecision = evaluateGuildChannelAccess(message, config);

  if (!channelDecision.allowed) {
    return channelDecision;
  }

  const access = config.access || {};
  const ignoredRoleIds = new Set(normalizeIds(access.ignoredRoleIds));
  const allowedRoleIds = new Set(normalizeIds(access.allowedRoleIds));
  const hasRoleRestrictions = ignoredRoleIds.size > 0 || allowedRoleIds.size > 0;
  const memberRoleIds = getMemberRoleIds(message.member);

  if (hasRoleRestrictions && memberRoleIds === null) {
    return { allowed: false, reason: 'missing-member-roles' };
  }

  const roles = memberRoleIds || [];

  if (roles.some((roleId) => ignoredRoleIds.has(roleId))) {
    return { allowed: false, reason: 'ignored-role' };
  }

  if (allowedRoleIds.size > 0 && !roles.some((roleId) => allowedRoleIds.has(roleId))) {
    return { allowed: false, reason: 'role-not-allowed' };
  }

  return { allowed: true, reason: 'allowed' };
}

function createAccessPolicy(options = {}) {
  const guildConfigService = options.guildConfigService;

  if (!guildConfigService || typeof guildConfigService.getStatus !== 'function') {
    throw new TypeError('guild config service is required');
  }

  async function getGuildStatus(subject) {
    const guildId = getGuildId(subject);

    if (!guildId) {
      return null;
    }

    return guildConfigService.getStatus(guildId);
  }

  async function evaluateMessage(message) {
    if (message?.author?.bot) {
      return { allowed: false, reason: 'bot' };
    }

    if (message?.webhookId || message?.webhook) {
      return { allowed: false, reason: 'webhook' };
    }

    if (!getGuildId(message)) {
      return { allowed: false, reason: 'dm' };
    }

    try {
      return evaluateMessageAccess(message, await getGuildStatus(message));
    } catch {
      return { allowed: false, reason: 'config-unavailable' };
    }
  }

  async function isMessageAllowed(message) {
    return (await evaluateMessage(message)).allowed;
  }

  async function evaluateChannel(channel) {
    if (!getGuildId(channel)) {
      return { allowed: false, reason: 'dm' };
    }

    try {
      return evaluateGuildChannelAccess(channel, await getGuildStatus(channel));
    } catch {
      return { allowed: false, reason: 'config-unavailable' };
    }
  }

  async function isChannelEligible(channel) {
    return (await evaluateChannel(channel)).allowed;
  }

  return Object.freeze({
    evaluateChannel,
    evaluateMessage,
    isChannelEligible,
    isMessageAllowed,
  });
}

module.exports = {
  createAccessPolicy,
  evaluateGuildChannelAccess,
  evaluateMessageAccess,
  getChannelIds,
  getMemberRoleIds,
  hasManageMessagesPermission,
};
