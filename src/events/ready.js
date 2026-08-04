const { setReadyPresence } = require('../discord/presence');
const { ensureSetupPanel } = require('../setup/panel');
const {
  startConfiguredGuildIdleChatterTimers,
  startGuildIdleChatterTimers,
} = require('../state/idleChatter');

const setupPanelReconcileConcurrency = 4;

async function reconcileSetupPanels(
  guilds,
  store,
  concurrency = setupPanelReconcileConcurrency,
  reconcilePanel = ensureSetupPanel,
) {
  const iterator = guilds?.[Symbol.iterator]?.();
  if (!iterator) return { failedCount: 0, processedCount: 0 };

  let failedCount = 0;
  let processedCount = 0;
  const workerCount = Math.max(1, Math.min(16, Number(concurrency) || 1));
  const worker = async () => {
    for (;;) {
      const next = iterator.next();
      if (next.done) return;
      processedCount += 1;
      try {
        await reconcilePanel(next.value, store, { refresh: false });
      } catch {
        failedCount += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  return { failedCount, processedCount };
}

async function handleReady(readyClient, store) {
  setReadyPresence(readyClient);
  console.log(`Logged in as ${readyClient.user.tag}`);

  if (!store) {
    startGuildIdleChatterTimers(readyClient);
    return;
  }

  const guilds = readyClient.guilds?.cache?.values?.() ?? [];
  const [panelResult] = await Promise.all([
    reconcileSetupPanels(guilds, store),
    startConfiguredGuildIdleChatterTimers(readyClient, store),
  ]);
  const { failedCount } = panelResult;
  if (failedCount > 0) {
    console.warn('Some guild setup panels could not be reconciled.', { failedCount });
  }
}

module.exports = {
  handleReady,
  reconcileSetupPanels,
  setupPanelReconcileConcurrency,
};
