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

module.exports = {
  canReadInChannel,
  canReplyInChannel,
};
