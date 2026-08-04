const { PermissionFlagsBits } = require('discord.js');
const { funmuteMaxDurationMs } = require('../config/constants');

const funmuteCooldownMs = 5000;
const funmuteMaxSeconds = Math.floor(funmuteMaxDurationMs / 1000);
const lastFunmuteAtByGuild = new Map();

function consumeFunmuteCooldown(guildId = 'global', now = Date.now()) {
  // Preserve the former numeric test helper signature while scoping production
  // cooldowns per guild.
  const legacyNumericCall = typeof guildId === 'number';
  const scope = legacyNumericCall ? 'global' : String(guildId || 'global');
  const timestamp = legacyNumericCall ? guildId : now;
  const lastFunmuteAt = lastFunmuteAtByGuild.get(scope) ?? 0;
  if (timestamp - lastFunmuteAt < funmuteCooldownMs) {
    return false;
  }

  lastFunmuteAtByGuild.set(scope, timestamp);
  return true;
}

function resetFunmuteCooldown() {
  lastFunmuteAtByGuild.clear();
}

function resetGuildFunmuteCooldown(guildId) {
  return lastFunmuteAtByGuild.delete(String(guildId || 'global'));
}

function parseFunmuteSeconds(rawSeconds) {
  if (rawSeconds == null || rawSeconds === '') {
    return 3;
  }

  if (!/^\d+$/.test(String(rawSeconds).trim())) {
    return null;
  }

  const seconds = Number(rawSeconds);

  if (!Number.isInteger(seconds) || seconds < 1 || seconds > funmuteMaxSeconds) {
    return null;
  }

  return seconds;
}

function getFunmuteCommandBody(content) {
  return String(content).trim().replace(/^!funmute\b/i, '').trim();
}

function getFunmuteDurationMs(rawSeconds) {
  const seconds = parseFunmuteSeconds(rawSeconds);

  if (seconds == null) {
    return null;
  }

  return seconds * 1000;
}

function parseFunmuteCommand(content) {
  const body = getFunmuteCommandBody(content);

  if (!body) {
    return null;
  }

  const parts = body.split(/\s+/).filter(Boolean);

  if (parts.length < 1 || parts.length > 2) {
    return null;
  }

  if (parts.length === 2 && parseFunmuteSeconds(parts[1]) == null) {
    return null;
  }

  return {
    targetText: parts[0],
    seconds: parseFunmuteSeconds(parts[1]) ?? 3,
  };
}

function getFunmuteValidationError(message, requesterMember, botMember, targetMember) {
  if (!message.guild) {
    return 'This one only works in a server, not in DMs.';
  }

  if (!targetMember) {
    return 'You need to mention a guild member to funmute.';
  }

  if (targetMember.guild?.id !== message.guild.id) {
    return 'You need to mention a guild member to funmute.';
  }

  if (!requesterMember) {
    return 'I could not verify your server permissions.';
  }

  if (!requesterMember.permissions?.has?.(PermissionFlagsBits.ModerateMembers)) {
    return 'You need Moderate Members to use funmute.';
  }

  if (!botMember) {
    return 'I could not find my guild member entry.';
  }

  if (!botMember.permissions?.has?.(PermissionFlagsBits.ModerateMembers)) {
    return 'I need Moderate Members before I can funmute anyone.';
  }

  if (targetMember.id === requesterMember.id) {
    return 'No self-bonks. Pick another target.';
  }

  if (targetMember.user?.bot) {
    return 'I am not timing out a bot. Bots stay weird on purpose.';
  }

  if (targetMember.id === message.guild.ownerId) {
    return 'The guild owner is off-limits.';
  }

  if (requesterMember.id !== message.guild.ownerId) {
    const requesterRole = requesterMember.roles?.highest;
    const targetRole = targetMember.roles?.highest;
    const requesterRolePosition = requesterRole && typeof requesterRole.comparePositionTo === 'function'
      ? requesterRole.comparePositionTo(targetRole)
      : null;

    if (!Number.isFinite(requesterRolePosition) || requesterRolePosition <= 0) {
      return 'Your highest role needs to be above the target\'s role.';
    }
  }

  const botRole = botMember.roles?.highest;
  const targetRole = targetMember.roles?.highest;
  const botRolePosition = botRole && typeof botRole.comparePositionTo === 'function'
    ? botRole.comparePositionTo(targetRole)
    : null;

  if (!Number.isFinite(botRolePosition) || botRolePosition <= 0) {
    return 'My role needs to be above the target for that.';
  }

  if (targetMember.moderatable === false) {
    return 'Discord will not let me timeout that member.';
  }

  return null;
}

function getFunmuteUsageMessage() {
  return `Usage: \`!funmute @member [seconds]\` with 1-${funmuteMaxSeconds} seconds max.`;
}

module.exports = {
  consumeFunmuteCooldown,
  funmuteCooldownMs,
  funmuteMaxSeconds,
  getFunmuteCommandBody,
  getFunmuteDurationMs,
  getFunmuteUsageMessage,
  getFunmuteValidationError,
  parseFunmuteCommand,
  parseFunmuteSeconds,
  resetFunmuteCooldown,
  resetGuildFunmuteCooldown,
};
