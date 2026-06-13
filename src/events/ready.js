const { setReadyPresence } = require('../discord/presence');
const { startGuildIdleChatterTimers } = require('../state/idleChatter');

function handleReady(readyClient) {
  setReadyPresence(readyClient);
  startGuildIdleChatterTimers(readyClient);
  console.log(`Logged in as ${readyClient.user.tag}`);
}

module.exports = {
  handleReady,
};
