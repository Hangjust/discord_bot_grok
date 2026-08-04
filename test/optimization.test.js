const assert = require('node:assert/strict');
const { afterEach, beforeEach, test } = require('node:test');

const {
  enqueueCoalescedConversationTask,
  resetConversationQueues,
  resetGuildConversationQueues,
  runInConversationQueue,
} = require('../src/chat/conversationQueue');
const { reconcileSetupPanels } = require('../src/events/ready');
const {
  DeepSeekApiError,
  generateChatResponse,
} = require('../src/services/deepseek');
const {
  maxWebSearchResponseBytes,
  searchWeb,
} = require('../src/services/webSearch');
const {
  appendConversationTurn,
  clearConversations,
  createConversation,
  maxStoredMessageCharacters,
} = require('../src/state/conversations');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  resetConversationQueues();
  clearConversations();
});

afterEach(() => {
  resetConversationQueues();
  clearConversations();
});

test('provider timeout remains active while reading a body received after headers', async () => {
  const bodyReadStarted = deferred();
  const neverFinishes = new Promise(() => {});
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json() {
      bodyReadStarted.resolve();
      return neverFinishes;
    },
  });

  const request = generateChatResponse({
    apiKey: 'test-key',
    currentMessage: 'hello',
    fetchImpl,
    timeoutMs: 20,
  });

  await bodyReadStarted.promise;
  await assert.rejects(request, (error) => {
    assert.ok(error instanceof DeepSeekApiError);
    assert.equal(error.code, 'timeout');
    assert.equal(error.status, 0);
    return true;
  });
});

test('web search rejects oversized bodies before JSON allocation', async () => {
  let cancelled = false;
  await assert.rejects(
    searchWeb('current weather', {
      apiKey: 'test-search-key',
      enabled: true,
      maxResults: 3,
      timeoutMs: 1000,
    }, async () => ({
      body: { cancel: async () => { cancelled = true; } },
      headers: { get: () => String(maxWebSearchResponseBytes + 1) },
      ok: true,
      status: 200,
    })),
    /size limit/,
  );
  assert.equal(cancelled, true);
});

test('resetting a guild aborts the signal of its active conversation task', async () => {
  const taskStarted = deferred();
  let activeSignal;
  let currentAfterReset;

  const queuedTask = runInConversationQueue('guild-reset:channel', async (isCurrent, signal) => {
    activeSignal = signal;
    taskStarted.resolve();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    currentAfterReset = isCurrent();
    return signal.aborted;
  });

  await taskStarted.promise;
  assert.equal(activeSignal.aborted, false);
  assert.equal(resetGuildConversationQueues('guild-reset'), 1);
  assert.equal(activeSignal.aborted, true);
  assert.equal(await queuedTask, true);
  assert.equal(currentAfterReset, false);
});

test('coalesced queues retain only the latest bounded pending batch', async () => {
  const firstBatchStarted = deferred();
  const releaseFirstBatch = deferred();
  const latestBatchObserved = deferred();
  const batches = [];

  const consumeBatch = async (items) => {
    batches.push([...items]);
    if (batches.length === 1) {
      firstBatchStarted.resolve();
      await releaseFirstBatch.promise;
    } else {
      latestBatchObserved.resolve();
    }
  };

  enqueueCoalescedConversationTask('guild-coalesced:channel', 1, 3, consumeBatch);
  await firstBatchStarted.promise;

  for (let item = 2; item <= 100; item += 1) {
    enqueueCoalescedConversationTask('guild-coalesced:channel', item, 3, consumeBatch);
  }

  releaseFirstBatch.resolve();
  await latestBatchObserved.promise;

  assert.deepEqual(batches, [[1], [98, 99, 100]]);
  assert.equal(batches.flat().length, 4);
});

test('guild reset discards coalesced items waiting behind active work', async () => {
  const firstBatchStarted = deferred();
  const releaseFirstBatch = deferred();
  const batches = [];
  const consumeBatch = async (items) => {
    batches.push([...items]);
    firstBatchStarted.resolve();
    await releaseFirstBatch.promise;
  };

  enqueueCoalescedConversationTask('guild-reset-coalesced:channel', 1, 3, consumeBatch);
  await firstBatchStarted.promise;
  enqueueCoalescedConversationTask('guild-reset-coalesced:channel', 2, 3, consumeBatch);
  resetGuildConversationQueues('guild-reset-coalesced');
  releaseFirstBatch.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(batches, [[1]]);
});

test('stored conversation messages truncate at the exported character cap', () => {
  const conversation = createConversation(1);
  const oversizedUserMessage = 'u'.repeat(maxStoredMessageCharacters + 500);
  const oversizedAssistantMessage = 'a'.repeat(maxStoredMessageCharacters + 500);

  appendConversationTurn(
    conversation,
    oversizedUserMessage,
    oversizedAssistantMessage,
    2,
  );

  assert.equal(conversation.messages.length, 2);
  assert.equal(conversation.messages[0].content.length, maxStoredMessageCharacters);
  assert.equal(conversation.messages[1].content.length, maxStoredMessageCharacters);
  assert.equal(conversation.messages[0].content.at(-1), '…');
  assert.equal(conversation.messages[1].content.at(-1), '…');
  assert.equal(conversation.messages[0].content.slice(0, -1), 'u'.repeat(maxStoredMessageCharacters - 1));
  assert.equal(conversation.messages[1].content.slice(0, -1), 'a'.repeat(maxStoredMessageCharacters - 1));
});

test('ready reconciliation requests non-refresh panel checks', async () => {
  const guilds = [{ id: 'guild-1' }, { id: 'guild-2' }, { id: 'guild-3' }];
  const store = { name: 'fake-store' };
  const calls = [];

  const result = await reconcileSetupPanels(guilds, store, 2, async (guild, receivedStore, options) => {
    calls.push({ guild, options, store: receivedStore });
  });

  assert.deepEqual(result, { failedCount: 0, processedCount: 3 });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.store === store));
  assert.deepEqual(calls.map((call) => call.guild.id).sort(), ['guild-1', 'guild-2', 'guild-3']);
  assert.ok(calls.every((call) => assert.deepEqual(call.options, { refresh: false }) === undefined));
});
