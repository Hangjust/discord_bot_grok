const DEFAULT_MAX_RESPONSE_SENTENCES = 3;

function allowsExtendedResponses(effectiveBehavior) {
  const prompt = String(effectiveBehavior || '').trim();
  if (!prompt) return false;

  return [
    /\b(?:allow(?:ed)?|permit(?:ted)?|may|can)\b[^.\n]{0,120}\b(?:more than|over|longer than|exceed(?:ing)?)\s+(?:3|three)\s+sentences\b/iu,
    /\b(?:no|without an?)\s+(?:3|three)[ -]sentence\s+limit\b/iu,
    /\b(?:unlimited|unrestricted)\s+(?:response length|sentences?)\b/iu,
    /\bsentence\s+limit\s+(?:does not|doesn't|must not|should not)\s+apply\b/iu,
  ].some((pattern) => pattern.test(prompt));
}

function segmentSentences(content) {
  const text = String(content || '').trim();
  if (!text) return [];

  if (typeof Intl?.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    return [...segmenter.segment(text)]
      .map(({ segment }) => segment.trim())
      .filter(Boolean);
  }

  return text.match(/[^.!?]+(?:[.!?]+|$)/gs)?.map((sentence) => sentence.trim()).filter(Boolean)
    || [];
}

function compactAiResponse(
  content,
  effectiveBehavior = null,
  maxSentences = DEFAULT_MAX_RESPONSE_SENTENCES,
) {
  const text = String(content || '').trim();
  if (!text || allowsExtendedResponses(effectiveBehavior)) return text;

  const limit = Number.isSafeInteger(maxSentences) && maxSentences > 0
    ? maxSentences
    : DEFAULT_MAX_RESPONSE_SENTENCES;
  const sentences = segmentSentences(text);
  return sentences.length > limit ? sentences.slice(0, limit).join(' ') : text;
}

module.exports = {
  DEFAULT_MAX_RESPONSE_SENTENCES,
  allowsExtendedResponses,
  compactAiResponse,
  segmentSentences,
};
