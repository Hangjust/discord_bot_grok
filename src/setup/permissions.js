const { PermissionFlagsBits } = require('discord.js');

function isGuildOwnerOrAdministrator(interaction) {
  if (!interaction?.inGuild?.() || !interaction.guild || !interaction.user) {
    return false;
  }

  if (interaction.guild.ownerId === interaction.user.id) {
    return true;
  }

  return Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator));
}

function isMessageAuthorGuildOwnerOrAdministrator(message) {
  if (!message?.guild || !message.author || !message.member) {
    return false;
  }

  return message.guild.ownerId === message.author.id
    || Boolean(message.member.permissions?.has?.(PermissionFlagsBits.Administrator));
}

module.exports = {
  isGuildOwnerOrAdministrator,
  isMessageAuthorGuildOwnerOrAdministrator,
};
