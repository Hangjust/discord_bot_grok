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
  const geminiBaseUrl = String(
    options.geminiBaseUrl || 'https://generativelanguage.googleapis.com/v1beta',
  ).trim();
  const geminiModel = String(options.geminiModel || 'gemma-4-26b-a4b-it').trim();
  const geminiTimeoutMs = options.geminiTimeoutMs || 10000;
  const qwenBaseUrl = String(
    options.qwenBaseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  ).trim();
  const qwenTimeoutMs = options.qwenTimeoutMs || 10000;
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

  async function validateGeminiKey(apiKey) {
    try {
      const baseUrl = new URL(geminiBaseUrl);
      if (baseUrl.protocol !== 'https:') {
        throw new Error('invalid endpoint');
      }

      const root = baseUrl.href.endsWith('/') ? baseUrl : `${baseUrl.href}/`;
      const url = new URL(`models/${encodeURIComponent(geminiModel)}`, root);
      const response = await requestWithTimeout(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'x-goog-api-key': String(apiKey || ''),
        },
      }, geminiTimeoutMs, fetchImpl);

      if (!response.ok) {
        throw new Error('provider rejected credentials');
      }
      return true;
    } catch {
      throw new CredentialValidationError('Gemini');
    }
  }

  async function validateQwenKey(apiKey) {
    try {
      const baseUrl = new URL(qwenBaseUrl);
      if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password) {
        throw new Error('invalid endpoint');
      }
      const root = baseUrl.href.endsWith('/') ? baseUrl : `${baseUrl.href}/`;
      const url = new URL('models', root);
      const response = await requestWithTimeout(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${String(apiKey || '')}`,
        },
      }, qwenTimeoutMs, fetchImpl);
      if (!response.ok) {
        throw new Error('provider rejected credentials');
      }
      return true;
    } catch {
      throw new CredentialValidationError('Qwen');
    }
  }

  return Object.freeze({
    validateBraveKey,
    validateDeepseekKey,
    validateGeminiKey,
    validateQwenKey,
  });
}

module.exports = {
  CredentialValidationError,
  createCredentialValidators,
};
