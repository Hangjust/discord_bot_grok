const { buildDeepSeekPayload, sanitizeRequestId } = require('./deepseek');

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMMA_MODEL = 'gemma-4-26b-a4b-it';
const DEFAULT_GEMINI_TIMEOUT_MS = 30_000;

function validateGeminiBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl || DEFAULT_GEMINI_BASE_URL).trim());
  } catch {
    throw new TypeError('Gemini base URL must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new TypeError('Gemini base URL must be a valid HTTPS URL.');
  }
  url.search = '';
  url.hash = '';
  return url;
}

function buildGeminiUrl(baseUrl, model = DEFAULT_GEMMA_MODEL) {
  const url = validateGeminiBaseUrl(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/models/${encodeURIComponent(model)}:generateContent`;
  return url.toString();
}

function buildGeminiHeaders(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) {
    throw new TypeError('Gemini API key is required.');
  }
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': key,
  };
}

function buildGeminiPayload(
  claimText,
  conversation = null,
  webSearchContext = '',
  currentRequesterMetadata = null,
  options = {},
) {
  const source = buildDeepSeekPayload(
    claimText,
    conversation,
    webSearchContext,
    currentRequesterMetadata,
    {
      model: options.model,
      effectiveBehavior: options.effectiveBehavior,
      userMemoryContext: options.userMemoryContext,
    },
  );
  const systemInstruction = source.messages[0].content;
  const context = source.messages.slice(1, -1).map(({ content }) => content).filter(Boolean);
  const currentRequest = source.messages.at(-1)?.content || String(claimText || '');

  return {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: [{
      role: 'user',
      parts: [{
        text: [...context, currentRequest].join('\n\n'),
      }],
    }],
  };
}

function getGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part?.thought !== true && typeof part?.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
}

class GeminiApiError extends Error {
  constructor(status, metadata = {}) {
    super(`Gemini API request failed${Number.isInteger(status) ? ` with status ${status}` : ''}.`);
    this.name = 'GeminiApiError';
    this.status = Number.isInteger(status) ? status : null;
    this.code = metadata?.code || 'provider_error';
    this.requestId = sanitizeRequestId(metadata?.requestId);
  }
}

class GeminiTimeoutError extends Error {
  constructor(timeoutMs) {
    super('Gemini API request timed out.');
    this.name = 'GeminiTimeoutError';
    this.code = 'timeout';
    this.timeoutMs = timeoutMs;
  }
}

function getGeminiFailureMessage(error) {
  if (error instanceof GeminiApiError) {
    if (error.status === 429) {
      return 'Gemma 4 is rate limiting me right now. Try again in a bit.';
    }
    if (error.status === 403) {
      return 'The Gemini API key cannot access Gemma 4. Check the key and AI Studio project.';
    }
    if (error.status === 400 || error.status === 422) {
      return 'Gemma 4 rejected this request, probably because the conversation got too long. I reset this channel conversation; try again.';
    }
  }
  if (error instanceof GeminiTimeoutError || error?.name === 'AbortError') {
    return 'Gemma 4 took too long to answer. Try again in a bit.';
  }
  return 'I tried to check but my brain broke.';
}

function shouldResetConversationAfterGeminiError(error) {
  return error instanceof GeminiApiError && (error.status === 400 || error.status === 422);
}

async function generateGemmaResponse(
  claimText,
  conversation = null,
  webSearchContext = '',
  currentRequesterMetadata = null,
  options = {},
) {
  const providerConfig = options.providerConfig || options.gemini || options;
  const fetchImpl = options.fetchImpl || providerConfig.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(providerConfig.timeoutMs) && providerConfig.timeoutMs > 0
    ? providerConfig.timeoutMs
    : DEFAULT_GEMINI_TIMEOUT_MS;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetch implementation is required.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(
        buildGeminiUrl(providerConfig.baseUrl, providerConfig.model),
        {
          method: 'POST',
          headers: buildGeminiHeaders(providerConfig.apiKey),
          body: JSON.stringify(buildGeminiPayload(
            claimText,
            conversation,
            webSearchContext,
            currentRequesterMetadata,
            {
              model: providerConfig.model,
              effectiveBehavior: options.effectiveBehavior,
              userMemoryContext: options.userMemoryContext,
            },
          )),
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new GeminiTimeoutError(timeoutMs);
      }
      throw error;
    }

    const requestId = response?.headers?.get?.('x-request-id')
      || response?.headers?.get?.('x-goog-request-id');
    if (!response?.ok) {
      throw new GeminiApiError(response?.status, { requestId });
    }

    const content = getGeminiText(await response.json());
    if (!content) {
      throw new GeminiApiError(response.status, { code: 'empty_response', requestId });
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_TIMEOUT_MS,
  DEFAULT_GEMMA_MODEL,
  GeminiApiError,
  GeminiTimeoutError,
  buildGeminiHeaders,
  buildGeminiPayload,
  buildGeminiUrl,
  generateGemmaResponse,
  getGeminiFailureMessage,
  getGeminiText,
  shouldResetConversationAfterGeminiError,
  validateGeminiBaseUrl,
};
