const { ActivityType } = require('discord.js');

function setReadyPresence(readyClient) {
  readyClient.user.setPresence({
    activities: [
      {
        name: 'help',
        type: ActivityType.Listening,
      },
    ],
    status: 'online',
  });
}

module.exports = {
  setReadyPresence,
};
