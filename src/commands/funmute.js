const { PermissionFlagsBits } = require('discord.js');

const funmuteCooldownMs = 5000;
let lastFunmuteAt = 0;

function consumeFunmuteCooldown(now = Date.now()) {
  if (now - lastFunmuteAt < funmuteCooldownMs) {
    return false;
  }

  lastFunmuteAt = now;
  return true;
}

function resetFunmuteCooldown() {
  lastFunmuteAt = 0;
}

function parseFunmuteSeconds(rawSeconds) {
  if (rawSeconds == null || rawSeconds === '') {
    return 3;
  }

  if (!/^\d+$/.test(String(rawSeconds).trim())) {
    return null;
  }

  const seconds = Number(rawSeconds);

  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3) {
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

  if (!botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return 'I need Moderate Members before I can bonk anyone.';
  }

  if (!targetMember) {
    return 'You need to mention a guild member to funmute.';
  }

  if (targetMember.guild.id !== message.guild.id) {
    return 'You need to mention a guild member to funmute.';
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

  if (botMember.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
    return 'My role needs to be above the target for that.';
  }

  return null;
}

function getFunmuteUsageMessage() {
  return 'Usage: `!funmute @member [seconds]` with 1-3 seconds max.';
}

module.exports = {
  consumeFunmuteCooldown,
  funmuteCooldownMs,
  getFunmuteCommandBody,
  getFunmuteDurationMs,
  getFunmuteUsageMessage,
  getFunmuteValidationError,
  parseFunmuteCommand,
  parseFunmuteSeconds,
  resetFunmuteCooldown,
};
