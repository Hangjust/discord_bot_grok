function isPlainGrokTrigger(content) {
  return /^grok\b/i.test(content.trim());
}

function getPlainGrokText(content) {
  return content
    .trim()
    .replace(/^grok\b[?!.:,;\s-]*/i, '')
    .trim();
}

function shouldReplyToMessage(content, mentionsBot) {
  return mentionsBot || isPlainGrokTrigger(content);
}

function isNewConversationCommand(text) {
  return /^new$/i.test(text.trim());
}

module.exports = {
  getPlainGrokText,
  isNewConversationCommand,
  isPlainGrokTrigger,
  shouldReplyToMessage,
};
