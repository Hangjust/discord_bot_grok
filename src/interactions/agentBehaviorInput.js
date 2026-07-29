const {
  MAX_AGENT_DOCUMENT_CHARACTERS,
  normalizeAgentContent,
} = require('../config/guildConfigSchema');

const AGENT_INPUT_TIMEOUT_MS = 5_000;
const MAX_AGENT_ATTACHMENT_BYTES = 64 * 1024;
const DISCORD_ATTACHMENT_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
]);

const INPUT_ERROR_MESSAGES = Object.freeze({
  both_sources: 'Provide either text or one Markdown attachment, not both.',
  empty: 'The behavior document must not be empty.',
  too_long: 'The behavior document must be at most 4,000 characters.',
  invalid_attachment: 'Attach one Markdown (.md) file using a secure Discord upload URL.',
  download_failed: 'The Markdown attachment could not be downloaded or read.',
  invalid_utf8: 'The Markdown attachment must contain valid UTF-8 text.',
  attachment_too_large: 'The Markdown attachment is too large.',
});

class AgentBehaviorInputError extends Error {
  constructor(code) {
    super(INPUT_ERROR_MESSAGES[code] || INPUT_ERROR_MESSAGES.download_failed);
    this.name = 'AgentBehaviorInputError';
    this.code = Object.hasOwn(INPUT_ERROR_MESSAGES, code) ? code : 'download_failed';
  }
}

function fail(code) {
  throw new AgentBehaviorInputError(code);
}

function normalizeInputContent(value) {
  try {
    return normalizeAgentContent(value, 'behavior document');
  } catch (error) {
    if (typeof value !== 'string' || !value.trim()) {
      fail('empty');
    }

    if ([...value.trim()].length > MAX_AGENT_DOCUMENT_CHARACTERS) {
      fail('too_long');
    }

    fail('download_failed');
  }
}

function validateAttachment(attachment, maxBytes) {
  const name = typeof attachment?.name === 'string' ? attachment.name : '';

  if (!/\.md$/i.test(name)) {
    fail('invalid_attachment');
  }

  let url;

  try {
    url = new URL(attachment.url);
  } catch {
    fail('invalid_attachment');
  }

  if (url.protocol !== 'https:'
    || url.username
    || url.password
    || !DISCORD_ATTACHMENT_HOSTS.has(url.hostname.toLowerCase())) {
    fail('invalid_attachment');
  }

  if (Number.isFinite(attachment.size) && attachment.size > maxBytes) {
    fail('attachment_too_large');
  }

  return url;
}

function getContentLength(response) {
  const rawLength = response?.headers?.get?.('content-length');

  if (rawLength === null || rawLength === undefined || rawLength === '') {
    return null;
  }

  const length = Number(rawLength);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

async function readBoundedBody(response, maxBytes) {
  const advertisedLength = getContentLength(response);

  if (advertisedLength !== null && advertisedLength > maxBytes) {
    fail('attachment_too_large');
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        totalBytes += chunk.byteLength;

        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          fail('attachment_too_large');
        }

        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return bytes;
  }

  // Fetch responses provide a ReadableStream in supported runtimes. Refuse a
  // non-streaming body: arrayBuffer() would allocate the entire response before
  // the limit could be enforced when Content-Length is absent or dishonest.
  fail('download_failed');
}

async function fetchAttachment(url, options) {
  const {
    fetchImpl,
    maxBytes,
    timeoutMs,
  } = options;
  const controller = new AbortController();
  let timeoutHandle;

  const timeout = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new AgentBehaviorInputError('download_failed'));
    }, timeoutMs);
  });

  const download = async () => {
    const response = await fetchImpl(url.href, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { Accept: 'text/markdown, text/plain;q=0.9' },
    });

    if (!response?.ok || response.redirected === true) {
      fail('download_failed');
    }

    if (response.url) {
      let responseUrl;

      try {
        responseUrl = new URL(response.url);
      } catch {
        fail('download_failed');
      }

      if (responseUrl.protocol !== 'https:' || responseUrl.href !== url.href) {
        fail('download_failed');
      }
    }

    return await readBoundedBody(response, maxBytes);
  };

  try {
    return await Promise.race([download(), timeout]);
  } catch (error) {
    if (error instanceof AgentBehaviorInputError) {
      throw error;
    }

    fail('download_failed');
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function resolveAgentBehaviorInput(input = {}, dependencies = {}) {
  const hasText = input.text !== undefined && input.text !== null;
  const hasAttachment = input.attachment !== undefined && input.attachment !== null;

  if (hasText && hasAttachment) {
    fail('both_sources');
  }

  if (!hasText && !hasAttachment) {
    return Object.freeze({ kind: 'modal-required' });
  }

  if (hasText) {
    return Object.freeze({
      kind: 'content',
      source: input.textSource === 'modal' ? 'modal' : 'text',
      content: normalizeInputContent(input.text),
    });
  }

  const maxBytes = dependencies.maxBytes ?? MAX_AGENT_ATTACHMENT_BYTES;
  const timeoutMs = dependencies.timeoutMs ?? AGENT_INPUT_TIMEOUT_MS;
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function'
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('valid attachment input dependencies are required');
  }

  const url = validateAttachment(input.attachment, maxBytes);
  const bytes = await fetchAttachment(url, { fetchImpl, maxBytes, timeoutMs });
  let text;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('invalid_utf8');
  }

  return Object.freeze({
    kind: 'content',
    source: 'attachment',
    content: normalizeInputContent(text),
  });
}

module.exports = {
  AGENT_INPUT_TIMEOUT_MS,
  AgentBehaviorInputError,
  INPUT_ERROR_MESSAGES,
  MAX_AGENT_ATTACHMENT_BYTES,
  resolveAgentBehaviorInput,
};
