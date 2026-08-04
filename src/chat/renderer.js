const { EmbedBuilder } = require('discord.js');

const BLOCKED_ALLOWED_MENTIONS = Object.freeze({
  parse: Object.freeze([]),
  users: Object.freeze([]),
  roles: Object.freeze([]),
  repliedUser: false,
});

const STYLE_WRAPPERS = Object.freeze({
  normal: ['', ''],
  bold: ['**', '**'],
  italic: ['*', '*'],
  underline: ['__', '__'],
  strikethrough: ['~~', '~~'],
  spoiler: ['||', '||'],
  codeblock: ['```\n', '\n```'],
});

const STYLE_ALIASES = Object.freeze({
  code: 'codeblock',
  code_block: 'codeblock',
  strike: 'strikethrough',
  underlined: 'underline',
});
const maxResponseCharacters = 32_000;

class ResponseDeliveryCancelledError extends Error {
  constructor() {
    super('Discord response delivery was cancelled because access or configuration changed.');
    this.name = 'ResponseDeliveryCancelledError';
  }
}

function normalizeTextStyle(style) {
  const normalized = String(style ?? 'normal').trim().toLowerCase();
  const resolved = STYLE_ALIASES[normalized] ?? normalized;
  return STYLE_WRAPPERS[resolved] ? resolved : 'normal';
}

function sanitizeDiscordMentions(text) {
  return String(text ?? '').replace(/@(?!\u200b)/g, '@\u200b');
}

function prepareStyleContent(text, style) {
  const source = String(text ?? '');
  if (style === 'codeblock') return source.replace(/```/g, '``\u200b`');
  if (style === 'bold' || style === 'italic') return source.replace(/\*/g, '\\*');
  if (style === 'underline') return source.replace(/_/g, '\\_');
  if (style === 'strikethrough') return source.replace(/~/g, '\\~');
  if (style === 'spoiler') return source.replace(/\|/g, '\\|');
  return source;
}

function applyTextStyle(text, style = 'normal') {
  const normalizedStyle = normalizeTextStyle(style);
  const [prefix, suffix] = STYLE_WRAPPERS[normalizedStyle];
  return `${prefix}${prepareStyleContent(text, normalizedStyle)}${suffix}`;
}

function splitText(text, maxLength = 2000) {
  const source = String(text ?? '');
  const limit = Number(maxLength);

  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('maxLength must be a positive integer.');
  }

  if (!source) return [];

  const chunks = [];
  let remainder = source;

  while (remainder.length > limit) {
    let splitAt = remainder.lastIndexOf('\n', limit);
    if (splitAt >= Math.floor(limit / 2)) {
      splitAt += 1;
    } else {
      splitAt = remainder.lastIndexOf(' ', limit);
      if (splitAt >= Math.floor(limit / 2)) splitAt += 1;
      else splitAt = limit;
    }

    if (splitAt <= 0) splitAt = limit;
    const previousCodeUnit = remainder.charCodeAt(splitAt - 1);
    const nextCodeUnit = remainder.charCodeAt(splitAt);
    if (previousCodeUnit >= 0xD800 && previousCodeUnit <= 0xDBFF
      && nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) {
      splitAt -= 1;
    }
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remainder.slice(0, splitAt));
    remainder = remainder.slice(splitAt);
  }

  if (remainder) chunks.push(remainder);
  return chunks;
}

function buildStyledChunks(text, style, maxLength) {
  const normalizedStyle = normalizeTextStyle(style);
  const [prefix, suffix] = STYLE_WRAPPERS[normalizedStyle];
  const prepared = prepareStyleContent(text, normalizedStyle) || '\u200b';
  const contentLimit = maxLength - prefix.length - suffix.length;

  if (contentLimit < 1) throw new RangeError('The chunk limit is too small for the selected style.');
  return splitText(prepared, contentLimit).map((chunk) => `${prefix}${chunk}${suffix}`);
}

function getPersonaConfig(config = {}) {
  return config?.persona && typeof config.persona === 'object' ? config.persona : config;
}

async function sendConfiguredResponse(message, text, config = {}, options = {}) {
  if (typeof message?.reply !== 'function') {
    throw new TypeError('A Discord message with reply() is required.');
  }

  const persona = getPersonaConfig(config);
  const style = persona?.textStyle ?? 'normal';
  const responseFormat = String(persona?.responseFormat ?? 'text').toLowerCase();
  const isEmbed = responseFormat === 'embed';
  const maxLength = isEmbed ? 4096 : 2000;
  const sourceText = String(text ?? '');
  const boundedText = sourceText.length > maxResponseCharacters
    ? `${sourceText.slice(0, maxResponseCharacters - 1)}…`
    : sourceText;
  const safeText = sanitizeDiscordMentions(boundedText);
  const chunks = buildStyledChunks(safeText, style, maxLength);
  const sentMessages = [];

  for (let index = 0; index < chunks.length; index += 1) {
    if (typeof options.shouldContinue === 'function' && !await options.shouldContinue()) {
      throw new ResponseDeliveryCancelledError();
    }
    const messageOptions = isEmbed
      ? {
        embeds: [new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(sanitizeDiscordMentions(persona.characterName || 'AI').slice(0, 256))
          .setDescription(chunks[index])],
        allowedMentions: BLOCKED_ALLOWED_MENTIONS,
      }
      : {
        content: chunks[index],
        allowedMentions: BLOCKED_ALLOWED_MENTIONS,
      };

    if (index === 0) {
      sentMessages.push(await message.reply(messageOptions));
    } else {
      if (typeof message.channel?.send !== 'function') {
        throw new TypeError('A Discord channel with send() is required for multi-part responses.');
      }
      sentMessages.push(await message.channel.send(messageOptions));
    }
  }

  return sentMessages;
}

module.exports = {
  BLOCKED_ALLOWED_MENTIONS,
  ResponseDeliveryCancelledError,
  applyTextStyle,
  maxResponseCharacters,
  normalizeTextStyle,
  sanitizeDiscordMentions,
  sendConfiguredResponse,
  splitText,
};
