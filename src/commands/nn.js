function isNnCommand(content) {
  return /^!nn(?:\s|$)/i.test(String(content).trim());
}

function getNnCommandText(content) {
  return String(content)
    .trim()
    .replace(/^!nn\b[?!.:,;\s-]*/i, '')
    .trim();
}

function getNnUsageMessage() {
  return 'Usage: `!nn <text>` or reply to a message with `!nn`.';
}

function preserveWordCase(sourceWord, targetWord) {
  if (sourceWord === sourceWord.toUpperCase()) {
    return targetWord.toUpperCase();
  }

  if (sourceWord[0] === sourceWord[0]?.toUpperCase()) {
    return targetWord[0].toUpperCase() + targetWord.slice(1);
  }

  return targetWord;
}

function goblinizeWord(word, index) {
  const lowerWord = word.toLowerCase();
  const replacements = new Map([
    ['hello', 'hehlo'],
    ['hi', 'hii'],
    ['hey', 'heyy'],
    ['there', 'dere'],
    ['friend', 'fren'],
    ['please', 'pleeze'],
    ['thanks', 'tankies'],
    ['thank', 'tank'],
    ['yes', 'ya'],
    ['no', 'nah'],
    ['not', 'naht'],
    ['your', 'yer'],
    ['you', 'yoo'],
    ['my', 'me'],
    ['me', 'me'],
    ['the', 'da'],
    ['this', 'dis'],
    ['that', 'dat'],
    ['to', 'ta'],
    ['for', 'fer'],
    ['with', 'wiv'],
    ['and', 'an'],
    ['are', 'be'],
    ['is', 'iz'],
    ['was', 'waz'],
    ['want', 'wants'],
    ['need', 'needs'],
  ]);

  if (replacements.has(lowerWord)) {
    return preserveWordCase(word, replacements.get(lowerWord));
  }

  if (!/^[a-z]+$/i.test(word) || word.length <= 3) {
    return word;
  }

  if (index % 2 === 0) {
    return `${word[0]}-${word}`;
  }

  return word;
}

function translateToGoblinMode(text) {
  const trimmedText = String(text).trim();

  if (!trimmedText) {
    return '';
  }

  const tokens = trimmedText.match(/\s+|[A-Za-z']+|[^A-Za-z'\s]+/g) ?? [];
  let wordIndex = 0;

  const translated = tokens.map((token) => {
    if (/^\s+$/.test(token)) {
      return token;
    }

    if (/^[A-Za-z']+$/.test(token)) {
      const translatedWord = goblinizeWord(token, wordIndex);
      wordIndex += 1;
      return translatedWord;
    }

    return token;
  }).join('');

  return `${translated}${translated.endsWith('!') || translated.endsWith('?') || translated.endsWith('.') ? '' : '...'} snrk`;
}

module.exports = {
  getNnCommandText,
  getNnUsageMessage,
  isNnCommand,
  translateToGoblinMode,
};
