const assert = require('node:assert/strict');
const test = require('node:test');
const {
  GeminiApiError,
  GeminiTimeoutError,
  buildGeminiPayload,
  buildGeminiUrl,
  generateGemmaResponse,
  getGeminiFailureMessage,
  getGeminiText,
} = require('../src/services/gemini');

test('Gemma 4 request uses the official Gemini endpoint and header-only API key', async () => {
  const requests = [];
  const secret = 'gemini-secret-must-stay-in-header';
  const answer = await generateGemmaResponse(
    'Explain this',
    { messages: [{ role: 'user', content: 'Earlier context' }] },
    '',
    { userId: '2001', displayName: 'User' },
    {
      providerConfig: {
        provider: 'gemma4',
        apiKey: secret,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'gemma-4-26b-a4b-it',
        timeoutMs: 1000,
      },
      effectiveBehavior: 'Be concise.',
      userMemoryContext: 'UNTRUSTED LONG-TERM MEMBER MEMORY: remembered detail',
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Gemma response' }] } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
  );

  assert.equal(answer, 'Gemma response');
  assert.equal(
    requests[0].url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent',
  );
  assert.equal(requests[0].options.headers['x-goog-api-key'], secret);
  assert.doesNotMatch(requests[0].url, new RegExp(secret));
  assert.doesNotMatch(requests[0].options.body, new RegExp(secret));
  const body = JSON.parse(requests[0].options.body);
  assert.match(body.systemInstruction.parts[0].text, /Be concise/);
  assert.match(body.contents[0].parts[0].text, /remembered detail/);
  assert.match(body.contents[0].parts[0].text, /Explain this/);
});

test('Gemini payload keeps system instructions separate and ignores thought parts', () => {
  const payload = buildGeminiPayload('Current request', null, '', null, {});
  assert.equal(payload.contents[0].role, 'user');
  assert.match(payload.systemInstruction.parts[0].text, /Discord/);
  assert.equal(getGeminiText({
    candidates: [{
      content: {
        parts: [
          { thought: true, text: 'private reasoning' },
          { text: 'public answer' },
        ],
      },
    }],
  }), 'public answer');
});

test('Gemini URL validation rejects credentials and non-HTTPS endpoints', () => {
  assert.throws(() => buildGeminiUrl('http://example.com', 'gemma-4-26b-a4b-it'), /HTTPS/);
  assert.throws(() => buildGeminiUrl('https://user:pass@example.com', 'gemma-4-26b-a4b-it'), /HTTPS/);
});

test('Gemma 4 failures are actionable and response bodies stay hidden', async () => {
  await assert.rejects(
    generateGemmaResponse('test', null, '', null, {
      providerConfig: {
        apiKey: 'secret',
        model: 'gemma-4-26b-a4b-it',
        timeoutMs: 1000,
      },
      fetchImpl: async () => new Response('sensitive provider body', {
        status: 403,
        headers: { 'x-goog-request-id': 'safe-request-id' },
      }),
    }),
    (error) => {
      assert.equal(error instanceof GeminiApiError, true);
      assert.equal(error.status, 403);
      assert.equal(error.requestId, 'safe-request-id');
      assert.doesNotMatch(error.message, /sensitive provider body/);
      assert.match(getGeminiFailureMessage(error), /key cannot access Gemma 4/);
      return true;
    },
  );
  assert.match(getGeminiFailureMessage(new GeminiApiError(429)), /rate limiting/);
});

test('Gemma 4 requests time out through the shared abort boundary', async () => {
  await assert.rejects(
    generateGemmaResponse('test', null, '', null, {
      providerConfig: { apiKey: 'secret', timeoutMs: 5 },
      fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {
          name: 'AbortError',
        })));
      }),
    }),
    GeminiTimeoutError,
  );
});
