const { deepSeekApiKey } = require('../config/env');
const { sanitizeDiscordMentions } = require('../discord/mentions');
const { getPlainGrokText, isNewConversationCommand, isPlainGrokTrigger } = require('../grok/triggers');
const { closeRoleplayTicketChannel } = require('./close');
const { getRoleplayLevel, getRoleplayPrompt, isRoleplayCloseCommand } = require('./config');
const { generateRoleplayReply, getRoleplayDeepSeekFailureMessage } = require('./deepseek');
const { getRoleplayRateLimitMessage, isRoleplayRateLimited, isRoleplayTicketMessageLimitReached, recordRoleplayAiMessage } = require('./rateLimit');
const { sendRoleplayReply } = require('./replies');
const { appendRoleplayTurn, getRoleplaySession, getRoleplaySessionKey } = require('./sessions');
const { recognizeRoleplayTicketChannel } = require('./tickets');
async function handleRoleplayMessage(message, options = {}) {
  const recognition = recognizeRoleplayTicketChannel(message);
  if (recognition.kind === 'none') return false;
  if (recognition.kind === 'orphaned') { await sendRoleplayReply(message, 'This looks like a roleplay ticket from before my last restart, but its in-memory state is gone. Ask a mod to delete it and create a new roleplay ticket so I do not mix state.'); return true; }
  const ticket = recognition.ticket;
  if (message.author.id !== ticket.openerUserId) { await sendRoleplayReply(message, 'Only the player who opened this roleplay ticket can drive the narrator here. Open your own ticket from the roleplay panel.'); return true; }
  if (ticket.status !== 'open') { await sendRoleplayReply(message, 'This roleplay ticket is closed. Create a new ticket to start again.'); return true; }
  if (isPlainGrokTrigger(message.content) && isNewConversationCommand(getPlainGrokText(message.content))) { await sendRoleplayReply(message, 'Use `!roleplay close` to close this roleplay ticket, then open a new one from the panel.'); return true; }
  if (isRoleplayCloseCommand(message.content)) {
    await sendRoleplayReply(message, 'Roleplay ticket closed.');
    await closeRoleplayTicketChannel({ channel: message.channel, channelId: message.channelId, userId: message.author.id });
    return true;
  }
  if ((!getRoleplayPrompt(ticket.promptId) && !ticket.promptText) || !getRoleplayLevel(ticket.levelId)) { await sendRoleplayReply(message, 'This roleplay ticket has invalid setup data. Please close it and create a new ticket.'); return true; }
  const userText = String(message.content ?? '').trim();
  if (!userText) return true;
  const sessionKey = getRoleplaySessionKey({ guildId: ticket.guildId, channelId: ticket.channelId, userId: message.author.id, ticketId: ticket.ticketId });
  const rateLimitKey = `${ticket.guildId}:${message.author.id}`;
  if (isRoleplayRateLimited(rateLimitKey) || isRoleplayTicketMessageLimitReached(ticket.ticketId)) { await sendRoleplayReply(message, getRoleplayRateLimitMessage()); return true; }
  if (!deepSeekApiKey && !options.generateReply) { await sendRoleplayReply(message, 'I need a DEEPSEEK_API_KEY in .env before I can narrate roleplay.'); return true; }
  const session = getRoleplaySession(sessionKey);
  const generateReply = options.generateReply ?? generateRoleplayReply;
  try {
    if (message.channel?.sendTyping) await message.channel.sendTyping();
    recordRoleplayAiMessage(rateLimitKey, ticket.ticketId);
    const safeReply = sanitizeDiscordMentions(await generateReply(userText, ticket, session));
    appendRoleplayTurn(session, userText, safeReply);
    await sendRoleplayReply(message, safeReply);
  } catch (error) { console.error(error); await sendRoleplayReply(message, getRoleplayDeepSeekFailureMessage(error)); }
  return true;
}
module.exports = { handleRoleplayMessage };
