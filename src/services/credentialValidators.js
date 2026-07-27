const { braveSearchEndpoint } = require('../config/constants');

class CredentialValidationError extends Error {
  constructor(provider) {
    super(`Unable to validate ${provider} credentials`);
    this.name = 'CredentialValidationError';
    this.provider = provider;
  }
}

async function requestWithTimeout(url, options, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function createCredentialValidators(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const deepseekBaseUrl = String(options.deepseekBaseUrl || 'https://api.deepseek.com').trim();
  const deepseekTimeoutMs = options.deepseekTimeoutMs || 10000;
  const braveTimeoutMs = options.braveTimeoutMs || 5000;

  async function validateDeepseekKey(apiKey) {
    try {
      const baseUrl = new URL(deepseekBaseUrl);

      if (baseUrl.protocol !== 'https:') {
        throw new Error('invalid endpoint');
      }

      const url = new URL('models', baseUrl.href.endsWith('/') ? baseUrl : `${baseUrl.href}/`);
      const response = await requestWithTimeout(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${String(apiKey || '')}`,
        },
      }, deepseekTimeoutMs, fetchImpl);

      if (!response.ok) {
        throw new Error('provider rejected credentials');
      }

      return true;
    } catch {
      throw new CredentialValidationError('DeepSeek');
    }
  }

  async function validateBraveKey(apiKey) {
    try {
      const url = new URL(braveSearchEndpoint);
      url.searchParams.set('q', 'credential validation');
      url.searchParams.set('count', '1');
      const response = await requestWithTimeout(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': String(apiKey || ''),
        },
      }, braveTimeoutMs, fetchImpl);

      if (!response.ok) {
        throw new Error('provider rejected credentials');
      }

      return true;
    } catch {
      throw new CredentialValidationError('Brave');
    }
  }

  return Object.freeze({ validateBraveKey, validateDeepseekKey });
}

module.exports = {
  CredentialValidationError,
  createCredentialValidators,
};
