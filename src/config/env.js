const path = require('node:path');

const defaultDeepSeekTimeoutMs = 30000;
const minDeepSeekTimeoutMs = 1000;
const maxDeepSeekTimeoutMs = 120000;

function getOptionalEnvironmentValue(name, env = process.env) {
  const value = String(env[name] ?? '').trim();
  return value || undefined;
}

function getDeepSeekTimeoutMs(value = process.env.DEEPSEEK_TIMEOUT_MS) {
  const normalizedValue = String(value ?? '').trim();

  if (!/^\d+$/.test(normalizedValue)) {
    return defaultDeepSeekTimeoutMs;
  }

  const parsed = Number(normalizedValue);

  if (!Number.isSafeInteger(parsed)) {
    return defaultDeepSeekTimeoutMs;
  }

  return Math.min(Math.max(parsed, minDeepSeekTimeoutMs), maxDeepSeekTimeoutMs);
}

const token = getOptionalEnvironmentValue('DISCORD_TOKEN');
const configEncryptionKey = getOptionalEnvironmentValue('CONFIG_ENCRYPTION_KEY');
const guildConfigPath = path.resolve(
  getOptionalEnvironmentValue('GUILD_CONFIG_PATH')
    || path.join(process.cwd(), 'data', 'guild-config.json'),
);

// Keep the provider origin fixed so guild-provided credentials cannot be sent elsewhere.
const deepSeekBaseUrl = 'https://api.deepseek.com';
const deepSeekModel = getOptionalEnvironmentValue('DEEPSEEK_MODEL') || 'deepseek-v4-flash';
const deepSeekTimeoutMs = getDeepSeekTimeoutMs();

module.exports = {
  configEncryptionKey,
  deepSeekBaseUrl,
  deepSeekModel,
  deepSeekTimeoutMs,
  getDeepSeekTimeoutMs,
  guildConfigPath,
  token,
};
