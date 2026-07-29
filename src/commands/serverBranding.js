const { PermissionFlagsBits } = require('discord.js');
const { replySafely } = require('../discord/mentions');

const MAX_BOT_NICKNAME_CHARACTERS = 32;
const MAX_AVATAR_BYTES = 6 * 1024 * 1024;
const AVATAR_DOWNLOAD_TIMEOUT_MS = 10_000;
const DISCORD_ATTACHMENT_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
]);

class ServerBrandingInputError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ServerBrandingInputError';
    this.code = code;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseServerBrandingCommand(content, triggerWord = 'AI') {
  const triggers = [...new Set(['AI', String(triggerWord || 'AI')])]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|');
  const match = String(content || '').trim().match(
    new RegExp(`^!(?:${triggers})\\s+(name|pfp)(?:\\s+([\\s\\S]*))?$`, 'iu'),
  );

  if (!match) return null;
  return Object.freeze({
    action: match[1].toLowerCase(),
    value: String(match[2] || '').trim(),
  });
}

function canManageServerBranding(message) {
  if (String(message?.guild?.ownerId || '') === String(message?.author?.id || '')) {
    return true;
  }
  return Boolean(message?.member?.permissions?.has?.(PermissionFlagsBits.Administrator));
}

function normalizeBotNickname(value) {
  const nickname = String(value || '').trim();
  const characterCount = Array.from(nickname).length;

  if (!nickname
    || characterCount > MAX_BOT_NICKNAME_CHARACTERS
    || /[\u0000-\u001F\u007F]/u.test(nickname)) {
    throw new ServerBrandingInputError('invalid_name');
  }
  return nickname;
}

function getSingleAttachment(message) {
  const attachments = message?.attachments;
  const count = Number(attachments?.size || 0);
  if (count !== 1) {
    throw new ServerBrandingInputError('attachment_required');
  }

  const attachment = attachments.first?.()
    || attachments.values?.().next?.().value;
  if (!attachment) {
    throw new ServerBrandingInputError('attachment_required');
  }
  if (Number(attachment.size || 0) > MAX_AVATAR_BYTES) {
    throw new ServerBrandingInputError('avatar_too_large');
  }
  return attachment;
}

function detectImageMimeType(buffer) {
  if (buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) {
    return 'image/gif';
  }
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

async function readBoundedResponse(response) {
  const contentLength = Number(response?.headers?.get?.('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_AVATAR_BYTES) {
    throw new ServerBrandingInputError('avatar_too_large');
  }

  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_AVATAR_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ServerBrandingInputError('avatar_too_large');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_AVATAR_BYTES) {
    throw new ServerBrandingInputError('avatar_too_large');
  }
  return buffer;
}

async function downloadAvatar(attachment, fetchImpl = globalThis.fetch) {
  let url;
  try {
    url = new URL(String(attachment?.url || attachment?.attachment || ''));
  } catch {
    throw new ServerBrandingInputError('invalid_avatar');
  }

  if (url.protocol !== 'https:'
    || !DISCORD_ATTACHMENT_HOSTS.has(url.hostname.toLowerCase())
    || !url.pathname.startsWith('/attachments/')) {
    throw new ServerBrandingInputError('invalid_avatar');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AVATAR_DOWNLOAD_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response?.ok) {
      throw new ServerBrandingInputError('download_failed');
    }

    const buffer = await readBoundedResponse(response);
    if (!detectImageMimeType(buffer)) {
      throw new ServerBrandingInputError('invalid_avatar');
    }
    return buffer;
  } catch (error) {
    if (error instanceof ServerBrandingInputError) throw error;
    throw new ServerBrandingInputError('download_failed');
  } finally {
    clearTimeout(timeout);
  }
}

function getInputFailureMessage(error) {
  switch (error?.code) {
    case 'invalid_name':
      return `Use \`!AI name <new name>\` with a name from 1 to ${MAX_BOT_NICKNAME_CHARACTERS} characters.`;
    case 'attachment_required':
      return 'Attach exactly one image and use `!AI pfp`.';
    case 'avatar_too_large':
      return 'That image is too large. Attach an image no larger than 6 MiB.';
    case 'invalid_avatar':
      return 'Attach a valid PNG, JPEG, WebP, or GIF directly from Discord.';
    default:
      return 'I could not download that image. Please attach it again and retry.';
  }
}

async function handleServerBrandingCommand(message, command, options = {}) {
  if (!command) return false;

  if (!canManageServerBranding(message)) {
    await replySafely(message, 'Only the server owner or a Discord Administrator can change my server profile.');
    return true;
  }

  const editMe = message?.guild?.members?.editMe;
  if (typeof editMe !== 'function') {
    await replySafely(message, 'I could not access my server profile. Try again in a bit.');
    return true;
  }

  try {
    if (command.action === 'name') {
      const nickname = normalizeBotNickname(command.value);
      await editMe.call(message.guild.members, {
        nick: nickname,
        reason: `Bot server name changed by ${message.author.id}`,
      });
      await replySafely(message, 'My name has been updated for this server.');
      return true;
    }

    if (/^reset$/iu.test(command.value)) {
      await editMe.call(message.guild.members, {
        avatar: null,
        reason: `Bot server avatar reset by ${message.author.id}`,
      });
      await replySafely(message, 'My profile picture has been reset to the normal one for this server.');
      return true;
    }

    if (command.value) {
      throw new ServerBrandingInputError('attachment_required');
    }
    const attachment = getSingleAttachment(message);
    const avatar = await downloadAvatar(attachment, options.fetchImpl);
    await editMe.call(message.guild.members, {
      avatar,
      reason: `Bot server avatar changed by ${message.author.id}`,
    });
    await replySafely(message, 'My profile picture has been updated for this server.');
    return true;
  } catch (error) {
    if (error instanceof ServerBrandingInputError) {
      await replySafely(message, getInputFailureMessage(error));
      return true;
    }

    options.logger?.warn?.('Server bot profile update failed', {
      guildId: String(message?.guildId || ''),
      action: command.action,
      errorClass: String(error?.name || 'Error'),
    });
    await replySafely(message, 'Discord rejected that server profile change. Check my permissions and try again.');
    return true;
  }
}

module.exports = {
  AVATAR_DOWNLOAD_TIMEOUT_MS,
  DISCORD_ATTACHMENT_HOSTS,
  MAX_AVATAR_BYTES,
  MAX_BOT_NICKNAME_CHARACTERS,
  ServerBrandingInputError,
  canManageServerBranding,
  detectImageMimeType,
  downloadAvatar,
  getSingleAttachment,
  handleServerBrandingCommand,
  normalizeBotNickname,
  parseServerBrandingCommand,
  readBoundedResponse,
};
