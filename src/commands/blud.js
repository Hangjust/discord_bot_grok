function isBludCommand(content) {
  return /^!blud(?:\s|$)/i.test(String(content).trim());
}

function getBludCommandText(content) {
  return String(content)
    .trim()
    .replace(/^!blud\b[?!.:,;\s-]*/i, '')
    .trim();
}

function parseBludCommand(content) {
  const text = getBludCommandText(content);
  const lower = text.toLowerCase().trim();

  if (!text) {
    return { action: 'activate', text: '' };
  }

  if (lower === 'off' || lower === 'stop' || lower === 'deactivate') {
    return { action: 'deactivate', text: '' };
  }

  if (lower === 'on' || lower === 'activate') {
    return { action: 'activate', text: '' };
  }

  return { action: 'translate', text };
}

function getBludUsageMessage() {
  return 'Usage: `!blud <text>` or `!blud` to activate, `!blud off` to deactivate';
}

function translateToBludMode(text) {
  let t = String(text).trim();
  if (!t) return '';

  // Heavy stereotypical AAVE / "blud" flavor as requested - exaggerated for the bit
  const wordMap = new Map([
    ['hello', 'whasgud'],
    ['hi', 'whasgud'],
    ['hey', 'ay'],
    ['how are you', 'how u be'],
    ['how u doing', 'how u movin'],
    ['guys', 'gng'],
    ['people', 'gng'],
    ['friends', 'gng'],
    ['brother', 'blud'],
    ['bro', 'blud'],
    ['man', 'dawg'],
    ['dude', 'blud'],
    ['yes', 'ong'],
    ['yeah', 'ong'],
    ['no', 'nah'],
    ['really', 'fr'],
    ['for real', 'fr fr'],
    ["what's up", 'wsg'],
    ['whats up', 'wsg'],
    ['what up', 'wsg'],
    ['what are you doing', 'wya'],
    ['where are you', 'wya'],
    ['good', 'fire'],
    ['bad', 'mid'],
    ['cool', 'valid'],
    ['crazy', 'wild'],
    ['thank you', 'preciate it'],
    ['thanks', 'preciate'],
    ['please', 'cmon now'],
  ]);

  // Tokenize similar to goblin mode
  const tokens = t.match(/\s+|[A-Za-z']+|[^A-Za-z'\s]+/g) ?? [];
  let result = '';
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    if (/^\s+$/.test(token)) {
      result += token;
      i++;
      continue;
    }

    if (/^[A-Za-z']+$/.test(token)) {
      const lower = token.toLowerCase();
      let replacement = token;

      // Check multi-word first (greedy)
      const twoWord = (lower + ' ' + (tokens[i+1] || '').toLowerCase()).trim();
      if (wordMap.has(twoWord)) {
        replacement = wordMap.get(twoWord);
        // skip next token if we consumed it
        if (tokens[i+1] && /^\s+$/.test(tokens[i+1])) i++;
        if (tokens[i+1]) i++;
      } else if (wordMap.has(lower)) {
        replacement = wordMap.get(lower);
      } else if (lower.length > 5 && (lower.length % 3 === 0)) {
        // light deterministic flavor on some longer words
        if (!/[aeiouy]$/i.test(lower)) replacement = token + 'ah';
      }

      // preserve some case
      if (token === token.toUpperCase()) {
        replacement = replacement.toUpperCase();
      } else if (token[0] === token[0].toUpperCase()) {
        replacement = replacement[0].toUpperCase() + replacement.slice(1);
      }

      result += replacement;
      i++;
      continue;
    }

    result += token;
    i++;
  }

  // Add stereotypical closer if it doesn't end with punctuation
  const trimmed = result.trim();
  if (trimmed && !/[.!?]$/.test(trimmed)) {
    result += ' ... no cap';
  }

  return result;
}

module.exports = {
  getBludCommandText,
  getBludUsageMessage,
  isBludCommand,
  parseBludCommand,
  translateToBludMode,
};
