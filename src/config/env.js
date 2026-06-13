const token = process.env.DISCORD_TOKEN;
const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
const deepSeekBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const deepSeekModel = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

module.exports = {
  deepSeekApiKey,
  deepSeekBaseUrl,
  deepSeekModel,
  token,
};
