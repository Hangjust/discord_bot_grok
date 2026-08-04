const {
  channelDisableCommandName,
  channelEnableCommandName,
} = require('../config/constants');
const { getMentionText, replySafely } = require('../discord/mentions');
const { isBotMentioned } = require('../chat/triggers');
const { isMessageAuthorGuildOwnerOrAdministrator } = require('../setup/permissions');
const { deleteIdleChatterStateForChannel } = require('../state/idleChatter');

function parseChannelAccessCommand(content) {
  const command = String(content ?? '').trim().toLowerCase();
  if (command === channelEnableCommandName) return 'enable';
  if (command === channelDisableCommandName) return 'disable';
  return null;
}

function getChannelAccessCommand(message, botUserId) {
  if (!isBotMentioned(message, botUserId)) return null;
  return parseChannelAccessCommand(getMentionText(message.content, botUserId));
}

async function handleChannelAccessCommand(message, store, botUserId) {
  const action = getChannelAccessCommand(message, botUserId);
  if (!action) return false;

  if (!isMessageAuthorGuildOwnerOrAdministrator(message)) {
    await replySafely(message, 'Only the server owner or an administrator can use channelEnable or channelDisable.');
    return true;
  }

  const guildId = String(message.guild?.id ?? message.guildId ?? '');
  const channelId = String(message.channelId ?? message.channel?.id ?? '');
  if (!guildId || !channelId) {
    await replySafely(message, 'I could not determine this server channel.');
    return true;
  }

  let changed = false;
  await store.update(guildId, (current) => {
    const currentChannelIds = Array.isArray(current.access?.channelIds)
      ? current.access.channelIds.map(String)
      : [];
    const isEnabled = currentChannelIds.includes(channelId);

    if (action === 'enable' && !isEnabled) {
      changed = true;
      current.access.channelIds = [...currentChannelIds, channelId];
    } else if (action === 'disable' && isEnabled) {
      changed = true;
      current.access.channelIds = currentChannelIds.filter((id) => id !== channelId);
    }

    return current;
  }, message.author.id);

  if (action === 'disable' && changed) {
    // Stop any already-scheduled idle chatter from the channel immediately.
    deleteIdleChatterStateForChannel(guildId, channelId);
  }

  const status = action === 'enable'
    ? (changed ? 'enabled' : 'already enabled')
    : (changed ? 'disabled' : 'already disabled');
  await replySafely(message, `Responses are ${status} in this channel.`);
  return true;
}

module.exports = {
  getChannelAccessCommand,
  handleChannelAccessCommand,
  parseChannelAccessCommand,
};
