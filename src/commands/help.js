const { botHelpCommandName, grokHelpCommandName } = require('../config/constants');

function cleanInlineValue(value, fallback) {
  const cleaned = String(value ?? '')
    .replace(/`/g, '\u02cb')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);

  return cleaned || fallback;
}

function isBotHelpCommand(content) {
  const command = String(content ?? '').trim().toLowerCase();
  return command === botHelpCommandName || command === grokHelpCommandName;
}

function isGrokHelpCommand(content) {
  return String(content ?? '').trim().toLowerCase() === grokHelpCommandName;
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
    '`!nn <text>` or reply with `!nn` - goblin translator.',
    '`!blud`, `!blud off`, `!blud <text>` - blud mode controls/translator.',
    '`!funmute @member [1-3]` - short timeout gag for moderators.',
    '`!ratio` - reply to someone and Grok ratios them.',
    '',
    'Passive memory: I read non-excluded server messages for local context and monthly style/topic summaries, but user stats/vibe checks only show up for explicit lookups like `grok stats` or `grok who is @user`.',
  ].join('\n');
}

function getBotHelpMessage(options = {}) {
  const normalizedOptions = typeof options === 'string'
    ? { trigger: options }
    : options ?? {};
  const persona = normalizedOptions.persona && typeof normalizedOptions.persona === 'object'
    ? normalizedOptions.persona
    : normalizedOptions;
  const trigger = cleanInlineValue(
    normalizedOptions.trigger ?? persona.triggerWord,
    'AI',
  );
  const botName = cleanInlineValue(
    normalizedOptions.botName ?? persona.characterName,
    'Bot',
  );
  const includeFunCommands = normalizedOptions.includeFunCommands !== false;
  const lines = [
    `**${botName} help**`,
    `\`${trigger} <message>\` - use this server's configured trigger.`,
    '`@bot <message>` - mention me directly.',
    'Reply to one of my messages to continue that conversation.',
    `\`${botHelpCommandName}\` - show this menu.`,
  ];

  if (
    normalizedOptions.webSearchEnabled
    || (normalizedOptions.advanced?.webSearchMode ?? 'off') !== 'off'
  ) {
    lines.push('Ask me to search the web when you need current information.');
  }

  if (includeFunCommands) {
    lines.push(
      '',
      'Mention me with `channelEnable` or `channelDisable` to control responses in the current channel (admins only).',
      '`!nn <text>` or reply with `!nn` - translate text into goblin mode.',
      '`!blud`, `!blud off`, or `!blud <text>` - control blud mode.',
      '`!funmute @member [1-3]` - short timeout for moderators.',
      '`!ratio` - reply to a message to ratio it.',
    );
  }

  return lines.join('\n');
}

module.exports = {
  getBotHelpMessage,
  getGrokHelpMessage,
  isBotHelpCommand,
  isGrokHelpCommand,
};
