const STRICT_PROFANITY_TERMS = Object.freeze([
  'arse',
  'ass',
  'asshole',
  'bastard',
  'bitch',
  'bullshit',
  'cock',
  'crap',
  'cunt',
  'damn',
  'dick',
  'dickhead',
  'fuck',
  'fucked',
  'fucker',
  'fucking',
  'goddamn',
  'motherfucker',
  'piss',
  'prick',
  'shit',
  'shitty',
  'twat',
  'wanker',
]);

const PROTECTED_CLASS_SLUR_TERMS = Object.freeze([
  'beaner',
  'chink',
  'coon',
  'cripple',
  'dyke',
  'fag',
  'faggot',
  'gook',
  'gypsy',
  'heeb',
  'homo',
  'injun',
  'jap',
  'kike',
  'kraut',
  'nigga',
  'nigger',
  'paki',
  'raghead',
  'redskin',
  'retard',
  'retarded',
  'shemale',
  'spic',
  'tranny',
  'towelhead',
  'wetback',
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildWholeWordExpression(terms) {
  const alternatives = [...new Set(terms)]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|');

  // JavaScript's \b is ASCII-centric and treats underscores as word characters.
  // Explicit Unicode letter/number guards prevent substring redaction in names,
  // ordinary words, and non-English text.
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`,
    'giu',
  );
}

const STRICT_EXPRESSION = buildWholeWordExpression([
  ...STRICT_PROFANITY_TERMS,
  ...PROTECTED_CLASS_SLUR_TERMS,
]);
const PROTECTED_CLASS_EXPRESSION = buildWholeWordExpression(PROTECTED_CLASS_SLUR_TERMS);

function enforceLanguagePolicy(text, profanityMode = 'strict') {
  const source = String(text ?? '');
  const normalizedMode = String(profanityMode ?? '').trim().toLowerCase();
  const expression = normalizedMode === 'casual' || normalizedMode === 'unfiltered'
    ? PROTECTED_CLASS_EXPRESSION
    : STRICT_EXPRESSION;

  return source.replace(expression, '[redacted]');
}

module.exports = {
  enforceLanguagePolicy,
};
