const {
  readExcludedChannelIds,
  replyAllowedChannelIds,
} = require('../config/constants');

function canReadInChannel(channelId) {
  return !readExcludedChannelIds.includes(channelId);
}

function canReplyInChannel(channelId) {
  return replyAllowedChannelIds.includes(channelId);
}

function canReplyToMessage(message) {
  return canReplyInChannel(message.channelId);
}

module.exports = {
  canReadInChannel,
  canReplyInChannel,
  canReplyToMessage,
};
