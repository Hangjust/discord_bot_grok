const { ActivityType } = require('discord.js');
const { grokHelpCommandName } = require('../config/constants');

function setReadyPresence(readyClient) {
  readyClient.user.setPresence({
    activities: [
      {
        name: grokHelpCommandName,
        type: ActivityType.Listening,
      },
    ],
    status: 'online',
  });
}

module.exports = {
  setReadyPresence,
};
