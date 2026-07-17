const { test } = require('node:test');
const assert = require('node:assert');
const { buildRequest, mapResponse } = require('../lib/translator');

test('buildRequest targets claude-haiku-4-5 with structured output and all items', () => {
  const req = buildRequest([{ id: 'a1', text: 'salut' }, { id: 'b2', text: 'ce faci?' }]);
  assert.strictEqual(req.model, 'claude-haiku-4-5');
  assert.strictEqual(req.output_config.format.type, 'json_schema');
  const payload = JSON.parse(req.messages[0].content);
  assert.deepStrictEqual(payload.messages, [
    { id: 'a1', text: 'salut' },
    { id: 'b2', text: 'ce faci?' },
  ]);
});

test('mapResponse maps translations by id and flags skipped ids as null', () => {
  const items = [{ id: 'a1', text: 'salut' }, { id: 'b2', text: 'hello' }, { id: 'c3', text: 'x' }];
  const parsed = { translations: [
    { id: 'a1', lang: 'ro', translation: 'hi' },
    { id: 'b2', lang: 'en', translation: null },
  ] };
  const result = mapResponse(items, parsed);
  assert.deepStrictEqual(result.a1, { lang: 'ro', translation: 'hi' });
  assert.deepStrictEqual(result.b2, { lang: 'en', translation: null });
  assert.strictEqual(result.c3, null); // skipped by model — must not be cached
});
