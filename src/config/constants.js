function readCsvEnv(name) {
  return Object.freeze(String(process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean));
}

const factCheckContextMessage = 'Hey, is this true? Reply with yes/no. If it looks like a joke, assume it is 90% of the time when it does not make sense. Say yes to something bizarre when appropriate. Answer with yes/no plus at most 2 sentences, including something bizarre you can think of. Try to keep it short, if you can answer within max 6-10 words, yes + the words, if not then and only then are you allowed to use the 2 sentence as maximum. But do NOT go off topic, so when someone is talking about x, do not jump to y or z, stay on the subject until the user specificly asks you to switch topics or if the user switches topics';
const conversationInactivityMs = 2 * 60 * 60 * 1000;
const idleChatterInactivityMs = 3 * 60 * 60 * 1000;
const maxConversationMessages = 20;
const blockedAllowedMentions = Object.freeze({
  parse: Object.freeze([]),
  users: Object.freeze([]),
  roles: Object.freeze([]),
  repliedUser: false,
});
const readExcludedChannelIds = readCsvEnv('DISCORD_READ_EXCLUDED_CHANNEL_IDS');
const replyAllowedChannelIds = readCsvEnv('DISCORD_REPLY_ALLOWED_CHANNEL_IDS');
const protectedGlazeUserIds = readCsvEnv('PROTECTED_GLAZE_USER_IDS');
const aiHelpCommandName = '!ai-help';
const idleChatterMessages = Object.freeze([
  'bro its dead quiet here',
  'yo shut up no one asked you',
  'alright...',
]);
const webSearchDefaultMaxResults = 3;
const webSearchAppendSourceLimit = 3;
const webSearchDefaultTimeoutMs = 5000;
const webSearchMaxResultsLimit = 20;
const webSearchMinTimeoutMs = 1000;
const webSearchMaxTimeoutMs = 30000;
const braveSearchEndpoint = 'https://api.search.brave.com/res/v1/web/search';

module.exports = {
  blockedAllowedMentions,
  braveSearchEndpoint,
  conversationInactivityMs,
  factCheckContextMessage,
  aiHelpCommandName,
  idleChatterInactivityMs,
  idleChatterMessages,
  maxConversationMessages,
  protectedGlazeUserIds,
  readExcludedChannelIds,
  replyAllowedChannelIds,
  webSearchAppendSourceLimit,
  webSearchDefaultMaxResults,
  webSearchDefaultTimeoutMs,
  webSearchMaxResultsLimit,
  webSearchMaxTimeoutMs,
  webSearchMinTimeoutMs,
};
