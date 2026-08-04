const { blockedAllowedMentions } = require('../config/constants');
const { sanitizeDiscordMentions } = require('../discord/mentions');
const maxRoleplayResponseCharacters = 16_000;
function buildRoleplaySafeMessageOptions(content) { return { content: sanitizeDiscordMentions(content), allowedMentions: blockedAllowedMentions }; }
async function sendRoleplayReply(message, content) { return sendRoleplayChunks((options) => message.reply(options), content); }
async function sendRoleplayChunks(sendChunk, content) {
  const sourceContent = String(content ?? '');
  const boundedContent = sourceContent.length > maxRoleplayResponseCharacters
    ? `${sourceContent.slice(0, maxRoleplayResponseCharacters - 1)}…`
    : sourceContent;
  const safeContent = sanitizeDiscordMentions(boundedContent);
  if (safeContent.length <= 2000) return sendChunk({ content: safeContent, allowedMentions: blockedAllowedMentions });
  const chunks = [];
  let remaining = safeContent;
  while (remaining.length > 0) {
    if (remaining.length <= 2000) { chunks.push(remaining); break; }
    let splitIndex = remaining.lastIndexOf('\n', 2000);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(' ', 2000);
    if (splitIndex === -1) splitIndex = 2000;
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }
  let lastMessage = null;
  for (const chunk of chunks) lastMessage = await sendChunk({ content: chunk, allowedMentions: blockedAllowedMentions });
  return lastMessage;
}
module.exports = { buildRoleplaySafeMessageOptions, maxRoleplayResponseCharacters, sendRoleplayChunks, sendRoleplayReply };
