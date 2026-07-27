const {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');

const GUILD_CONFIG_COMMAND_NAME = 'grok-config';

const guildConfigCommand = new SlashCommandBuilder()
  .setName(GUILD_CONFIG_COMMAND_NAME)
  .setDescription('Configure Grok for this server')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((command) => command
    .setName('setup')
    .setDescription('Start or replace this server configuration'))
  .addSubcommand((command) => command
    .setName('status')
    .setDescription('Show configuration status without revealing secrets'))
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
      .setDescription('Channel to update')
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      )
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
    .setName('secret')
    .setDescription('Rotate a provider key')
    .addStringOption((option) => option
      .setName('field')
      .setDescription('Key to rotate')
      .setRequired(true)
      .addChoices(
        { name: 'DeepSeek', value: 'deepseek' },
        { name: 'Brave Search', value: 'brave' },
      )))
  .addSubcommand((command) => command
    .setName('reset')
    .setDescription('Remove this server configuration'));

const commandDefinitions = Object.freeze([guildConfigCommand.toJSON()]);

module.exports = {
  GUILD_CONFIG_COMMAND_NAME,
  commandDefinitions,
  guildConfigCommand,
};
