const { ChannelType } = require('discord.js');

const THREAD_CHANNEL_TYPES = new Set([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  10,
  11,
  12,
  'ANNOUNCEMENT_THREAD',
  'GUILD_NEWS_THREAD',
  'PUBLIC_THREAD',
  'PRIVATE_THREAD',
]);

function getAccessConfig(config = {}) {
  return config?.access && typeof config.access === 'object' ? config.access : config;
}

function toIdSet(values) {
  if (values == null) return new Set();

  if (typeof values === 'string' || typeof values === 'number') {
    return new Set([String(values)]);
  }

  if (values instanceof Map) {
    return new Set([...values.keys()].map(String));
  }

  const iterable = typeof values[Symbol.iterator] === 'function' ? values : [];
  const ids = [];

  for (const value of iterable) {
    if (Array.isArray(value) && value.length === 2) {
      ids.push(String(value[0]));
    } else if (value && typeof value === 'object' && value.id != null) {
      ids.push(String(value.id));
    } else if (value != null) {
      ids.push(String(value));
    }
  }

  return new Set(ids);
}

function hasConfiguredIds(values) {
  if (values == null) return false;
  if (typeof values === 'string' || typeof values === 'number') return true;
  if (typeof values.size === 'number') return values.size > 0;
  if (typeof values.length === 'number') return values.length > 0;
  if (typeof values[Symbol.iterator] !== 'function') return false;
  return !values[Symbol.iterator]().next().done;
}

function configuredIdsInclude(values, targetId) {
  if (values == null || targetId == null) return false;
  const target = String(targetId);
  if (typeof values === 'string' || typeof values === 'number') {
    return String(values) === target;
  }
  if (values instanceof Map && values.has(target)) return true;
  if (typeof values[Symbol.iterator] !== 'function') return false;
  for (const value of values) {
    const candidate = Array.isArray(value) && value.length === 2
      ? value[0]
      : value && typeof value === 'object' && value.id != null
        ? value.id
        : value;
    if (candidate != null && String(candidate) === target) return true;
  }
  return false;
}

function memberHasConfiguredRole(member, configuredRoleIds) {
  if (!member || !hasConfiguredIds(configuredRoleIds)) return false;
  const roleCache = member.roles?.cache;
  if (typeof configuredRoleIds === 'string' || typeof configuredRoleIds === 'number') {
    const roleId = String(configuredRoleIds);
    return typeof roleCache?.has === 'function'
      ? roleCache.has(roleId)
      : getMemberRoleIds(member).has(roleId);
  }
  if (roleCache && typeof roleCache.has === 'function') {
    for (const roleId of configuredRoleIds) {
      const candidate = Array.isArray(roleId) && roleId.length === 2 ? roleId[0] : roleId?.id ?? roleId;
      if (candidate != null && roleCache.has(String(candidate))) return true;
    }
    return false;
  }
  const memberRoleIds = getMemberRoleIds(member);
  for (const roleId of configuredRoleIds) {
    const candidate = Array.isArray(roleId) && roleId.length === 2 ? roleId[0] : roleId?.id ?? roleId;
    if (candidate != null && memberRoleIds.has(String(candidate))) return true;
  }
  return false;
}

function unwrapChannel(channel) {
  if (channel?.channel) return channel.channel;
  return channel;
}

function isThreadChannel(channel) {
  const resolvedChannel = unwrapChannel(channel);

  if (typeof resolvedChannel?.isThread === 'function') {
    return resolvedChannel.isThread();
  }

  return THREAD_CHANNEL_TYPES.has(resolvedChannel?.type);
}

function isChannelAllowed(channel, config = {}) {
  const resolvedChannel = unwrapChannel(channel);
  const access = getAccessConfig(config);
  const allowedChannelIds = access?.channelIds;

  // A guild without an explicit channel allowlist is intentionally disabled.
  if (!hasConfiguredIds(allowedChannelIds) || !resolvedChannel) return false;

  const channelId = resolvedChannel.id ?? channel?.channelId;
  if (configuredIdsInclude(allowedChannelIds, channelId)) return true;

  // Selecting a forum/text parent also opts its threads in. Category parents do
  // not implicitly opt every child channel in.
  return isThreadChannel(resolvedChannel)
    && resolvedChannel.parentId != null
    && configuredIdsInclude(allowedChannelIds, resolvedChannel.parentId);
}

function getMemberRoleIds(member) {
  if (!member) return new Set();

  if (member.roles?.cache) {
    return toIdSet(member.roles.cache);
  }

  return toIdSet(member.roleIds ?? member.roles);
}

function isMemberBlocked(member, config = {}) {
  const access = getAccessConfig(config);
  return memberHasConfiguredRole(member, access?.blockedRoleIds);
}

function canMemberInteract(member, config = {}) {
  const access = getAccessConfig(config);

  // Deny rules are evaluated first and always take precedence over allow rules.
  if (isMemberBlocked(member, access)) return false;

  const allowedRoleIds = access?.allowedRoleIds;
  if (!hasConfiguredIds(allowedRoleIds)) return true;
  return memberHasConfiguredRole(member, allowedRoleIds);
}

function canAccessChat(message, config = {}) {
  if (!message?.guildId && !message?.guild?.id) return false;
  return isChannelAllowed(message.channel ?? message, config)
    && canMemberInteract(message.member, config);
}

module.exports = {
  canAccessChat,
  canMemberInteract,
  configuredIdsInclude,
  getMemberRoleIds,
  isChannelAllowed,
  isMemberBlocked,
  isThreadChannel,
  memberHasConfiguredRole,
  toIdSet,
};
