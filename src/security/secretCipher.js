const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { SECRET_FIELDS, normalizeId } = require('../config/guildConfigSchema');

const SECRET_FORMAT_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function decodeMasterKey(value) {
  const encoded = String(value ?? '').trim();

  if (!encoded) {
    throw new Error('GUILD_CONFIG_MASTER_KEY is required');
  }

  const key = Buffer.from(encoded, 'base64');
  const canonical = key.toString('base64').replace(/=+$/, '');
  const supplied = encoded.replace(/=+$/, '');

  if (key.length !== 32 || canonical !== supplied) {
    throw new Error('GUILD_CONFIG_MASTER_KEY must be valid base64 encoding exactly 32 bytes');
  }

  return key;
}

function normalizeField(field) {
  const normalized = String(field ?? '').trim().toLowerCase();

  if (!SECRET_FIELDS.includes(normalized)) {
    throw new TypeError('secret field is not supported');
  }

  return normalized;
}

function buildAssociatedData(guildId, field) {
  return Buffer.from(`guild-config:v${SECRET_FORMAT_VERSION}:${normalizeId(guildId, 'guildId')}:${normalizeField(field)}`, 'utf8');
}

function decodeBlobPart(value, expectedLength) {
  const encoded = String(value ?? '').trim();
  const decoded = Buffer.from(encoded, 'base64');

  if (!encoded || decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('encrypted guild secret is invalid');
  }

  if (expectedLength !== undefined && decoded.length !== expectedLength) {
    throw new Error('encrypted guild secret is invalid');
  }

  return decoded;
}

function createSecretCipher(options = {}) {
  const keyId = String(options.keyId ?? 'primary').trim();
  const masterKey = Buffer.isBuffer(options.masterKey)
    ? Buffer.from(options.masterKey)
    : decodeMasterKey(options.masterKey);

  if (masterKey.length !== 32) {
    throw new Error('GUILD_CONFIG_MASTER_KEY must decode to exactly 32 bytes');
  }

  if (!keyId) {
    throw new Error('GUILD_CONFIG_MASTER_KEY_ID is required');
  }

  function encrypt(guildId, field, plaintext) {
    const secret = String(plaintext ?? '');

    if (!secret) {
      throw new TypeError('secret value is required');
    }

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, masterKey, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(buildAssociatedData(guildId, field));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);

    return Object.freeze({
      formatVersion: SECRET_FORMAT_VERSION,
      keyId,
      algorithm: ALGORITHM,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    });
  }

  function decrypt(guildId, field, blob) {
    try {
      if (!blob || blob.formatVersion !== SECRET_FORMAT_VERSION || blob.algorithm !== ALGORITHM || blob.keyId !== keyId) {
        throw new Error('unsupported secret');
      }

      const iv = decodeBlobPart(blob.iv, IV_BYTES);
      const ciphertext = decodeBlobPart(blob.ciphertext);
      const tag = decodeBlobPart(blob.tag, TAG_BYTES);
      const decipher = createDecipheriv(ALGORITHM, masterKey, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(buildAssociatedData(guildId, field));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Unable to decrypt encrypted guild secret');
    }
  }

  return Object.freeze({ decrypt, encrypt, keyId });
}

module.exports = {
  ALGORITHM,
  IV_BYTES,
  SECRET_FORMAT_VERSION,
  TAG_BYTES,
  buildAssociatedData,
  createSecretCipher,
  decodeMasterKey,
};
