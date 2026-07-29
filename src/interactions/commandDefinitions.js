const {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');

const AI_HELP_COMMAND_NAME = 'ai-help';
const AI_SETUP_COMMAND_NAME = 'ai-setup';
const AGENT_BEHAVIOR_MAX_LENGTH = 4000;
const agentChannelTypes = Object.freeze([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

const aiHelpCommand = new SlashCommandBuilder()
  .setName(AI_HELP_COMMAND_NAME)
  .setDescription('Show every AI command, setup option, example, and privacy note')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);

const aiSetupCommand = new SlashCommandBuilder()
  .setName(AI_SETUP_COMMAND_NAME)
  .setDescription('Configure the AI bot for this server')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((command) => command
    .setName('status')
    .setDescription('Show safe setup status without revealing keys or prompt text'))
  .addSubcommand((command) => command
    .setName('api')
    .setDescription('Choose DeepSeek or Gemma 4 and set its encrypted API key')
    .addStringOption((option) => option
      .setName('provider')
      .setDescription('AI provider for this server')
      .setRequired(true)
      .addChoices(
        { name: 'DeepSeek', value: 'deepseek' },
        { name: 'Gemma 4 (Gemini API)', value: 'gemma4' },
      ))
    .addBooleanOption((option) => option
      .setName('web-search')
      .setDescription('Also configure and enable Brave web search')))
  .addSubcommand((command) => command
    .setName('channel')
    .setDescription('Update channel access')
    .addStringOption((option) => option
      .setName('action')
      .setDescription('Access-list action')
      .setRequired(true)
      .addChoices(
        { name: 'Allow', value: 'allow' },
        { name: 'Ignore', value: 'ignore' },
        { name: 'Remove', value: 'remove' },
      ))
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Channel or exact thread to update')
      .addChannelTypes(...agentChannelTypes)
      .setRequired(true)))
  .addSubcommand((command) => command
    .setName('role')
    .setDescription('Update role access')
    .addStringOption((option) => option
      .setName('action')
      .setDescription('Access-list action')
      .setRequired(true)
      .addChoices(
        { name: 'Allow', value: 'allow' },
        { name: 'Ignore', value: 'ignore' },
        { name: 'Remove', value: 'remove' },
      ))
    .addRoleOption((option) => option
      .setName('role')
      .setDescription('Role to update')
      .setRequired(true)))
  .addSubcommand((command) => command
    .setName('web')
    .setDescription('Enable or disable Brave web search')
    .addStringOption((option) => option
      .setName('action')
      .setDescription('Web-search action')
      .setRequired(true)
      .addChoices(
        { name: 'Enable', value: 'enable' },
        { name: 'Disable', value: 'disable' },
      )))
  .addSubcommand((command) => command
    .setName('prompt')
    .setDescription('Status, set, export, or clear a custom prompt')
    .addStringOption((option) => option
      .setName('action')
      .setDescription('Prompt action')
      .setRequired(true)
      .addChoices(
        { name: 'Status', value: 'status' },
        { name: 'Set', value: 'set' },
        { name: 'Export', value: 'export' },
        { name: 'Clear', value: 'clear' },
      ))
    .addStringOption((option) => option
      .setName('scope')
      .setDescription('Server prompt or exact-channel prompt')
      .setRequired(true)
      .addChoices(
        { name: 'Server', value: 'server' },
        { name: 'Channel', value: 'channel' },
      ))
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Exact channel; defaults to the current channel for channel scope')
      .addChannelTypes(...agentChannelTypes))
    .addStringOption((option) => option
      .setName('text')
      .setDescription('Prompt Markdown; omit text/file to open a popup')
      .setMaxLength(AGENT_BEHAVIOR_MAX_LENGTH))
    .addAttachmentOption((option) => option
      .setName('file')
      .setDescription('UTF-8 Markdown file containing the prompt')))
  .addSubcommand((command) => command
    .setName('trigger')
    .setDescription('Change the word used to call the bot in text messages')
    .addStringOption((option) => option
      .setName('value')
      .setDescription('For example: AI or llm')
      .setMinLength(1)
      .setMaxLength(24)
      .setRequired(true)))
  .addSubcommand((command) => command
    .setName('reset')
    .setDescription('Clear credentials, access rules, prompts, and custom trigger'));

const commandDefinitions = Object.freeze([
  aiHelpCommand.toJSON(),
  aiSetupCommand.toJSON(),
].map(Object.freeze));

module.exports = {
  AGENT_BEHAVIOR_MAX_LENGTH,
  AI_HELP_COMMAND_NAME,
  AI_SETUP_COMMAND_NAME,
  commandDefinitions,
  aiHelpCommand,
  aiSetupCommand,
};
