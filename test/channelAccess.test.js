'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PermissionFlagsBits } = require('discord.js');

const {
  getChannelAccessCommand,
  handleChannelAccessCommand,
} = require('../src/commands/channelAccess');
const { createDefaultGuildConfig } = require('../src/storage/guildConfigStore');

function createMessage(content, { administrator = false, authorId = 'owner-1' } = {}) {
  const replies = [];
  return {
    content,
    author: { id: authorId, bot: false },
    guildId: 'guild-1',
    guild: { id: 'guild-1', ownerId: 'owner-1' },
    channelId: 'channel-1',
    channel: { id: 'channel-1' },
    member: {
      permissions: {
        has: (permission) => administrator && permission === PermissionFlagsBits.Administrator,
      },
    },
    replies,
    reply: async (options) => {
      replies.push(options);
      return options;
    },
  };
}

function createStore() {
  let config = createDefaultGuildConfig();
  const calls = [];
  return {
    calls,
    get config() {
      return config;
    },
    async update(guildId, updater, updatedBy) {
      calls.push({ guildId, updatedBy });
      config = updater(config) || config;
      return config;
    },
  };
}

test('channel access commands require a direct bot mention and exact command text', () => {
  const message = createMessage('<@bot-user> channelEnable');

  assert.equal(getChannelAccessCommand(message, 'bot-user'), 'enable');
  assert.equal(getChannelAccessCommand(createMessage('channelEnable'), 'bot-user'), null);
  assert.equal(getChannelAccessCommand(createMessage('<@bot-user> channelEnable now'), 'bot-user'), null);
});

test('owner can enable and disable responses for the current channel', async () => {
  const store = createStore();
  const owner = createMessage('<@bot-user> channelEnable');

  assert.equal(await handleChannelAccessCommand(owner, store, 'bot-user'), true);
  assert.deepEqual(store.config.access.channelIds, ['channel-1']);
  assert.match(owner.replies[0].content, /Responses are enabled/i);

  const disable = createMessage('<@bot-user> channelDisable');
  assert.equal(await handleChannelAccessCommand(disable, store, 'bot-user'), true);
  assert.deepEqual(store.config.access.channelIds, []);
  assert.match(disable.replies[0].content, /Responses are disabled/i);
  assert.equal(store.calls.length, 2);
});

test('ordinary members are denied before configuration changes', async () => {
  const store = createStore();
  const member = createMessage('<@bot-user> channelEnable', {
    authorId: 'member-1',
  });

  assert.equal(await handleChannelAccessCommand(member, store, 'bot-user'), true);
  assert.deepEqual(store.config.access.channelIds, []);
  assert.equal(store.calls.length, 0);
  assert.match(member.replies[0].content, /administrator/i);
});

test('a Discord administrator can enable a channel', async () => {
  const store = createStore();
  const administrator = createMessage('<@bot-user> channelEnable', {
    administrator: true,
    authorId: 'admin-1',
  });

  assert.equal(await handleChannelAccessCommand(administrator, store, 'bot-user'), true);
  assert.deepEqual(store.config.access.channelIds, ['channel-1']);
  assert.equal(store.calls[0].updatedBy, 'admin-1');
});
