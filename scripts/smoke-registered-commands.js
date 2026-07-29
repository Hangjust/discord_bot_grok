require('dotenv').config();

const { isDeepStrictEqual } = require('node:util');
const { REST, Routes } = require('discord.js');
const {
  discordApplicationId,
  token,
} = require('../src/config/env');
const { commandDefinitions } = require('../src/interactions/commandDefinitions');

function projectToDefinition(actual, definition) {
  if (Array.isArray(definition)) {
    if (!Array.isArray(actual)) {
      return actual;
    }
    return definition.map((expectedItem, index) => projectToDefinition(actual[index], expectedItem));
  }

  if (definition && typeof definition === 'object') {
    const projected = {};
    for (const [key, expectedValue] of Object.entries(definition)) {
      projected[key] = projectToDefinition(actual?.[key], expectedValue);
    }
    return projected;
  }

  return actual;
}

function normalizeCommandDefinition(value, key = '') {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => normalizeCommandDefinition(entry));
    return key === 'channel_types'
      ? normalized.sort((left, right) => left - right)
      : normalized;
  }

  if (value && typeof value === 'object') {
    const normalized = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childValue === undefined
        || (childKey === 'options' && Array.isArray(childValue) && childValue.length === 0)
        || (childKey === 'required' && childValue === false)) {
        continue;
      }
      normalized[childKey] = normalizeCommandDefinition(childValue, childKey);
    }
    return normalized;
  }

  return value;
}

function compareRegisteredCommands(registered, definitions = commandDefinitions) {
  const registeredByName = new Map(
    (Array.isArray(registered) ? registered : []).map((command) => [command.name, command]),
  );
  const differences = [];

  for (const definition of definitions) {
    const actual = registeredByName.get(definition.name);
    if (!actual) {
      differences.push(`${definition.name}: missing`);
      continue;
    }

    const normalizedDefinition = normalizeCommandDefinition(definition);
    const normalizedActual = normalizeCommandDefinition(actual);
    const projected = projectToDefinition(normalizedActual, normalizedDefinition);
    if (!isDeepStrictEqual(projected, normalizedDefinition)) {
      differences.push(`${definition.name}: definition differs`);
    }
  }

  return Object.freeze({
    ok: differences.length === 0,
    differences: Object.freeze(differences),
    checkedNames: Object.freeze(definitions.map(({ name }) => name)),
  });
}

async function smokeRegisteredCommands(options = {}) {
  const registrationToken = options.token ?? token;
  const applicationId = options.discordApplicationId ?? discordApplicationId;
  const logger = options.logger || console;

  if (!registrationToken) {
    throw new Error('DISCORD_TOKEN is required for the read-only command smoke check.');
  }
  if (!/^\d+$/.test(applicationId)) {
    throw new Error('DISCORD_APPLICATION_ID must be set to the numeric application ID.');
  }

  const rest = options.rest || new REST({ version: '10' }).setToken(registrationToken);
  const route = Routes.applicationCommands(applicationId);
  const registered = await rest.get(route);
  const comparison = compareRegisteredCommands(registered);

  if (!comparison.ok) {
    throw new Error(`Registered command smoke check failed: ${comparison.differences.join('; ')}`);
  }

  logger.log(`Verified ${comparison.checkedNames.length} owned global command definition(s) using read-only Discord REST.`);
  return comparison;
}

if (require.main === module) {
  smokeRegisteredCommands().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  compareRegisteredCommands,
  normalizeCommandDefinition,
  projectToDefinition,
  smokeRegisteredCommands,
};
