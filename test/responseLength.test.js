const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_MAX_RESPONSE_SENTENCES,
  allowsExtendedResponses,
  compactAiResponse,
  segmentSentences,
} = require('../src/ai/responseLength');

test('AI responses are deterministically capped at three sentences by default', () => {
  const response = 'First answer. Second detail! Third point? Fourth ramble. Fifth closer.';

  assert.equal(DEFAULT_MAX_RESPONSE_SENTENCES, 3);
  assert.equal(segmentSentences(response).length, 5);
  assert.equal(
    compactAiResponse(response),
    'First answer. Second detail! Third point?',
  );
});

test('only an explicit administrator prompt can permit more than three sentences', () => {
  const response = 'One. Two. Three. Four. Five.';

  assert.equal(allowsExtendedResponses('Be friendly and detailed.'), false);
  assert.equal(allowsExtendedResponses('Users may ask for more detail.'), false);
  assert.equal(
    allowsExtendedResponses('The assistant is allowed to write way more than three sentences.'),
    true,
  );
  assert.equal(allowsExtendedResponses('There is no three-sentence limit.'), true);
  assert.equal(compactAiResponse(response, 'Be friendly and detailed.'), 'One. Two. Three.');
  assert.equal(
    compactAiResponse(response, 'The assistant may use more than 3 sentences.'),
    response,
  );
});

test('empty and already-compact responses remain unchanged', () => {
  assert.equal(compactAiResponse(''), '');
  assert.equal(compactAiResponse('Direct answer. One useful detail.'), 'Direct answer. One useful detail.');
});
