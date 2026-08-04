const conversationTails = new Map();
const guildGenerations = new Map();
const guildQueueControllers = new Map();
const conversationQueueControllers = new Map();
const coalescedTasks = new Map();

function getGuildIdFromConversationKey(conversationKey) {
  return String(conversationKey).split(':', 1)[0];
}

function getGuildGeneration(guildId) {
  if (!guildGenerations.has(guildId)) guildGenerations.set(guildId, Symbol('guild-generation'));
  return guildGenerations.get(guildId);
}

async function runInConversationQueue(conversationKey, task) {
  if (typeof task !== 'function') {
    throw new TypeError('A conversation queue task is required.');
  }

  const key = String(conversationKey);
  const guildId = getGuildIdFromConversationKey(key);
  const generation = getGuildGeneration(guildId);
  const controller = new AbortController();
  const isCurrent = () => !controller.signal.aborted
    && guildGenerations.get(guildId) === generation;
  const previous = conversationTails.get(key) ?? Promise.resolve();
  let queueControllers = guildQueueControllers.get(guildId);
  if (!queueControllers) {
    queueControllers = new Set();
    guildQueueControllers.set(guildId, queueControllers);
  }
  queueControllers.add(controller);
  let conversationControllers = conversationQueueControllers.get(key);
  if (!conversationControllers) {
    conversationControllers = new Set();
    conversationQueueControllers.set(key, conversationControllers);
  }
  conversationControllers.add(controller);
  const current = previous.catch(() => null).then(() => (
    isCurrent() ? task(isCurrent, controller.signal) : undefined
  ));
  conversationTails.set(key, current);

  try {
    return await current;
  } finally {
    if (conversationTails.get(key) === current) {
      conversationTails.delete(key);
    }
    const currentQueueControllers = guildQueueControllers.get(guildId);
    if (currentQueueControllers?.delete(controller) && currentQueueControllers.size === 0) {
      guildQueueControllers.delete(guildId);
      guildGenerations.delete(guildId);
    }
    const currentConversationControllers = conversationQueueControllers.get(key);
    if (currentConversationControllers?.delete(controller)
      && currentConversationControllers.size === 0) {
      conversationQueueControllers.delete(key);
    }
  }
}

function scheduleCoalescedTask(key, record) {
  const scheduled = runInConversationQueue(key, async (isCurrent, signal) => {
    while (isCurrent() && record.items.length > 0) {
      const items = record.items.splice(0, record.items.length);
      await record.task(items, isCurrent, signal);
    }
  });
  record.scheduled = scheduled;
  scheduled.catch((error) => {
    console.error('Coalesced conversation task failed.', { name: error?.name });
  }).finally(() => {
    if (record.scheduled !== scheduled) return;
    record.scheduled = null;
    if (record.cancelled) return;
    if (record.items.length > 0) scheduleCoalescedTask(key, record);
    else if (coalescedTasks.get(key) === record) coalescedTasks.delete(key);
  });
}

function enqueueCoalescedConversationTask(conversationKey, item, maxPending, task) {
  if (typeof task !== 'function') throw new TypeError('A coalesced conversation task is required.');
  const key = String(conversationKey);
  const limit = Math.max(1, Math.floor(Number(maxPending) || 1));
  let record = coalescedTasks.get(key);
  if (!record) {
    record = { cancelled: false, items: [], scheduled: null, task };
    coalescedTasks.set(key, record);
  }
  record.task = task;
  record.items.push(item);
  if (record.items.length > limit) record.items.splice(0, record.items.length - limit);
  if (!record.scheduled) scheduleCoalescedTask(key, record);
}

function resetGuildConversationQueues(guildId) {
  const normalizedGuildId = String(guildId);
  const prefix = `${normalizedGuildId}:`;
  guildGenerations.set(normalizedGuildId, Symbol('guild-generation-reset'));
  const removedKeys = new Set();
  for (const key of conversationTails.keys()) {
    if (key.startsWith(prefix) && conversationTails.delete(key)) removedKeys.add(key);
  }
  for (const key of coalescedTasks.keys()) {
    if (!key.startsWith(prefix)) continue;
    const record = coalescedTasks.get(key);
    if (record) {
      record.cancelled = true;
      record.items.length = 0;
    }
    if (coalescedTasks.delete(key)) removedKeys.add(key);
  }
  const controllers = guildQueueControllers.get(normalizedGuildId);
  if (controllers) {
    for (const controller of controllers) controller.abort();
  } else guildGenerations.delete(normalizedGuildId);
  return removedKeys.size;
}

function resetConversationQueue(conversationKey) {
  const key = String(conversationKey);
  let removed = conversationTails.delete(key);
  const record = coalescedTasks.get(key);
  if (record) {
    record.cancelled = true;
    record.items.length = 0;
    coalescedTasks.delete(key);
    removed = true;
  }
  const controllers = conversationQueueControllers.get(key);
  if (controllers) {
    for (const controller of controllers) controller.abort();
    removed = true;
  }
  return removed;
}

function resetConversationQueues() {
  for (const controllers of guildQueueControllers.values()) {
    for (const controller of controllers) controller.abort();
  }
  conversationTails.clear();
  for (const record of coalescedTasks.values()) {
    record.cancelled = true;
    record.items.length = 0;
  }
  coalescedTasks.clear();
  guildGenerations.clear();
  guildQueueControllers.clear();
  conversationQueueControllers.clear();
}

module.exports = {
  enqueueCoalescedConversationTask,
  resetConversationQueues,
  resetConversationQueue,
  resetGuildConversationQueues,
  runInConversationQueue,
};
