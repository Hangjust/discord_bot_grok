const { ActivityType } = require('discord.js');

const readyPresenceText = '!grok help';

function setReadyPresence(readyClient) {
  readyClient.user.setPresence({
    activities: [
      {
        name: readyPresenceText,
        type: ActivityType.Listening,
      },
    ],
    status: 'online',
  });
}

module.exports = {
  readyPresenceText,
  setReadyPresence,
};
