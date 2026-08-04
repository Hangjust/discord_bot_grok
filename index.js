require('dotenv').config();

const publicApi = require('./src/publicApi');

if (require.main === module) {
  publicApi.startBot().catch((error) => {
    console.error('Discord bot failed to start.', {
      name: error?.name,
      message: error?.message,
    });
    process.exitCode = 1;
  });
}

module.exports = publicApi;
