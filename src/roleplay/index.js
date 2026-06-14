const config = require('./config');
const deepseek = require('./deepseek');
const interactions = require('./interactions');
const improvedPrompt = require('./improvedPrompt');
const message = require('./message');
const panel = require('./panel');
const rateLimit = require('./rateLimit');
const referenceGuide = require('./referenceGuide');
const replies = require('./replies');
const sessions = require('./sessions');
const tickets = require('./tickets');

module.exports = {
  ...config,
  ...deepseek,
  ...interactions,
  ...improvedPrompt,
  ...message,
  ...panel,
  ...rateLimit,
  ...referenceGuide,
  ...replies,
  ...sessions,
  ...tickets,
};
