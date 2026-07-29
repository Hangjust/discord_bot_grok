const {
  buildDeepSeekPayload,
  sanitizeRequestId,
} = require('./deepseek');

const DEFAULT_QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const DEFAULT_QWEN_MODEL = 'qwen3.6-flash';
const DEFAULT_QWEN_TIMEOUT_MS = 30_000;
const MAX_QWEN_IMAGES = 4;
const MAX_QWEN_IMAGE_BYTES = 10 * 1024 * 1024;
const QWEN_IMAGE_MIME_TYPES = Object.freeze(new Set([
  'image/bmp',
  'image/heic',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
]));
const DISCORD_IMAGE_HOSTS = Object.freeze(new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
]));

function validateQwenBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl || DEFAULT_QWEN_BASE_URL).trim());
  } catch {
    throw new TypeError('Qwen base URL must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new TypeError('Qwen base URL must be a valid HTTPS URL.');
  }
  url.search = '';
  url.hash = '';
  return url;
}

function buildQwenUrl(baseUrl = DEFAULT_QWEN_BASE_URL, path = 'chat/completions') {
  const url = validateQwenBaseUrl(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/${String(path).replace(/^\/+/u, '')}`;
  return url.toString();
}

function buildQwenHeaders(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) {
    throw new TypeError('Qwen API key is required.');
  }
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

function normalizeQwenImage(image) {
  let url;
  try {
    url = new URL(String(image?.url || '').trim());
  } catch {
    return null;
  }
  const mimeType = String(image?.contentType || image?.mimeType || '').split(';')[0].toLowerCase();
  const size = Number(image?.size);
  if (url.protocol !== 'https:'
    || url.username
    || url.password
    || !DISCORD_IMAGE_HOSTS.has(url.hostname.toLowerCase())
    || !url.pathname.startsWith('/attachments/')
    || !QWEN_IMAGE_MIME_TYPES.has(mimeType)
    || !Number.isFinite(size)
    || size <= 0
    || size > MAX_QWEN_IMAGE_BYTES) {
    return null;
  }
  return Object.freeze({
    url: url.toString(),
    mimeType,
    size,
  });
}

function getMessageAttachments(message) {
  const attachments = message?.attachments;
  if (!attachments) return [];
  if (typeof attachments.values === 'function') {
    return [...attachments.values()];
  }
  return Array.isArray(attachments) ? attachments : [];
}

function collectQwenImages(...messages) {
  const images = [];
  const seen = new Set();
  for (const message of messages) {
    for (const attachment of getMessageAttachments(message)) {
      const image = normalizeQwenImage(attachment);
      if (!image || seen.has(image.url)) continue;
      seen.add(image.url);
      images.push(image);
      if (images.length === MAX_QWEN_IMAGES) return Object.freeze(images);
    }
  }
  return Object.freeze(images);
}

function buildQwenPayload(
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
    options,
  );
  const images = Array.isArray(options.images)
    ? options.images.map(normalizeQwenImage).filter(Boolean).slice(0, MAX_QWEN_IMAGES)
    : [];
  const messages = source.messages.map((message) => ({ ...message }));
  if (images.length > 0) {
    const current = messages.at(-1);
    current.content = [
      { type: 'text', text: String(current.content || '') },
      ...images.map((image) => ({
        type: 'image_url',
        image_url: { url: image.url },
      })),
    ];
  }
  return {
    model: String(options.model || DEFAULT_QWEN_MODEL),
    messages,
    stream: false,
    max_tokens: 4096,
    temperature: 0.5,
  };
}

function getQwenText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => typeof part?.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
}

class QwenApiError extends Error {
  constructor(status, metadata = {}) {
    super(`Qwen API request failed${Number.isInteger(status) ? ` with status ${status}` : ''}.`);
    this.name = 'QwenApiError';
    this.status = Number.isInteger(status) ? status : null;
    this.code = metadata?.code || 'provider_error';
    this.requestId = sanitizeRequestId(metadata?.requestId);
  }
}

class QwenTimeoutError extends Error {
  constructor(timeoutMs) {
    super('Qwen API request timed out.');
    this.name = 'QwenTimeoutError';
    this.code = 'timeout';
    this.timeoutMs = timeoutMs;
  }
}

function getQwenFailureMessage(error) {
  if (error instanceof QwenApiError) {
    if (error.status === 429) {
      return 'Qwen is rate limiting me right now. Try again in a bit.';
    }
    if (error.status === 401 || error.status === 403) {
      return 'The Qwen API key cannot access this model. Check the key and its Model Studio region.';
    }
    if (error.status === 400 || error.status === 413 || error.status === 422) {
      return 'Qwen rejected this request or image. I reset this channel conversation; try a smaller supported image.';
    }
  }
  if (error instanceof QwenTimeoutError || error?.name === 'AbortError') {
    return 'Qwen took too long to answer. Try again in a bit.';
  }
  return 'I tried to check but my brain broke.';
}

function shouldResetConversationAfterQwenError(error) {
  return error instanceof QwenApiError
    && [400, 413, 422].includes(error.status);
}

async function generateQwenResponse(
  claimText,
  conversation = null,
  webSearchContext = '',
  currentRequesterMetadata = null,
  options = {},
) {
  const providerConfig = options.providerConfig || options.qwen || options;
  const fetchImpl = options.fetchImpl || providerConfig.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(providerConfig.timeoutMs) && providerConfig.timeoutMs > 0
    ? providerConfig.timeoutMs
    : DEFAULT_QWEN_TIMEOUT_MS;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetch implementation is required.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(buildQwenUrl(providerConfig.baseUrl), {
        method: 'POST',
        headers: buildQwenHeaders(providerConfig.apiKey),
        body: JSON.stringify(buildQwenPayload(
          claimText,
          conversation,
          webSearchContext,
          currentRequesterMetadata,
          {
            model: providerConfig.model,
            effectiveBehavior: options.effectiveBehavior,
            userMemoryContext: options.userMemoryContext,
            images: options.images,
          },
        )),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new QwenTimeoutError(timeoutMs);
      }
      throw error;
    }

    const requestId = response?.headers?.get?.('x-request-id')
      || response?.headers?.get?.('request-id');
    if (!response?.ok) {
      throw new QwenApiError(response?.status, { requestId });
    }
    const content = getQwenText(await response.json());
    if (!content) {
      throw new QwenApiError(response.status, { code: 'empty_response', requestId });
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  DEFAULT_QWEN_BASE_URL,
  DEFAULT_QWEN_MODEL,
  DEFAULT_QWEN_TIMEOUT_MS,
  DISCORD_IMAGE_HOSTS,
  MAX_QWEN_IMAGE_BYTES,
  MAX_QWEN_IMAGES,
  QWEN_IMAGE_MIME_TYPES,
  QwenApiError,
  QwenTimeoutError,
  buildQwenHeaders,
  buildQwenPayload,
  buildQwenUrl,
  collectQwenImages,
  generateQwenResponse,
  getQwenFailureMessage,
  getQwenText,
  normalizeQwenImage,
  shouldResetConversationAfterQwenError,
  validateQwenBaseUrl,
};
