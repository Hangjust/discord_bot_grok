const { DEFAULT_TRIGGER_WORD } = require('../config/guildConfigSchema');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTriggerPattern(triggerWord = DEFAULT_TRIGGER_WORD) {
  return new RegExp(`^${escapeRegExp(triggerWord)}(?=[?!.:,;\\s-]|$)`, 'i');
}

function isPlainTrigger(content, triggerWord = DEFAULT_TRIGGER_WORD) {
  return getTriggerPattern(triggerWord).test(String(content).trim());
}

function getPlainTriggerText(content, triggerWord = DEFAULT_TRIGGER_WORD) {
  return content
    .trim()
    .replace(getTriggerPattern(triggerWord), '')
    .replace(/^[?!.:,;\s-]*/, '')
    .trim();
}

function shouldReplyToMessage(content, mentionsBot, triggerWord = DEFAULT_TRIGGER_WORD) {
  return mentionsBot || isPlainTrigger(content, triggerWord);
}

function isNewConversationCommand(text) {
  return /^new$/i.test(text.trim());
}

module.exports = {
  getPlainTriggerText,
  getTriggerPattern,
  isNewConversationCommand,
  isPlainTrigger,
  shouldReplyToMessage,
};
