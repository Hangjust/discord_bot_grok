const { EmbedBuilder } = require('discord.js');
const { DEFAULT_TRIGGER_WORD } = require('../config/guildConfigSchema');

const PROVIDER_KEY_COLOR = 0xFEE75C;
const PROVIDER_KEY_LINKS = Object.freeze({
  deepseek: 'https://platform.deepseek.com/api_keys',
  gemini: 'https://aistudio.google.com/app/apikey',
  qwen: 'https://www.alibabacloud.com/help/en/model-studio/get-api-key',
});

function isProviderKeyCommand(content, triggerWord = DEFAULT_TRIGGER_WORD) {
  const trigger = String(triggerWord || DEFAULT_TRIGGER_WORD)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${trigger}\\s+key$`, 'iu').test(String(content || '').trim());
}

function createProviderKeyEmbed() {
  return new EmbedBuilder()
    .setColor(PROVIDER_KEY_COLOR)
    .setTitle('🔑 Get an AI API key')
    .setDescription([
      `[DeepSeek](${PROVIDER_KEY_LINKS.deepseek})`,
      `[Gemma — Gemini API](${PROVIDER_KEY_LINKS.gemini})`,
      `[Qwen — Alibaba Model Studio](${PROVIDER_KEY_LINKS.qwen})`,
      '',
      'After getting a key, an administrator can run `/ai-setup api`.',
    ].join('\n'));
}

module.exports = {
  PROVIDER_KEY_COLOR,
  PROVIDER_KEY_LINKS,
  createProviderKeyEmbed,
  isProviderKeyCommand,
};
