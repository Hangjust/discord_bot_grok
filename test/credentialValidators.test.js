const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CredentialValidationError,
  createCredentialValidators,
} = require('../src/services/credentialValidators');

test('credential validators send keys only in provider authorization headers', async () => {
  const requests = [];
  const validators = createCredentialValidators({
    deepseekBaseUrl: 'https://api.deepseek.test/v1',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: true };
    },
  });

  await validators.validateDeepseekKey('deep-secret');
  await validators.validateBraveKey('brave-secret');

  assert.equal(requests[0].url, 'https://api.deepseek.test/v1/models');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer deep-secret');
  assert.doesNotMatch(requests[0].url, /deep-secret/);
  assert.equal(requests[1].options.headers['X-Subscription-Token'], 'brave-secret');
  assert.doesNotMatch(requests[1].url, /brave-secret/);
});

test('credential validator failures are generic and secret-free', async () => {
  const secret = 'submitted-provider-secret';
  const validators = createCredentialValidators({
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });

  for (const validate of [validators.validateDeepseekKey, validators.validateBraveKey]) {
    await assert.rejects(validate(secret), (error) => {
      assert.equal(error instanceof CredentialValidationError, true);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.doesNotMatch(error.stack, new RegExp(secret));
      return true;
    });
  }
});
