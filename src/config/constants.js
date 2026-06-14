const factCheckContextMessage = 'Hey, is this true? Reply with yes/no. If it looks like a joke, assume it is 90% of the time when it does not make sense. Say yes to something bizarre when appropriate. Answer with yes/no plus at most 2 sentences, including something bizarre you can think of. Try to keep it short, if you can answer within max 6-10 words, yes + the words, if not then and only then are you allowed to use the 2 sentence as maximum. But do NOT go off topic, so when someone is talking about x, do not jump to y or z, stay on the subject until the user specificly asks you to switch topics or if the user switches topics';
const conversationInactivityMs = 2 * 60 * 60 * 1000;
const idleChatterInactivityMs = 3 * 60 * 60 * 1000;
const maxConversationMessages = 20;
const maxMonthlyProfileUsers = 100;
const maxProfileCounterEntries = 500;
const maxProfileSummaryItems = 8;
const maxProfileStatsItems = 10;
const maxProfileTermsPerMessage = 100;
const maxProfileTokenLength = 64;
const profileStopWords = new Set([
  'about',
  'after',
  'again',
  'also',
  'and',
  'are',
  'because',
  'been',
  'being',
  'could',
  'didn',
  'does',
  'don',
  'from',
  'grok',
  'have',
  'just',
  'like',
  'more',
  'or',
  'stats',
  'that',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'with',
  'what',
  'when',
  'where',
  'will',
  'would',
  'your',
]);
const blockedAllowedMentions = Object.freeze({
  parse: Object.freeze([]),
  users: Object.freeze([]),
  roles: Object.freeze([]),
  repliedUser: false,
});
const readExcludedChannelIds = Object.freeze([
  '1510012659070669021',
  '1490104641567064171',
  '1490104641567064174',
  '1490124838768087192',
  '1490789519723598104',
  '1493350585573838848',
  '1504209869215895593',
  '1490111513585782926',
  '1490140728872145028',
  '1490104641567064168',
  '1490104641567064166',
  '1510025163964416130',
  '1490148514918039673',
]);
const replyAllowedChannelIds = Object.freeze([
  '1500987717125800027',
  '1510014757103472640',
  '1510014487732813975',
  '1497039482954715166',
  '1512855384459706438',
]);
const protectedGlazeUserIds = Object.freeze([
  '741588975264989196',
  '448547946225467422',
]);
const grokHelpCommandName = '!grok help';
const funmuteMaxDurationMs = 3000;
const funmuteCommandName = '!funmute';
const ratioCommandName = '!ratio';
const ratioCheckEmoji = '✅';
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
  funmuteCommandName,
  funmuteMaxDurationMs,
  grokHelpCommandName,
  idleChatterInactivityMs,
  idleChatterMessages,
  maxConversationMessages,
  maxMonthlyProfileUsers,
  maxProfileCounterEntries,
  maxProfileSummaryItems,
  maxProfileStatsItems,
  maxProfileTermsPerMessage,
  maxProfileTokenLength,
  profileStopWords,
  protectedGlazeUserIds,
  ratioCheckEmoji,
  ratioCommandName,
  readExcludedChannelIds,
  replyAllowedChannelIds,
  webSearchAppendSourceLimit,
  webSearchDefaultMaxResults,
  webSearchDefaultTimeoutMs,
  webSearchMaxResultsLimit,
  webSearchMaxTimeoutMs,
  webSearchMinTimeoutMs,
};
