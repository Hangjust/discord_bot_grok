'use strict';

const {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const ENCRYPTED_SECRET_VERSION = 'v1';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

class ConfigEncryptionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ConfigEncryptionError';
    this.code = code;
  }
}

function encryptionError(code, message, cause) {
  return new ConfigEncryptionError(code, message, cause ? { cause } : undefined);
}

function decodeBase64Key(value) {
  // A 32-byte value is 44 base64 characters (including optional trailing padding).
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value) && !/^[A-Za-z0-9+/]{42}==$/.test(value)) {
    return null;
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    return null;
  }

  return decoded;
}

function parseEncryptionKey(value = process.env.CONFIG_ENCRYPTION_KEY) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const key = Buffer.from(value);
    if (key.length !== 32) {
      throw encryptionError(
        'CONFIG_ENCRYPTION_KEY_INVALID',
        'The configuration encryption key is invalid. It must contain exactly 32 bytes.',
      );
    }
    return key;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw encryptionError(
      'CONFIG_ENCRYPTION_KEY_MISSING',
      'The configuration encryption key is not configured.',
    );
  }

  const encoded = value.trim();
  let key = null;

  if (/^[0-9a-fA-F]{64}$/.test(encoded)) {
    key = Buffer.from(encoded, 'hex');
  } else {
    key = decodeBase64Key(encoded);
  }

  if (!key) {
    throw encryptionError(
      'CONFIG_ENCRYPTION_KEY_INVALID',
      'The configuration encryption key is invalid. Use 64 hexadecimal characters or a base64-encoded 32-byte value.',
    );
  }

  return key;
}

function requireGuildId(guildId) {
  if (typeof guildId !== 'string' || guildId.trim() === '') {
    throw encryptionError(
      'CONFIG_ENCRYPTION_GUILD_ID_INVALID',
      'A valid guild ID is required for encrypted configuration data.',
    );
  }

  return guildId.trim();
}

function looksLikeEncryptionKey(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return true;
  }

  if (typeof value !== 'string') {
    return false;
  }

  const candidate = value.trim();
  return /^[0-9a-fA-F]{64}$/.test(candidate)
    || /^[A-Za-z0-9+/]{43}=$/.test(candidate)
    || /^[A-Za-z0-9+/]{42}==$/.test(candidate);
}

function resolveCryptoArguments(guildIdOrOptions, keyOrGuildId) {
  if (guildIdOrOptions && typeof guildIdOrOptions === 'object'
    && !Buffer.isBuffer(guildIdOrOptions)
    && !(guildIdOrOptions instanceof Uint8Array)) {
    return {
      guildId: guildIdOrOptions.guildId,
      encryptionKey: guildIdOrOptions.encryptionKey,
    };
  }

  // Support both (value, guildId, key) and the common (value, key, guildId)
  // ordering. The store itself uses the former.
  if (keyOrGuildId !== undefined && looksLikeEncryptionKey(guildIdOrOptions)) {
    return {
      guildId: keyOrGuildId,
      encryptionKey: guildIdOrOptions,
    };
  }

  return {
    guildId: guildIdOrOptions,
    encryptionKey: keyOrGuildId,
  };
}

function encodePart(value) {
  return value.toString('base64');
}

function decodePart(value, expectedLength, label) {
  if (typeof value !== 'string' || value === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw encryptionError('CONFIG_DECRYPTION_FAILED', 'The encrypted API key could not be decrypted.');
  }

  const decoded = Buffer.from(value, 'base64');
  if ((expectedLength !== null && decoded.length !== expectedLength)
    || decoded.toString('base64') !== value) {
    throw encryptionError(
      'CONFIG_DECRYPTION_FAILED',
      `The encrypted API key ${label} is invalid.`,
    );
  }

  return decoded;
}

function encryptSecret(secret, guildIdOrOptions, keyOrGuildId) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw encryptionError(
      'CONFIG_SECRET_INVALID',
      'A non-empty API key is required for encryption.',
    );
  }

  const { guildId, encryptionKey } = resolveCryptoArguments(guildIdOrOptions, keyOrGuildId);
  const normalizedGuildId = requireGuildId(guildId);
  const key = parseEncryptionKey(encryptionKey);
  const iv = randomBytes(IV_LENGTH);

  try {
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    cipher.setAAD(Buffer.from(normalizedGuildId, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(secret, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [
      ENCRYPTED_SECRET_VERSION,
      encodePart(iv),
      encodePart(authTag),
      encodePart(ciphertext),
    ].join('.');
  } catch (error) {
    if (error instanceof ConfigEncryptionError) {
      throw error;
    }
    throw encryptionError(
      'CONFIG_ENCRYPTION_FAILED',
      'The API key could not be encrypted.',
      error,
    );
  } finally {
    key.fill(0);
  }
}

function parseEncryptedSecret(encryptedSecret) {
  if (typeof encryptedSecret !== 'string') {
    throw encryptionError(
      'CONFIG_DECRYPTION_FAILED',
      'The encrypted API key could not be decrypted.',
    );
  }

  const parts = encryptedSecret.split('.');
  if (parts.length !== 4 || parts[0] !== ENCRYPTED_SECRET_VERSION) {
    throw encryptionError(
      'CONFIG_DECRYPTION_FAILED',
      'The encrypted API key uses an unsupported or invalid format.',
    );
  }

  return {
    iv: decodePart(parts[1], IV_LENGTH, 'initialization vector'),
    authTag: decodePart(parts[2], AUTH_TAG_LENGTH, 'authentication tag'),
    ciphertext: decodePart(parts[3], null, 'ciphertext'),
  };
}

function decryptSecretBuffer(encryptedSecret, guildIdOrOptions, keyOrGuildId) {
  const { guildId, encryptionKey } = resolveCryptoArguments(guildIdOrOptions, keyOrGuildId);
  const normalizedGuildId = requireGuildId(guildId);
  const key = parseEncryptionKey(encryptionKey);
  let encryptedParts;

  try {
    encryptedParts = parseEncryptedSecret(encryptedSecret);
    const { iv, authTag, ciphertext } = encryptedParts;
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAAD(Buffer.from(normalizedGuildId, 'utf8'));
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
  } catch (error) {
    throw encryptionError(
      'CONFIG_DECRYPTION_FAILED',
      'The encrypted API key could not be decrypted.',
      error,
    );
  } finally {
    key.fill(0);
    encryptedParts?.iv.fill(0);
    encryptedParts?.authTag.fill(0);
    encryptedParts?.ciphertext.fill(0);
  }
}

function decryptSecret(encryptedSecret, guildIdOrOptions, keyOrGuildId) {
  const plaintext = decryptSecretBuffer(encryptedSecret, guildIdOrOptions, keyOrGuildId);
  try {
    return plaintext.toString('utf8');
  } finally {
    plaintext.fill(0);
  }
}

function validateEncryptedSecret(encryptedSecret, guildIdOrOptions, keyOrGuildId) {
  const plaintext = decryptSecretBuffer(encryptedSecret, guildIdOrOptions, keyOrGuildId);
  plaintext.fill(0);
  return true;
}

module.exports = {
  ConfigEncryptionError,
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
  validateEncryptedSecret,
};
