'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

const { createDefaultGuildConfig } = require('../src/storage/guildConfigStore');
const {
  buildApiKeyModal,
  buildPersonaModal,
  getPersonaValidationError,
  handleSetupInteraction,
  resetApiKeyValidationState,
  validateAccessDraft,
} = require('../src/setup/interactions');
const { buildSetupPanelMessage } = require('../src/setup/panel');
const { getSetupDraft, resetSetupDrafts } = require('../src/setup/drafts');
const { isGuildOwnerOrAdministrator } = require('../src/setup/permissions');
const { personaLimits, setupCustomIds } = require('../src/setup/constants');

const VALID_ENCRYPTED_KEY = 'v1.YQ==.Yg==.Yw==';

function clone(value) {
  return structuredClone(value);
}

function makeGuild(overrides = {}) {
  return {
    id: 'guild-1',
    ownerId: 'owner-1',
    systemChannel: null,
    members: { me: { id: 'bot-member' } },
    channels: { cache: new Map() },
    roles: { cache: new Map() },
    ...overrides,
  };
}

function makeMemoryStore(initialConfig = createDefaultGuildConfig()) {
  let config = clone(initialConfig);
  let rawApiKey = null;
  const calls = {
    get: 0,
    update: [],
    setApiKey: [],
    clearApiKey: [],
  };

  return {
    calls,
    inspect() {
      return clone(config);
    },
    async get() {
      calls.get += 1;
      return clone(config);
    },
    async update(guildId, updater, updatedBy) {
      const draft = clone(config);
      const result = typeof updater === 'function' ? updater(draft) : { ...draft, ...updater };
      config = clone(result === undefined ? draft : result);
      calls.update.push({ guildId, updatedBy });
      return clone(config);
    },
    async hasApiKey() {
      return rawApiKey !== null;
    },
    async setApiKey(guildId, apiKey, keyStatus, updatedBy) {
      rawApiKey = apiKey;
      config.provider = {
        ...config.provider,
        encryptedKey: VALID_ENCRYPTED_KEY,
        keyStatus,
      };
      calls.setApiKey.push({ guildId, apiKey, keyStatus, updatedBy });
      return clone(config);
    },
    async clearApiKey(guildId, updatedBy) {
      rawApiKey = null;
      config.provider = {
        ...config.provider,
        encryptedKey: null,
        keyStatus: 'unchecked',
      };
      calls.clearApiKey.push({ guildId, updatedBy });
      return clone(config);
    },
  };
}

function makeInteraction({
  customId,
  kind = 'button',
  guild = makeGuild(),
  userId = 'owner-1',
  administrator = false,
  fields = {},
  values = [],
} = {}) {
  const calls = {
    reply: [],
    update: [],
    showModal: [],
    deferReply: [],
    editReply: [],
    followUp: [],
  };

  const interaction = {
    customId,
    guild,
    guildId: guild.id,
    user: { id: userId },
    values,
    replied: false,
    deferred: false,
    memberPermissions: {
      has(permission) {
        return permission === PermissionFlagsBits.Administrator && administrator;
      },
    },
    fields: {
      getTextInputValue(id) {
        return fields[id] ?? '';
      },
    },
    inGuild: () => true,
    isButton: () => kind === 'button',
    isModalSubmit: () => kind === 'modal',
    isStringSelectMenu: () => kind === 'string-select',
    isChannelSelectMenu: () => kind === 'channel-select',
    isRoleSelectMenu: () => kind === 'role-select',
    async reply(payload) {
      calls.reply.push(payload);
      interaction.replied = true;
      return payload;
    },
    async update(payload) {
      calls.update.push(payload);
      return payload;
    },
    async showModal(modal) {
      calls.showModal.push(modal);
      return modal;
    },
    async deferReply(payload) {
      calls.deferReply.push(payload);
      interaction.deferred = true;
      return payload;
    },
    async editReply(payload) {
      calls.editReply.push(payload);
      return payload;
    },
    async followUp(payload) {
      calls.followUp.push(payload);
      return payload;
    },
  };

  return { interaction, calls };
}

test.beforeEach(() => {
  resetSetupDrafts();
  resetApiKeyValidationState();
});

test('setup panel reports all four section statuses and exposes four controls', () => {
  const initialPayload = buildSetupPanelMessage(createDefaultGuildConfig());
  const initialEmbed = initialPayload.embeds[0].toJSON();
  const buttons = initialPayload.components[0].toJSON().components;

  assert.equal(initialEmbed.title, 'Set me up');
  assert.deepEqual(
    initialEmbed.fields.map((field) => field.name),
    ['1. Persona', '2. Channels & roles', '3. API key', '4. More settings'],
  );
  assert.match(initialEmbed.fields[0].value, /Not configured/);
  assert.match(initialEmbed.fields[1].value, /Channels: none/);
  assert.match(initialEmbed.fields[2].value, /No API key stored/);
  assert.match(initialEmbed.fields[3].value, /Web search: off/);
  assert.deepEqual(
    buttons.map(({ custom_id: customId, label }) => [customId, label]),
    [
      [setupCustomIds.personaOpen, 'Configure persona'],
      [setupCustomIds.accessOpen, 'Channels & roles'],
      [setupCustomIds.apiKeyOpen, 'Bring your API key'],
      [setupCustomIds.advancedOpen, 'More settings'],
    ],
  );

  const configured = createDefaultGuildConfig();
  configured.persona.characterName = 'Test AI';
  configured.persona.behavior = 'B'.repeat(personaLimits.behaviorMin);
  configured.access.channelIds = ['channel-1'];
  configured.provider.encryptedKey = VALID_ENCRYPTED_KEY;
  configured.provider.keyStatus = 'valid';
  const readyEmbed = buildSetupPanelMessage(configured).embeds[0].toJSON();

  assert.match(readyEmbed.description, /I am ready/);
  assert.match(readyEmbed.fields[0].value, /Test AI/);
  assert.match(readyEmbed.fields[1].value, /Channels: 1 selected/);
  assert.match(readyEmbed.fields[2].value, /API key connected/);
});

test('persona modal requires a 100-character behavior and server validation enforces it', () => {
  const modal = buildPersonaModal(createDefaultGuildConfig()).toJSON();
  const inputs = modal.components.map((row) => row.components[0]);
  const behaviorInput = inputs.find((input) => input.custom_id === setupCustomIds.personaBehavior);

  assert.equal(modal.custom_id, setupCustomIds.personaModal);
  assert.equal(inputs.length, 4);
  assert.equal(behaviorInput.required, true);
  assert.equal(behaviorInput.min_length, personaLimits.behaviorMin);
  assert.match(behaviorInput.label, /100\+/);

  const values = {
    characterName: 'A character',
    behavior: 'x'.repeat(personaLimits.behaviorMin - 1),
    customPrompt: '',
    triggerWord: 'AI',
  };
  assert.match(getPersonaValidationError(values), /100-1500 characters/);
  assert.equal(
    getPersonaValidationError({ ...values, behavior: 'x'.repeat(personaLimits.behaviorMin) }),
    '',
  );
});

test('setup authorization accepts the owner or an administrator and denies ordinary members before store access', async () => {
  const guild = makeGuild();
  const owner = makeInteraction({ customId: setupCustomIds.personaOpen, guild }).interaction;
  const administrator = makeInteraction({
    customId: setupCustomIds.personaOpen,
    guild,
    userId: 'admin-1',
    administrator: true,
  }).interaction;
  const ordinary = makeInteraction({
    customId: setupCustomIds.personaOpen,
    guild,
    userId: 'member-1',
  });
  const store = makeMemoryStore();

  assert.equal(isGuildOwnerOrAdministrator(owner), true);
  assert.equal(isGuildOwnerOrAdministrator(administrator), true);
  assert.equal(isGuildOwnerOrAdministrator(ordinary.interaction), false);

  assert.equal(await handleSetupInteraction(ordinary.interaction, store), true);
  assert.equal(store.calls.get, 0);
  assert.equal(ordinary.calls.reply.length, 1);
  assert.equal(ordinary.calls.reply[0].ephemeral, true);
  assert.match(ordinary.calls.reply[0].content, /Only the server owner or an administrator/);
});

test('persona details remain a user-scoped draft until Save persists them to the fake store', async () => {
  const store = makeMemoryStore();
  const guild = makeGuild();
  const behavior = 'Confident, playful, direct, honest, and helpful. '.repeat(3);
  const modal = makeInteraction({
    customId: setupCustomIds.personaModal,
    kind: 'modal',
    guild,
    fields: {
      [setupCustomIds.personaCharacter]: 'Nova',
      [setupCustomIds.personaBehavior]: behavior,
      [setupCustomIds.personaPrompt]: 'Prefer concise answers.',
      [setupCustomIds.personaTrigger]: 'Nova',
    },
  });

  assert.equal(await handleSetupInteraction(modal.interaction, store), true);
  assert.equal(store.inspect().persona.characterName, '');
  assert.equal(store.calls.update.length, 0);
  assert.equal(modal.calls.reply[0].ephemeral, true);
  assert.ok(getSetupDraft('persona', guild.id, 'owner-1'));

  const select = makeInteraction({
    customId: setupCustomIds.personaProfanity,
    kind: 'string-select',
    guild,
    values: ['strict'],
  });
  await handleSetupInteraction(select.interaction, store);
  assert.equal(store.inspect().persona.profanity, 'casual');
  assert.equal(select.calls.update.length, 1);

  const save = makeInteraction({ customId: setupCustomIds.personaSave, guild });
  await handleSetupInteraction(save.interaction, store);

  const persisted = store.inspect().persona;
  assert.equal(store.calls.update.length, 1);
  assert.equal(store.calls.update[0].updatedBy, 'owner-1');
  assert.equal(persisted.characterName, 'Nova');
  assert.equal(persisted.behavior, behavior.trim());
  assert.equal(persisted.customPrompt, 'Prefer concise answers.');
  assert.equal(persisted.triggerWord, 'Nova');
  assert.equal(persisted.profanity, 'strict');
  assert.equal(getSetupDraft('persona', guild.id, 'owner-1'), null);
  assert.equal(save.calls.update[0].content, '✅ Persona settings saved.');
});

test('API key modal rejects malformed input, uses the injected balance validator, and never echoes the key', async () => {
  const modal = buildApiKeyModal().toJSON();
  const keyInput = modal.components[0].components[0];
  assert.equal(keyInput.custom_id, setupCustomIds.apiKeyValue);
  assert.equal(keyInput.min_length, 20);
  assert.match(keyInput.label, /never shown again/i);

  const store = makeMemoryStore();
  const guild = makeGuild();
  let validatorCalls = 0;
  let fakeFetchCalls = 0;
  const fakeFetch = async () => {
    fakeFetchCalls += 1;
    throw new Error('No network is permitted in this test.');
  };
  const validateApiKeyBalance = async (apiKey, options) => {
    validatorCalls += 1;
    assert.equal(apiKey, validKey);
    assert.equal(options.fetchImpl, fakeFetch);
    return { valid: true, hasBalance: false };
  };

  const malformedKey = 'sk-too-short';
  const malformed = makeInteraction({
    customId: setupCustomIds.apiKeyModal,
    kind: 'modal',
    guild,
    fields: { [setupCustomIds.apiKeyValue]: malformedKey },
  });
  await handleSetupInteraction(malformed.interaction, store, { validateApiKeyBalance, fetchImpl: fakeFetch });
  assert.equal(validatorCalls, 0);
  assert.equal(store.calls.setApiKey.length, 0);
  assert.match(malformed.calls.reply[0].content, /format is invalid/);
  assert.doesNotMatch(JSON.stringify(malformed.calls), new RegExp(malformedKey));

  const validKey = `sk-${'S'.repeat(32)}`;
  const submission = makeInteraction({
    customId: setupCustomIds.apiKeyModal,
    kind: 'modal',
    guild,
    fields: { [setupCustomIds.apiKeyValue]: validKey },
  });
  await handleSetupInteraction(submission.interaction, store, { validateApiKeyBalance, fetchImpl: fakeFetch });

  assert.equal(validatorCalls, 1);
  assert.equal(fakeFetchCalls, 0);
  assert.equal(store.calls.setApiKey.length, 1);
  assert.equal(store.calls.setApiKey[0].apiKey, validKey);
  assert.equal(store.calls.setApiKey[0].keyStatus, 'no_balance');
  assert.deepEqual(submission.calls.deferReply, [{ ephemeral: true }]);
  assert.equal(
    submission.calls.editReply[0].content,
    'My bot has no balance. Please add your balance to the API console.',
  );
  assert.doesNotMatch(JSON.stringify({
    reply: submission.calls.reply,
    update: submission.calls.update,
    editReply: submission.calls.editReply,
    followUp: submission.calls.followUp,
  }), new RegExp(validKey));
});

test('access validation requires usable channels, validates roles, and rejects blocking @everyone', () => {
  const allowedChannel = {
    id: 'channel-1',
    name: 'bot-chat',
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
  };
  const guild = makeGuild({
    channels: { cache: new Map([[allowedChannel.id, allowedChannel]]) },
    roles: {
      cache: new Map([
        ['guild-1', { id: 'guild-1' }],
        ['role-allowed', { id: 'role-allowed' }],
        ['role-blocked', { id: 'role-blocked' }],
      ]),
    },
  });
  const interaction = { guild };

  assert.match(
    validateAccessDraft(interaction, {
      channelIds: [],
      allowedRoleIds: [],
      blockedRoleIds: [],
    }).error,
    /at least one channel/,
  );
  assert.match(
    validateAccessDraft(interaction, {
      channelIds: ['channel-1'],
      allowedRoleIds: [],
      blockedRoleIds: ['guild-1'],
    }).error,
    /@everyone role cannot be blocked/,
  );
  assert.match(
    validateAccessDraft(interaction, {
      channelIds: ['channel-1'],
      allowedRoleIds: ['missing-role'],
      blockedRoleIds: [],
    }).error,
    /selected roles no longer exists/,
  );

  assert.deepEqual(
    validateAccessDraft(interaction, {
      channelIds: ['channel-1', 'channel-1'],
      allowedRoleIds: ['role-allowed'],
      blockedRoleIds: ['role-blocked'],
    }),
    {
      values: {
        channelIds: ['channel-1'],
        allowedRoleIds: ['role-allowed'],
        blockedRoleIds: ['role-blocked'],
      },
    },
  );
});
