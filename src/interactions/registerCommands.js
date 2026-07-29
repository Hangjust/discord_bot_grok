const { isDeepStrictEqual } = require('node:util');
const { commandDefinitions } = require('./commandDefinitions');

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

function projectToDefinition(actual, definition) {
  if (Array.isArray(definition)) {
    if (!Array.isArray(actual)) return actual;
    return definition.map((expected, index) => projectToDefinition(actual[index], expected));
  }
  if (definition && typeof definition === 'object') {
    const projected = {};
    for (const [key, value] of Object.entries(definition)) {
      projected[key] = projectToDefinition(actual?.[key], value);
    }
    return projected;
  }
  return actual;
}

function commandMatchesDefinition(actual, definition) {
  const expected = normalizeCommandDefinition(definition);
  const projected = projectToDefinition(normalizeCommandDefinition(actual), expected);
  return isDeepStrictEqual(projected, expected);
}

function toCommandArray(existingCommands) {
  if (!existingCommands) return [];
  if (Array.isArray(existingCommands)) return existingCommands;
  if (typeof existingCommands.values === 'function') return [...existingCommands.values()];
  return [];
}

async function upsertOwnedCommands(upsert, definitions = commandDefinitions, existingCommands = []) {
  if (typeof upsert !== 'function') {
    throw new TypeError('command upsert function is required');
  }

  const existingByName = new Map(
    toCommandArray(existingCommands).map((command) => [
      command.name,
      typeof command.toJSON === 'function' ? command.toJSON() : command,
    ]),
  );
  const results = [];
  for (const definition of definitions) {
    const existing = existingByName.get(definition.name);
    if (existing && commandMatchesDefinition(existing, definition)) {
      results.push(existing);
    } else {
      results.push(await upsert(definition));
    }
  }
  return results;
}

async function upsertOwnedCommandsWithRest(rest, route, definitions = commandDefinitions) {
  if (!rest || typeof rest.post !== 'function' || !route) {
    throw new TypeError('Discord REST client and application-command route are required');
  }

  const existing = typeof rest.get === 'function' ? await rest.get(route) : [];
  return upsertOwnedCommands(
    (definition) => rest.post(route, { body: definition }),
    definitions,
    existing,
  );
}

module.exports = {
  commandMatchesDefinition,
  normalizeCommandDefinition,
  projectToDefinition,
  upsertOwnedCommands,
  upsertOwnedCommandsWithRest,
};
