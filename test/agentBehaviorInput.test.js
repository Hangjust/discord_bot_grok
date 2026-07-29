const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AgentBehaviorInputError,
  MAX_AGENT_ATTACHMENT_BYTES,
  resolveAgentBehaviorInput,
} = require('../src/interactions/agentBehaviorInput');

const HTTPS_URL = 'https://cdn.discordapp.com/attachments/1/2/AGENTS.md';

function attachment(overrides = {}) {
  return {
    name: 'AGENTS.md',
    size: 12,
    url: HTTPS_URL,
    ...overrides,
  };
}

function response(bytes, overrides = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
  const body = {
    getReader: () => {
      let sent = false;
      return {
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: data };
        },
        cancel: async () => {},
        releaseLock: () => {},
      };
    },
  };
  return {
    ok: true,
    redirected: false,
    url: HTTPS_URL,
    headers: { get: () => null },
    body,
    ...overrides,
  };
}

async function expectInputError(code, input, dependencies) {
  await assert.rejects(
    resolveAgentBehaviorInput(input, dependencies),
    (error) => {
      assert.equal(error instanceof AgentBehaviorInputError, true);
      assert.equal(error.code, code);
      assert.equal(error.message.includes('SECRET-SUBMITTED-CONTENT'), false);
      return true;
    },
  );
}

test('direct slash and modal text share outer-trim normalization', async () => {
  const slash = await resolveAgentBehaviorInput({ text: ' \n# Rules\n\nBe concise. \t' });
  const modal = await resolveAgentBehaviorInput({
    text: '\r\n# Rules\n\nBe concise.\r\n',
    textSource: 'modal',
  });

  assert.deepEqual(slash, {
    kind: 'content',
    source: 'text',
    content: '# Rules\n\nBe concise.',
  });
  assert.deepEqual(modal, {
    kind: 'content',
    source: 'modal',
    content: '# Rules\n\nBe concise.',
  });
  assert.equal(Object.isFrozen(slash), true);
});

test('neither source signals that the caller should immediately show a modal', async () => {
  assert.deepEqual(await resolveAgentBehaviorInput(), { kind: 'modal-required' });
});

test('lowercase and uppercase Markdown attachments decode strict UTF-8', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return response(' \n# Héllo 🌍\n ');
  };

  for (const name of ['rules.md', 'RULES.MD']) {
    const result = await resolveAgentBehaviorInput(
      { attachment: attachment({ name }) },
      { fetchImpl },
    );
    assert.deepEqual(result, {
      kind: 'content',
      source: 'attachment',
      content: '# Héllo 🌍',
    });
  }

  assert.equal(seen.length, 2);
  assert.equal(seen[0].options.method, 'GET');
  assert.equal(seen[0].options.redirect, 'error');
  assert.equal(seen[0].options.signal instanceof AbortSignal, true);
});

test('exactly 4,000 Unicode characters pass for every text source', async () => {
  const content = '🌍'.repeat(4_000);
  const direct = await resolveAgentBehaviorInput({ text: content });
  const uploaded = await resolveAgentBehaviorInput(
    { attachment: attachment() },
    { fetchImpl: async () => response(content) },
  );

  assert.equal([...direct.content].length, 4_000);
  assert.equal([...uploaded.content].length, 4_000);
});

test('source and content rejection table returns only stable generic errors', async (t) => {
  const cases = [
    ['both_sources', {
      text: 'SECRET-SUBMITTED-CONTENT',
      attachment: attachment(),
    }],
    ['empty', { text: ' \r\n\t ' }],
    ['too_long', { text: `SECRET-SUBMITTED-CONTENT${'x'.repeat(4_001)}` }],
    ['invalid_attachment', { attachment: attachment({ name: 'rules.txt' }) }],
    ['invalid_attachment', { attachment: attachment({ url: 'http://cdn.discordapp.com/rules.md' }) }],
    ['invalid_attachment', { attachment: attachment({ url: 'https://example.com/rules.md' }) }],
    ['invalid_attachment', { attachment: attachment({ url: 'not a URL' }) }],
    ['attachment_too_large', {
      attachment: attachment({ size: MAX_AGENT_ATTACHMENT_BYTES + 1 }),
    }],
  ];

  for (const [code, input] of cases) {
    await t.test(code, () => expectInputError(code, input));
  }
});

test('4,001 Unicode characters are rejected after strict attachment decoding', async () => {
  await expectInputError(
    'too_long',
    { attachment: attachment() },
    { fetchImpl: async () => response('🌍'.repeat(4_001)) },
  );
});

test('HTTP, fetch, redirect, and response-protocol anomalies use a generic download error', async (t) => {
  const cases = [
    async () => response('SECRET-SUBMITTED-CONTENT', { ok: false, status: 403 }),
    async () => {
      throw new Error('SECRET-SUBMITTED-CONTENT');
    },
    async () => response('SECRET-SUBMITTED-CONTENT', { redirected: true }),
    async () => response('SECRET-SUBMITTED-CONTENT', {
      url: 'http://cdn.discordapp.com/attachments/1/2/AGENTS.md',
    }),
    async () => response('SECRET-SUBMITTED-CONTENT', {
      url: 'https://cdn.discordapp.com/attachments/1/2/other.md',
    }),
  ];

  for (const fetchImpl of cases) {
    await t.test('download rejection', () => expectInputError(
      'download_failed',
      { attachment: attachment() },
      { fetchImpl },
    ));
  }
});

test('timeout aborts the attachment request and exposes no provider detail', async () => {
  let signal;
  const fetchImpl = async (url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  };

  await expectInputError(
    'download_failed',
    { attachment: attachment() },
    { fetchImpl, timeoutMs: 5 },
  );
  assert.equal(signal.aborted, true);
});

test('timeout also bounds a stalled response body read', async () => {
  let signal;
  const fetchImpl = async (url, options) => {
    signal = options.signal;
    return response('', {
      body: {
        getReader: () => ({
          read: async () => new Promise(() => {}),
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    });
  };

  await expectInputError(
    'download_failed',
    { attachment: attachment() },
    { fetchImpl, timeoutMs: 5 },
  );
  assert.equal(signal.aborted, true);
});

test('invalid UTF-8 is rejected without replacement decoding', async () => {
  await expectInputError(
    'invalid_utf8',
    { attachment: attachment() },
    { fetchImpl: async () => response(Uint8Array.from([0xc3, 0x28])) },
  );
});

test('advertised, non-streaming, and streamed oversized bodies are bounded', async (t) => {
  await t.test('content-length before read', async () => {
    let read = false;
    await expectInputError(
      'attachment_too_large',
      { attachment: attachment({ size: 4 }) },
      {
        maxBytes: 4,
        fetchImpl: async () => response('safe', {
          headers: { get: () => '5' },
          arrayBuffer: async () => {
            read = true;
            return new ArrayBuffer(0);
          },
        }),
      },
    );
    assert.equal(read, false);
  });

  await t.test('non-streaming response is rejected without invoking full-body reader', async () => {
    let invoked = false;
    await expectInputError(
      'download_failed',
      { attachment: attachment({ size: 4 }) },
      {
        maxBytes: 4,
        fetchImpl: async () => response('12345', {
          body: null,
          arrayBuffer: async () => {
            invoked = true;
            return new ArrayBuffer(1_000_000);
          },
        }),
      },
    );
    assert.equal(invoked, false);
  });

  await t.test('stream during read', async () => {
    let cancelled = false;
    let reads = 0;
    const body = {
      getReader: () => ({
        read: async () => ({
          done: false,
          value: ++reads === 1
            ? Uint8Array.from([1, 2, 3])
            : Uint8Array.from([4, 5, 6]),
        }),
        cancel: async () => {
          cancelled = true;
        },
        releaseLock: () => {},
      }),
    };

    await expectInputError(
      'attachment_too_large',
      { attachment: attachment({ size: 4 }) },
      { maxBytes: 4, fetchImpl: async () => response('', { body }) },
    );
    assert.equal(cancelled, true);
  });
});

test('a caller can keep service mutation after validation with zero calls on failures', async () => {
  const serviceCalls = [];
  const apply = async (input, dependencies) => {
    const resolved = await resolveAgentBehaviorInput(input, dependencies);

    if (resolved.kind === 'content') {
      serviceCalls.push(resolved.content);
    }
  };

  await assert.rejects(apply({ text: '', attachment: attachment() }), AgentBehaviorInputError);
  await assert.rejects(apply(
    { attachment: attachment() },
    { fetchImpl: async () => response(Uint8Array.from([0xff])) },
  ), AgentBehaviorInputError);
  assert.deepEqual(serviceCalls, []);

  await apply({ text: ' valid ' });
  assert.deepEqual(serviceCalls, ['valid']);
});
