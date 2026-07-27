const {
  readExcludedChannelIds,
  replyAllowedChannelIds,
} = require('../config/constants');
const {
  evaluateGuildChannelAccess,
  evaluateMessageAccess,
} = require('./accessPolicy');

function canReadInChannel(channelOrId, config) {
  if (config) {
    return evaluateGuildChannelAccess(channelOrId, config).allowed;
  }

  const channelId = typeof channelOrId === 'object' ? channelOrId?.id : channelOrId;
  return !readExcludedChannelIds.includes(channelId);
}

function canReplyInChannel(channelOrId, config) {
  if (config) {
    return evaluateGuildChannelAccess(channelOrId, config).allowed;
  }

  const channelId = typeof channelOrId === 'object' ? channelOrId?.id : channelOrId;
  return replyAllowedChannelIds.includes(channelId);
}

function canReplyToMessage(message, config) {
  if (config) {
    return evaluateMessageAccess(message, config).allowed;
  }

  return canReplyInChannel(message.channelId);
}

module.exports = {
  canReadInChannel,
  canReplyInChannel,
  canReplyToMessage,
};
