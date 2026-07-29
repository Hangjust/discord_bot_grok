const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_QWEN_IMAGE_BYTES,
  QwenApiError,
  QwenTimeoutError,
  buildQwenPayload,
  buildQwenUrl,
  collectQwenImages,
  generateQwenResponse,
  getQwenFailureMessage,
  normalizeQwenImage,
} = require('../src/services/qwen');
const { buildDeepSeekPayload } = require('../src/services/deepseek');
const { buildGeminiPayload } = require('../src/services/gemini');

function discordImage(overrides = {}) {
  return {
    url: 'https://cdn.discordapp.com/attachments/100/200/photo.png?ex=signed',
    contentType: 'image/png',
    size: 1024,
    ...overrides,
  };
}

test('Qwen request uses the OpenAI-compatible endpoint and header-only API key', async () => {
  const requests = [];
  const answer = await generateQwenResponse('Describe this', null, '', null, {
    providerConfig: {
      apiKey: 'qwen-secret',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.6-flash',
      timeoutMs: 1000,
    },
    images: [discordImage()],
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'safe-request-id' },
        json: async () => ({ choices: [{ message: { content: 'A test image.' } }] }),
      };
    },
  });

  const payload = JSON.parse(requests[0].options.body);
  assert.equal(answer, 'A test image.');
  assert.equal(
    requests[0].url,
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
  );
  assert.equal(requests[0].options.headers.Authorization, 'Bearer qwen-secret');
  assert.doesNotMatch(requests[0].options.body, /qwen-secret/);
  assert.equal(payload.model, 'qwen3.6-flash');
  assert.equal(payload.messages.at(-1).content[0].type, 'text');
  assert.equal(payload.messages.at(-1).content[1].type, 'image_url');
  assert.match(payload.messages.at(-1).content[1].image_url.url, /^https:\/\/cdn\.discordapp\.com/);
});

test('Qwen image collection accepts bounded Discord CDN images and rejects unsafe inputs', () => {
  const valid = discordImage();
  const duplicate = { ...valid };
  const unsafeHost = discordImage({ url: 'https://attacker.example/attachments/100/200/a.png' });
  const oversized = discordImage({ size: MAX_QWEN_IMAGE_BYTES + 1 });
  const unsupported = discordImage({ contentType: 'application/pdf' });
  const message = {
    attachments: new Map([
      ['1', valid],
      ['2', duplicate],
      ['3', unsafeHost],
      ['4', oversized],
      ['5', unsupported],
    ]),
  };

  assert.equal(normalizeQwenImage(valid).mimeType, 'image/png');
  assert.equal(normalizeQwenImage(unsafeHost), null);
  assert.deepEqual(collectQwenImages(message), [normalizeQwenImage(valid)]);
});

test('Qwen payload remains text-only without valid images and URLs require HTTPS', () => {
  const payload = buildQwenPayload('hello', null, '', null, {
    model: 'qwen3.6-flash',
    images: [{ url: 'https://example.com/nope.png', contentType: 'image/png', size: 100 }],
  });
  assert.equal(payload.messages.at(-1).content, 'hello');
  assert.throws(() => buildQwenUrl('http://example.com/v1'), /HTTPS/);
  assert.throws(() => buildQwenUrl('https://user:pass@example.com/v1'), /HTTPS/);
});

test('administrator custom prompts produce identical system instructions for every AI provider', () => {
  const options = {
    effectiveBehavior: 'Speak like a concise detective and call every clue a breadcrumb.',
    userMemoryContext: 'UNTRUSTED LONG-TERM GUILD MEMBER MEMORY:\nNo relevant facts.',
  };
  const deepseek = buildDeepSeekPayload('Investigate this', null, '', null, options);
  const gemini = buildGeminiPayload('Investigate this', null, '', null, options);
  const qwen = buildQwenPayload('Investigate this', null, '', null, options);

  const expectedSystemPrompt = deepseek.messages[0].content;
  assert.equal(gemini.systemInstruction.parts[0].text, expectedSystemPrompt);
  assert.equal(qwen.messages[0].content, expectedSystemPrompt);
  assert.match(expectedSystemPrompt, /concise detective/);
});

test('Qwen failures are actionable and response bodies stay hidden', async () => {
  await assert.rejects(
    generateQwenResponse('hello', null, '', null, {
      providerConfig: {
        apiKey: 'secret',
        baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        timeoutMs: 1000,
      },
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        headers: { get: () => null },
        json: async () => ({ error: 'provider-secret-body' }),
      }),
    }),
    (error) => {
      assert.equal(error instanceof QwenApiError, true);
      assert.doesNotMatch(error.message, /provider-secret-body|secret/);
      return true;
    },
  );
  assert.match(getQwenFailureMessage(new QwenApiError(429)), /rate limiting/);
  assert.match(getQwenFailureMessage(new QwenTimeoutError(1000)), /too long/);
});
