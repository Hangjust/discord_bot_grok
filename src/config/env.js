const { resolve } = require('node:path');

function parseBoolean(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function parseInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, minimum), maximum);
}

const token = process.env.DISCORD_TOKEN;
const discordApplicationId = String(process.env.DISCORD_APPLICATION_ID || '').trim();
const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
const deepSeekBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const deepSeekModel = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const deepSeekTimeoutMs = parseInteger(process.env.DEEPSEEK_TIMEOUT_MS, 30000, 1000, 120000);
const geminiBaseUrl = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const geminiModel = process.env.GEMINI_MODEL || 'gemma-4-26b-a4b-it';
const geminiTimeoutMs = parseInteger(process.env.GEMINI_TIMEOUT_MS, 30000, 1000, 120000);
const deepSeekMaxConcurrentPerGuild = parseInteger(process.env.DEEPSEEK_MAX_CONCURRENT_PER_GUILD, 2, 1, 20);
const deepSeekMaxRequestsPerGuildPerMinute = parseInteger(process.env.DEEPSEEK_MAX_REQUESTS_PER_GUILD_PER_MINUTE, 40, 1, 1000);
const deepSeekMaxRequestsPerUserPerMinute = parseInteger(process.env.DEEPSEEK_MAX_REQUESTS_PER_USER_PER_MINUTE, 8, 1, 120);
const guildConfigMasterKey = String(process.env.GUILD_CONFIG_MASTER_KEY || '').trim();
const guildConfigMasterKeyId = String(process.env.GUILD_CONFIG_MASTER_KEY_ID || 'primary').trim();
const guildConfigPath = resolve(process.env.GUILD_CONFIG_PATH || './data/guild-config.json');
const userMemoryPath = resolve(process.env.USER_MEMORY_PATH || './data/user-memory.ndjson');
const allowLegacyGuildConfig = parseBoolean(process.env.ALLOW_LEGACY_GUILD_CONFIG);

module.exports = {
  allowLegacyGuildConfig,
  deepSeekApiKey,
  deepSeekBaseUrl,
  deepSeekMaxConcurrentPerGuild,
  deepSeekMaxRequestsPerGuildPerMinute,
  deepSeekMaxRequestsPerUserPerMinute,
  deepSeekModel,
  deepSeekTimeoutMs,
  geminiBaseUrl,
  geminiModel,
  geminiTimeoutMs,
  discordApplicationId,
  guildConfigMasterKey,
  guildConfigMasterKeyId,
  guildConfigPath,
  parseBoolean,
  parseInteger,
  token,
  userMemoryPath,
};
