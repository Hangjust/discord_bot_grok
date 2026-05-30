const { sanitizeDiscordMentions } = require('../discord/mentions');

function getCooldownFlavor(spamLevel) {
  if (spamLevel === 'feral') {
    return 'Spam goblin detected. I am answering, but I am filing emotional damages.';
  }

  if (spamLevel === 'annoyed') {
    return 'You are poking the Grok cage a lot right now.';
  }

  return '';
}

function getTemporaryNicknameFlavor(userProfileSummary = '', spamLevel = 'normal') {
  if (spamLevel === 'feral') {
    return 'temporary nickname: Notification Goblin';
  }

  return '';
}

function applyReplyFlavor(reply, { cooldownFlavor = '', nicknameFlavor = '' } = {}) {
  const prefixes = [cooldownFlavor, nicknameFlavor].filter(Boolean);

  if (prefixes.length === 0) {
    return reply;
  }

  return sanitizeDiscordMentions(`${prefixes.join(' ')} ${reply}`);
}

module.exports = {
  applyReplyFlavor,
  getCooldownFlavor,
  getTemporaryNicknameFlavor,
};
