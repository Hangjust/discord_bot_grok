const { grokHelpCommandName } = require('../config/constants');

function isGrokHelpCommand(content) {
  return String(content).trim().toLowerCase() === grokHelpCommandName;
}

function getGrokHelpMessage() {
  return [
    '**Grok command menu**',
    '`grok <message>` - ask Grok anything. Only replies when `grok` is first.',
    '`@bot <message>` - ask by directly mentioning the bot.',
    "`grok lore` - tell this channel's running-joke lore from local context.",
    '`grok stats` - show your top monthly words and short phrases.',
    '`grok who is @user` - funny monthly vibe check for a user.',
    '`grok new` - reset this channel conversation.',
    '`!grok help` - show this menu.',
    '`!ping` - quick bot check.',
    '`!blud`, `!blud off`, `!blud <text>` - blud mode controls/translator.',
    '`!funmute @member [1-3]` - short timeout gag for moderators.',
    '`!ratio` - reply to someone and Grok ratios them.',
    '',
    'Passive memory: I read non-excluded server messages for local context and monthly style/topic summaries, but user stats/vibe checks only show up for explicit lookups like `grok stats` or `grok who is @user`.',
  ].join('\n');
}

module.exports = {
  getGrokHelpMessage,
  isGrokHelpCommand,
};
