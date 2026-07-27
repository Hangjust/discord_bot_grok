const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const test = require('node:test');
const {
  createSecretCipher,
  decodeMasterKey,
} = require('../src/security/secretCipher');

function createCipher(key = randomBytes(32), keyId = 'primary') {
  return createSecretCipher({ masterKey: key.toString('base64'), keyId });
}

test('master key must be valid base64 for exactly 32 bytes', () => {
  const key = randomBytes(32);

  assert.deepEqual(decodeMasterKey(key.toString('base64')), key);
  assert.throws(() => decodeMasterKey(''), /GUILD_CONFIG_MASTER_KEY is required/);
  assert.throws(() => decodeMasterKey(randomBytes(31).toString('base64')), /exactly 32 bytes/);
  assert.throws(() => decodeMasterKey(`${key.toString('base64')}!`), /valid base64/);
});

test('AES-256-GCM round trips use fresh IVs and contain no plaintext', () => {
  const cipher = createCipher();
  const plaintext = 'deepseek-super-secret-value';
  const first = cipher.encrypt('1001', 'deepseek', plaintext);
  const second = cipher.encrypt('1001', 'deepseek', plaintext);

  assert.equal(cipher.decrypt('1001', 'deepseek', first), plaintext);
  assert.equal(cipher.decrypt('1001', 'deepseek', second), plaintext);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.algorithm, 'aes-256-gcm');
  assert.equal(first.formatVersion, 1);
  assert.equal(first.keyId, 'primary');
  assert.doesNotMatch(JSON.stringify(first), new RegExp(plaintext));
});

test('guild and field AAD prevent ciphertext from moving between secrets', () => {
  const cipher = createCipher();
  const blob = cipher.encrypt('1001', 'deepseek', 'secret-value');

  assert.throws(() => cipher.decrypt('1002', 'deepseek', blob), /Unable to decrypt encrypted guild secret/);
  assert.throws(() => cipher.decrypt('1001', 'brave', blob), /Unable to decrypt encrypted guild secret/);
});

test('wrong keys, key IDs, tampering, and malformed blobs fail generically', () => {
  const plaintext = 'never-show-this-secret';
  const cipher = createCipher();
  const blob = cipher.encrypt('1001', 'brave', plaintext);
  const wrongKeyCipher = createCipher();
  const wrongIdCipher = createCipher(randomBytes(32), 'secondary');
  const tampered = { ...blob, ciphertext: randomBytes(8).toString('base64') };

  for (const operation of [
    () => wrongKeyCipher.decrypt('1001', 'brave', blob),
    () => wrongIdCipher.decrypt('1001', 'brave', blob),
    () => cipher.decrypt('1001', 'brave', tampered),
    () => cipher.decrypt('1001', 'brave', { nope: true }),
  ]) {
    assert.throws(operation, (error) => {
      assert.equal(error.message, 'Unable to decrypt encrypted guild secret');
      assert.doesNotMatch(error.message, new RegExp(plaintext));
      assert.doesNotMatch(error.stack, new RegExp(plaintext));
      return true;
    });
  }
});
