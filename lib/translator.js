const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-4-5';
const BATCH_SIZE = 40;

const SYSTEM_PROMPT = `You translate WhatsApp group chat messages into English.
Messages are mostly Romanian — often typed without diacritics, with slang, typos, and abbreviations — but any language may appear. Detect the language of each message yourself.
For each input message return:
- "id": the message id, copied exactly
- "lang": the ISO 639-1 code of the detected language ("ro", "en", "hu", ...)
- "translation": a natural, informal English translation that preserves tone and emoji — or null if the message is already English.
Translate meaning, not word-for-word. Keep names, links, and phone numbers unchanged. Return one entry per input message.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          lang: { type: 'string' },
          translation: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['id', 'lang', 'translation'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildRequest(items) {
  return {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: JSON.stringify({ messages: items.map(({ id, text }) => ({ id, text })) }),
      },
    ],
  };
}

function mapResponse(items, parsed) {
  const byId = {};
  for (const t of parsed.translations || []) {
    byId[t.id] = { lang: t.lang, translation: t.translation };
  }
  const result = {};
  for (const item of items) {
    result[item.id] = byId[item.id] || null; // null = skipped; caller must not cache
  }
  return result;
}

let client = null;

async function translateBatch(items) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — add it to .env and restart the server');
  }
  if (!client) client = new Anthropic();
  const results = {};
  for (const group of chunk(items, BATCH_SIZE)) {
    const response = await client.messages.create(buildRequest(group));
    const textBlock = response.content.find((b) => b.type === 'text');
    const parsed = JSON.parse(textBlock.text);
    Object.assign(results, mapResponse(group, parsed));
  }
  return results;
}

module.exports = { translateBatch, buildRequest, mapResponse, BATCH_SIZE };
