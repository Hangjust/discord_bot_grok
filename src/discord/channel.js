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

function isReplyAllowedTicketChannel(channel) {
  const topic = String(channel?.topic ?? '');
  return topic.startsWith('[roleplay-ticket:') || topic.startsWith('roleplay-ticket:') || topic.startsWith('rp opener:');
}

function canReplyToMessage(message) {
  return canReplyInChannel(message.channelId) || isReplyAllowedTicketChannel(message.channel);
}

module.exports = {
  canReadInChannel,
  canReplyInChannel,
  canReplyToMessage,
  isReplyAllowedTicketChannel,
};
