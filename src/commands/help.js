const { EmbedBuilder } = require('discord.js');
const {
  DEFAULT_TRIGGER_WORD,
} = require('../config/guildConfigSchema');
const { aiHelpCommandName } = require('../config/constants');

const HELP_COLOR = 0x5865F2;
const DISCORD_MESSAGE_LIMIT = 2000;
const HELP_CHUNK_LIMIT = 1900;

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

function getHelpCatalog(triggerWord = DEFAULT_TRIGGER_WORD) {
  const trigger = String(triggerWord || DEFAULT_TRIGGER_WORD);
  return deepFreeze([
    { id: 'ask', category: 'chat', invocation: `${trigger}/@bot <message>`, description: 'Ask the AI using the trigger word or a direct bot mention.', example: `${trigger} explain black holes`, permission: 'Members allowed by access policy' },
    { id: 'new', category: 'chat', invocation: `${trigger} new`, description: 'Reset this exact channel’s in-memory conversation.', example: `${trigger} new`, permission: 'Members allowed by access policy' },
    { id: 'keys', category: 'chat', invocation: `${trigger} key`, description: 'Show official links for getting supported AI API keys.', example: `${trigger} key`, permission: 'Members allowed by access policy' },
    { id: 'setup-status', category: 'setup', invocation: '/ai-setup status', description: 'Show safe configuration status.', example: '/ai-setup status', permission: 'Administrators' },
    { id: 'setup-api', category: 'setup', invocation: '/ai-setup api', description: 'Choose DeepSeek, Gemma 4, or image-capable Qwen and configure its encrypted API key.', example: '/ai-setup api provider:qwen web-search:false', permission: 'Administrators' },
    { id: 'setup-channel', category: 'setup', invocation: '/ai-setup channel', description: 'Allow, ignore, or remove a channel from access policy.', example: '/ai-setup channel action:allow channel:#general', permission: 'Administrators' },
    { id: 'setup-role', category: 'setup', invocation: '/ai-setup role', description: 'Allow, ignore, or remove a role from access policy.', example: '/ai-setup role action:allow role:@member', permission: 'Administrators' },
    { id: 'setup-web', category: 'setup', invocation: '/ai-setup web', description: 'Enable or disable Brave web search.', example: '/ai-setup web action:disable', permission: 'Administrators' },
    { id: 'setup-prompt', category: 'setup', invocation: '/ai-setup prompt', description: 'Status, set, export, or clear a server/exact-channel custom prompt.', example: '/ai-setup prompt action:status scope:server', permission: 'Administrators' },
    { id: 'setup-trigger', category: 'setup', invocation: '/ai-setup trigger', description: 'Change the text trigger word used to call the bot.', example: '/ai-setup trigger value:llm', permission: 'Administrators' },
    { id: 'branding-name', category: 'setup', invocation: '!AI name <new name>', description: 'Change the bot’s nickname only in this server.', example: '!AI name Server Assistant', permission: 'Server owner or Administrators' },
    { id: 'branding-pfp', category: 'setup', invocation: '!AI pfp + image', description: 'Change the bot’s profile picture only in this server.', example: '!AI pfp with one attached image', permission: 'Server owner or Administrators' },
    { id: 'branding-pfp-reset', category: 'setup', invocation: '!AI pfp reset', description: 'Restore the normal bot profile picture in this server.', example: '!AI pfp reset', permission: 'Server owner or Administrators' },
    { id: 'setup-reset', category: 'setup', invocation: '/ai-setup reset', description: 'Clear credentials, access rules, prompts, and the custom trigger after confirmation.', example: '/ai-setup reset', permission: 'Administrators' },
  ]);
}

const helpCatalog = getHelpCatalog();

const helpNotes = deepFreeze([
  'The default trigger word is `AI`. Matching is case-insensitive and uses an exact word boundary.',
]);

function isAiHelpCommand(content) {
  return String(content).trim().toLowerCase() === aiHelpCommandName;
}

function isHelpCommand(content, triggerWord = DEFAULT_TRIGGER_WORD) {
  const normalized = String(content).trim();
  if (/^help$/i.test(normalized) || isAiHelpCommand(normalized)) {
    return true;
  }

  const trigger = String(triggerWord || DEFAULT_TRIGGER_WORD)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${trigger}\\s+help$`, 'i').test(normalized);
}

function catalogLines(catalog, category) {
  return catalog
    .filter((entry) => entry.category === category)
    .map((entry) => `**\`${entry.invocation}\`** — ${entry.description}\n*${entry.permission} · Example: \`${entry.example}\`*`)
    .join('\n\n');
}

function getHelpEmbedPages(options = {}) {
  const triggerWord = String(options.triggerWord || DEFAULT_TRIGGER_WORD);
  const catalog = getHelpCatalog(triggerWord);
  const guildName = String(options.guildName || 'this server');
  const common = (page, title) => {
    const embed = new EmbedBuilder()
      .setColor(HELP_COLOR)
      .setTitle(title)
      .setFooter({ text: `AI command guide • Page ${page}/2` })
      .setTimestamp();

    if (options.avatarUrl) {
      embed.setThumbnail(options.avatarUrl);
    }
    return embed;
  };

  const commands = common(1, '✨ AI Command Center')
    .setDescription(`Commands for **${guildName}**\nCurrent trigger: **\`${triggerWord}\`**`)
    .addFields(
      { name: '💬 Chat & memory', value: catalogLines(catalog, 'chat') },
    );

  const setup = common(2, '⚙️ Administrator Setup')
    .setDescription(
      'Type **`/ai-setup`** to access administrator setup commands. '
      + 'Type **`/ai-setup status`** to view the current setup status. '
      + 'Discord Administrator permission is required for all slash commands.',
    )
    .addFields({
      name: '🎨 Server bot profile',
      value: 'Owner/Admin: **`!AI name <new name>`**, attach one image with **`!AI pfp`**, or use **`!AI pfp reset`**.',
    });

  return Object.freeze([commands, setup]);
}

function renderHelpEntry(entry) {
  return [
    `\`${entry.invocation}\` — ${entry.description}`,
    `Example: \`${entry.example}\` · Permission: ${entry.permission}`,
  ].join('\n');
}

function splitHelpBlocks(blocks, limit = HELP_CHUNK_LIMIT) {
  const pages = [];
  let current = '';

  for (const block of blocks) {
    if (block.length > limit) {
      throw new RangeError('A help catalog block exceeds the Discord page limit');
    }
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > limit) {
      pages.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }

  if (current) pages.push(current);
  return pages;
}

function getAiHelpPages(triggerWord = DEFAULT_TRIGGER_WORD) {
  const blocks = [
    '**AI command menu**',
    ...getHelpCatalog(triggerWord).map(renderHelpEntry),
    ...helpNotes,
  ];
  return Object.freeze(splitHelpBlocks(blocks).map((page, index, pages) => (
    pages.length > 1 ? `${page}\n\n_Page ${index + 1}/${pages.length}_` : page
  )));
}

function getAiHelpMessage(triggerWord = DEFAULT_TRIGGER_WORD) {
  return getAiHelpPages(triggerWord).join('\n\n');
}

module.exports = {
  DISCORD_MESSAGE_LIMIT,
  HELP_CHUNK_LIMIT,
  HELP_COLOR,
  getAiHelpMessage,
  getAiHelpPages,
  getHelpCatalog,
  getHelpEmbedPages,
  helpCatalog,
  helpNotes,
  isAiHelpCommand,
  isHelpCommand,
  renderHelpEntry,
  splitHelpBlocks,
};
