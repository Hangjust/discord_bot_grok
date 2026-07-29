const { mkdir, open, readFile, rename, unlink } = require('node:fs/promises');
const { dirname, resolve } = require('node:path');
const {
  cloneValue,
  createDefaultGuildConfig,
  createEmptyDocument,
  immutableSnapshot,
  normalizeGuildConfig,
  normalizeGuildConfigDocument,
  normalizeId,
} = require('../config/guildConfigSchema');

async function writeJsonAtomic(filePath, document) {
  const directory = dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const serialized = `${JSON.stringify(document, null, 2)}\n`;

  await mkdir(directory, { recursive: true });
  let handle;

  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, filePath);
  } catch {
    if (handle) {
      await handle.close().catch(() => {});
    }

    await unlink(temporaryPath).catch(() => {});
    throw new Error('Unable to persist guild configuration');
  }
}

function createGuildConfigStore(options = {}) {
  const filePath = resolve(options.filePath || './data/guild-config.json');
  const atomicWriter = options.atomicWriter || writeJsonAtomic;
  let document = createEmptyDocument();
  let initialized = false;
  let initializationPromise = null;
  let updateQueue = Promise.resolve();

  async function initialize() {
    if (initialized) {
      return immutableSnapshot(document);
    }

    if (!initializationPromise) {
      initializationPromise = (async () => {
        try {
          const serialized = await readFile(filePath, 'utf8');
          const parsed = JSON.parse(serialized);
          const sourceSchemaVersion = Number(parsed.schemaVersion ?? parsed.version ?? 1);
          const normalizedDocument = normalizeGuildConfigDocument(parsed);
          const sourceGuilds = parsed.guilds ?? parsed.records ?? {};
          const hasLegacyGuild = Object.values(sourceGuilds).some((record) => (
            Number(record?.schemaVersion ?? record?.version ?? 1)
              < normalizedDocument.schemaVersion
          ));

          if (sourceSchemaVersion < normalizedDocument.schemaVersion || hasLegacyGuild) {
            await atomicWriter(filePath, normalizedDocument);
          }

          document = normalizedDocument;
        } catch (error) {
          if (error?.code === 'ENOENT') {
            document = createEmptyDocument();
          } else if (error instanceof SyntaxError) {
            throw new Error('Guild configuration file contains invalid JSON');
          } else {
            throw error;
          }
        }

        initialized = true;
        return immutableSnapshot(document);
      })().catch((error) => {
        initializationPromise = null;
        throw error;
      });
    }

    return initializationPromise;
  }

  async function getDocument() {
    await initialize();
    return immutableSnapshot(document);
  }

  async function getGuild(guildId) {
    await initialize();
    const normalizedGuildId = normalizeId(guildId, 'guildId');
    const record = document.guilds[normalizedGuildId];
    return record ? immutableSnapshot(record) : null;
  }

  function updateGuild(guildId, updater) {
    if (typeof updater !== 'function') {
      return Promise.reject(new TypeError('guild config updater must be a function'));
    }

    const operation = updateQueue.then(async () => {
      await initialize();
      const normalizedGuildId = normalizeId(guildId, 'guildId');
      const current = document.guilds[normalizedGuildId]
        ? cloneValue(document.guilds[normalizedGuildId])
        : createDefaultGuildConfig(normalizedGuildId);
      const updated = await updater(current);
      const normalized = normalizeGuildConfig(normalizedGuildId, updated ?? current);

      if (document.guilds[normalizedGuildId]
        && JSON.stringify(normalized) === JSON.stringify(document.guilds[normalizedGuildId])) {
        return immutableSnapshot(document.guilds[normalizedGuildId]);
      }

      const candidate = cloneValue(document);
      candidate.guilds[normalizedGuildId] = normalized;
      const normalizedDocument = normalizeGuildConfigDocument(candidate);

      await atomicWriter(filePath, normalizedDocument);
      document = normalizedDocument;
      return immutableSnapshot(normalized);
    });

    updateQueue = operation.catch(() => {});
    return operation;
  }

  return Object.freeze({
    filePath,
    getDocument,
    getGuild,
    initialize,
    updateGuild,
  });
}

module.exports = {
  createGuildConfigStore,
  writeJsonAtomic,
};
