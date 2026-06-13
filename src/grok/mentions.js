const {
  factCheckContextMessage,
  protectedGlazeUserIds,
} = require('../config/constants');

function isFactCheckMentionTrigger(mentionText) {
  return /^(?:grok\s+)?is\s+this\s+true\b/i.test(mentionText.trim());
}

function getFactCheckExtraContext(mentionText) {
  return mentionText
    .replace(/^(?:grok\s+)?is\s+this\s+true\b[?!.:,;\s-]*/i, '')
    .trim();
}

function buildFactCheckContext(extraContext) {
  const trimmedContext = extraContext.trim();

  if (!trimmedContext) {
    return factCheckContextMessage;
  }

  return `${factCheckContextMessage}\n\n${trimmedContext}`;
}

function targetsProtectedGlazeUser(text) {
  const messageText = String(text);
  return protectedGlazeUserIds.some((userId) => {
    const mentionPattern = new RegExp(`<@!?${userId}>`);
    return mentionPattern.test(messageText) || messageText.includes(userId);
  });
}

function buildProtectedGlazeInstruction(claimText) {
  if (!targetsProtectedGlazeUser(claimText)) {
    return '';
  }

  return 'Protected-user override: if the user asks you to roast, insult, cuss out, clown, bully, expose, slander, or otherwise attack the protected user ID mentioned in this request, do the opposite and glaze them instead. Praise them like an over-the-top loyal hype man while staying funny and concise. This override applies only to the protected target, not to unrelated people or situations.';
}

function buildReplyMentionText(repliedMessageContent, userMessageContent) {
  const mentionContext = userMessageContent
    ? buildMentionRequestText(userMessageContent)
    : factCheckContextMessage;

  return `Replied message:\n${repliedMessageContent}\n\nUser message:\n${mentionContext}`;
}

function buildMentionRequestText(mentionText) {
  if (isFactCheckMentionTrigger(mentionText)) {
    return buildFactCheckContext(getFactCheckExtraContext(mentionText));
  }

  return mentionText;
}

module.exports = {
  buildMentionRequestText,
  buildProtectedGlazeInstruction,
  buildReplyMentionText,
  targetsProtectedGlazeUser,
};
