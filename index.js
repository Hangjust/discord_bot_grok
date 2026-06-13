require('dotenv').config();

const publicApi = require('./src/publicApi');

if (require.main === module) {
  publicApi.startBot();
}

module.exports = publicApi;
