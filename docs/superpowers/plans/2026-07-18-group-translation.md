# WhatsApp Group Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Translate" view to WhatsAppAuto that shows selected WhatsApp groups' messages with English translations (auto-detected source language, mostly Romanian), translated on demand and cached permanently.

**Architecture:** Two new modules (`lib/translator.js` for batched Claude Haiku calls, `lib/translationCache.js` for per-group JSON caches), three new endpoints in `server.js`, and a new tab in the single-file frontend `public/index.html`. Polling (~4 s), no SSE. Spec: `docs/superpowers/specs/2026-07-18-group-translation-design.md`.

**Tech Stack:** Node 26 (built-in `node:test`), Express, whatsapp-web.js (already present), `@anthropic-ai/sdk` (new), `dotenv` (new).

## Global Constraints

- Translation model is exactly `claude-haiku-4-5` via the official `@anthropic-ai/sdk` — never raw `fetch` to the API, never another model.
- Use structured outputs (`output_config: { format: { type: "json_schema", schema } }`) so responses are guaranteed-valid JSON.
- API key comes from `.env` (`ANTHROPIC_API_KEY`), loaded with `dotenv`. `.env`, `translations/`, and `translate-groups.json` must be gitignored.
- Failed/skipped translations are **never cached** — they retry automatically on the next fetch.
- Every task ends with `git add <files> && git commit && git push` (user preference: auto-commit and push). Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- The existing scheduler behavior must not change. Do not touch existing endpoints or the scheduling UI logic beyond the explicit modifications listed.

---

### Task 1: Dependencies, env, gitignore

**Files:**
- Modify: `package.json` (via npm; also add `test` script)
- Create: `.env.example`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `@anthropic-ai/sdk` and `dotenv` installed; `npm test` runs `node --test test/`.

- [ ] **Step 1: Install dependencies**

Run: `npm install @anthropic-ai/sdk dotenv`
Expected: exits 0, both packages added to `package.json` dependencies.

- [ ] **Step 2: Add test script to package.json**

In `package.json`, change the `scripts` block to:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test test/"
  },
```

- [ ] **Step 3: Create `.env.example`**

```
# Anthropic API key for the Translate feature (https://console.anthropic.com)
ANTHROPIC_API_KEY=sk-ant-...
```

- [ ] **Step 4: Update `.gitignore`**

Append these lines to `.gitignore`:

```
.env
translations/
translate-groups.json
```

- [ ] **Step 5: Verify `.env` is ignored**

Run: `touch .env && git status --porcelain | grep -c "\.env$"` — expected output: `0` (only `.env.example` may appear).
Ask the user to put their real key in `.env` (`ANTHROPIC_API_KEY=...`) if they haven't; the server tolerates a missing key (Task 4) so this doesn't block later tasks.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .env.example .gitignore
git commit -m "Add translation dependencies, env template, and gitignore entries

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 2: Translator module (`lib/translator.js`)

**Files:**
- Create: `lib/translator.js`
- Test: `test/translator.test.js`

**Interfaces:**
- Produces:
  - `translateBatch(items)` — `items: Array<{id: string, text: string}>` → `Promise<{[id]: {lang: string, translation: string|null} | null}>`. `translation: null` means "already English". A `null` entry value means the model skipped that id (caller must not cache it). Throws on missing API key or API error.
  - `buildRequest(items)` (exported for tests) — pure; returns the `messages.create` params object.
  - `mapResponse(items, parsed)` (exported for tests) — pure; maps parsed model JSON to the result object.

- [ ] **Step 1: Write the failing tests**

Create `test/translator.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/translator'`.

- [ ] **Step 3: Write the implementation**

Create `lib/translator.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/translator.js test/translator.test.js
git commit -m "Add Claude Haiku batch translator with structured outputs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 3: Translation cache module (`lib/translationCache.js`)

**Files:**
- Create: `lib/translationCache.js`
- Test: `test/translationCache.test.js`

**Interfaces:**
- Produces: `createCache(dir)` → `{ get(groupId, msgId), setMany(groupId, entries) }`.
  - `get` returns the cached `{lang, translation}` entry or `null`.
  - `setMany(groupId, entries)` merges `entries` (`{[msgId]: {lang, translation}}`) and writes `<dir>/<sanitized-groupId>.json` synchronously.
  - Cache survives process restarts (lazy-loads the JSON file per group).

- [ ] **Step 1: Write the failing tests**

Create `test/translationCache.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCache } = require('../lib/translationCache');

test('setMany then get round-trips, and persists to a new cache instance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cache-'));
  const cache = createCache(dir);
  const groupId = '12036304@g.us';

  assert.strictEqual(cache.get(groupId, 'm1'), null);
  cache.setMany(groupId, { m1: { lang: 'ro', translation: 'hi' } });
  assert.deepStrictEqual(cache.get(groupId, 'm1'), { lang: 'ro', translation: 'hi' });

  // fresh instance reads the same file — permanence across restarts
  const cache2 = createCache(dir);
  assert.deepStrictEqual(cache2.get(groupId, 'm1'), { lang: 'ro', translation: 'hi' });
});

test('a corrupt cache file is treated as empty, not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cache-'));
  const cache = createCache(dir);
  cache.setMany('g1@g.us', { m1: { lang: 'ro', translation: 'x' } });
  const file = fs.readdirSync(dir)[0];
  fs.writeFileSync(path.join(dir, file), 'not json');
  const cache2 = createCache(dir);
  assert.strictEqual(cache2.get('g1@g.us', 'm1'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/translationCache'`.

- [ ] **Step 3: Write the implementation**

Create `lib/translationCache.js`:

```js
const fs = require('fs');
const path = require('path');

// Per-group persistent translation cache: <dir>/<groupId>.json keyed by message id.
function createCache(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const loaded = new Map(); // groupId -> { [msgId]: {lang, translation} }

  function fileFor(groupId) {
    return path.join(dir, `${groupId.replace(/[^a-zA-Z0-9@._-]/g, '_')}.json`);
  }

  function load(groupId) {
    if (loaded.has(groupId)) return loaded.get(groupId);
    let data = {};
    try {
      if (fs.existsSync(fileFor(groupId))) {
        data = JSON.parse(fs.readFileSync(fileFor(groupId), 'utf8'));
      }
    } catch (e) {
      console.error(`Corrupt translation cache for ${groupId}, starting fresh:`, e.message);
      data = {};
    }
    loaded.set(groupId, data);
    return data;
  }

  return {
    get(groupId, msgId) {
      return load(groupId)[msgId] || null;
    },
    setMany(groupId, entries) {
      const data = load(groupId);
      Object.assign(data, entries);
      try {
        fs.writeFileSync(fileFor(groupId), JSON.stringify(data));
      } catch (e) {
        console.error(`Failed to write translation cache for ${groupId}:`, e.message);
      }
    },
  };
}

module.exports = { createCache };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (4 tests total).

- [ ] **Step 5: Commit**

```bash
git add lib/translationCache.js test/translationCache.test.js
git commit -m "Add per-group persistent translation cache

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 4: Server endpoints (`server.js`)

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `translateBatch` (Task 2), `createCache` (Task 3), existing `client`, `contacts`, `waStatus`, `cancelAutoShutdown()`.
- Produces HTTP endpoints:
  - `GET /api/translate/groups` → `[{id, name}]`
  - `POST /api/translate/groups` body `{groups: [{id, name}]}` (full replacement) → `{success: true}`
  - `GET /api/translate/messages?groupId=<id>&limit=<n>` → `{messages: [{id, senderName, timestamp, type, fromMe, body, lang, translation, translated}], translationError: string|null}` — `timestamp` in ms, sorted ascending; `translation` null for English/media-only/failed; `translated` false only when a text message has no cache entry (failed → UI shows retry state).

- [ ] **Step 1: Load dotenv and new modules**

At the very top of `server.js` (line 1, before all other requires) add:

```js
require('dotenv').config();
```

And immediately after it, the startup warning required by the spec:

```js
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('⚠ ANTHROPIC_API_KEY not set — the Translate feature will return errors until you add it to .env');
}
```

After the existing `const multer = require('multer');` line add:

```js
const { translateBatch } = require('./lib/translator');
const { createCache } = require('./lib/translationCache');
```

- [ ] **Step 2: Add translation state**

After the `const CONTACTS_FILE = path.join(__dirname, 'contacts.json');` line add:

```js
const TRANSLATE_GROUPS_FILE = path.join(__dirname, 'translate-groups.json');
const translationCache = createCache(path.join(__dirname, 'translations'));

function loadTranslateGroups() {
  try {
    if (fs.existsSync(TRANSLATE_GROUPS_FILE)) {
      return JSON.parse(fs.readFileSync(TRANSLATE_GROUPS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load translate groups:', e.message);
  }
  return [];
}

function saveTranslateGroups(groups) {
  try {
    fs.writeFileSync(TRANSLATE_GROUPS_FILE, JSON.stringify(groups, null, 2));
  } catch (e) {
    console.error('Failed to save translate groups:', e.message);
  }
}

// Resolve a group message's author to a display name via the contact cache.
function resolveSenderName(msg) {
  if (msg.fromMe) return 'You';
  const authorId = msg.author || msg.from;
  const contact = contacts.find((c) => (c.id?._serialized ?? c.id) === authorId);
  if (contact && (contact.name || contact.pushname)) return contact.name || contact.pushname;
  return String(authorId).split('@')[0];
}
```

- [ ] **Step 3: Add the endpoints**

In the `── API Routes ──` section, after the `/api/download-images` route, add:

```js
app.get('/api/translate/groups', (_req, res) => {
  res.json(loadTranslateGroups());
});

app.post('/api/translate/groups', (req, res) => {
  const { groups } = req.body;
  if (!Array.isArray(groups) || groups.some((g) => !g.id || !g.name)) {
    return res.status(400).json({ error: 'groups must be an array of {id, name}' });
  }
  saveTranslateGroups(groups.map(({ id, name }) => ({ id, name })));
  res.json({ success: true });
});

app.get('/api/translate/messages', async (req, res) => {
  const { groupId } = req.query;
  const limit = Math.min(Number(req.query.limit) || 50, 1000);

  if (!groupId) return res.status(400).json({ error: 'Missing groupId' });
  if (waStatus !== 'connected') return res.status(400).json({ error: 'WhatsApp not connected' });

  cancelAutoShutdown(); // user is actively reading — don't exit under them

  try {
    const chat = await client.getChatById(groupId);
    const fetched = await chat.fetchMessages({ limit });

    const items = fetched.map((msg) => ({
      id: msg.id.id,
      senderName: resolveSenderName(msg),
      timestamp: msg.timestamp * 1000,
      type: msg.type, // 'chat' for text; 'image', 'ptt', 'document', 'sticker', ... for media
      fromMe: !!msg.fromMe,
      body: msg.body || '', // for media messages this is the caption
    }));

    const toTranslate = items.filter(
      (m) => m.body.trim() && !translationCache.get(groupId, m.id)
    );

    let translationError = null;
    if (toTranslate.length > 0) {
      try {
        const results = await translateBatch(
          toTranslate.map(({ id, body }) => ({ id, text: body }))
        );
        const entries = {};
        for (const [id, r] of Object.entries(results)) {
          if (r) entries[id] = r; // skipped ids stay uncached and retry next fetch
        }
        translationCache.setMany(groupId, entries);
      } catch (err) {
        console.error('Translation failed:', err.message);
        translationError = err.message;
      }
    }

    const messages = items
      .map((m) => {
        const cached = m.body.trim() ? translationCache.get(groupId, m.id) : null;
        return {
          ...m,
          lang: cached ? cached.lang : null,
          translation: cached ? cached.translation : null,
          translated: !!cached,
        };
      })
      .sort((a, b) => a.timestamp - b.timestamp);

    res.json({ messages, translationError });
  } catch (err) {
    console.error('Error fetching translate feed:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch messages' });
  }
});
```

- [ ] **Step 4: Verify — unit tests still pass and server boots**

Run: `npm test`
Expected: PASS (4 tests).

Run: `node --check server.js`
Expected: no output, exit 0.

- [ ] **Step 5: Verify against the live server**

Restart the daemon: `./start.sh`, wait for `connected` (check `curl -s localhost:3000/api/status`). Then:

```bash
curl -s -X POST localhost:3000/api/translate/groups -H 'Content-Type: application/json' \
  -d '{"groups":[{"id":"test@g.us","name":"Test"}]}'
# → {"success":true}
curl -s localhost:3000/api/translate/groups
# → [{"id":"test@g.us","name":"Test"}]
```

Pick a real group id from `curl -s 'localhost:3000/api/contacts?q=' | python3 -m json.tool` (an entry with `"isGroup": true`), then:

```bash
curl -s 'localhost:3000/api/translate/messages?groupId=<REAL_GROUP_ID>&limit=5' | python3 -m json.tool
```

Expected: `messages` array with `senderName`, `body`, and (with a valid API key in `.env`) `lang`/`translation` populated for non-empty bodies. Without a key: same array with `translated: false` and a descriptive `translationError` — not a 500. Re-run the same curl: second response must be instant (cache hit, no new API call — verify no new "Translation failed" or Anthropic latency).

Finally clear the test group list:

```bash
curl -s -X POST localhost:3000/api/translate/groups -H 'Content-Type: application/json' -d '{"groups":[]}'
```

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "Add translate endpoints: group list and on-demand translated feed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 5: Frontend Translate view (`public/index.html`)

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `GET/POST /api/translate/groups`, `GET /api/translate/messages` (Task 4 shapes), existing `/api/contacts` (`isGroup` flag), existing helpers `escapeHtml`, `formatDateTime`.
- Produces: a tab bar (Scheduler | Translate); Translate view with group picker, saved-group chips, chat feed with translations, scroll-up history loading, 4 s polling while open.

- [ ] **Step 1: Add tab styles**

In the `<style>` block, after the `.hidden` rule (`.hidden { display: none !important; }`), add:

```css
    /* Tabs */
    .tabs {
      max-width: 680px;
      margin: 16px auto -8px;
      padding: 0 16px;
      display: flex;
      gap: 8px;
    }
    .tab {
      flex: 1;
      padding: 10px;
      border: none;
      border-radius: 8px;
      background: #e4e6e9;
      color: #555;
      font-size: .95rem;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    .tab.active { background: #075e54; color: white; }

    /* Translate view */
    .group-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #e3f2fd;
      color: #1565c0;
      border: 1px solid transparent;
      border-radius: 16px;
      padding: 5px 12px;
      font-size: .85rem;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    .group-chip.active { background: #075e54; color: white; }
    .group-chip .chip-remove { color: inherit; opacity: .6; font-size: 1rem; line-height: 1; }
    .group-chip .chip-remove:hover { opacity: 1; }
    #group-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }

    #feed {
      height: 60vh;
      overflow-y: auto;
      background: #efe7dd;
      border-radius: 8px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .bubble {
      background: white;
      border-radius: 8px;
      padding: 8px 12px;
      max-width: 85%;
      align-self: flex-start;
      box-shadow: 0 1px 1px rgba(0,0,0,.08);
    }
    .bubble.from-me { background: #d9fdd3; align-self: flex-end; }
    .bubble-sender { font-size: .78rem; font-weight: 700; color: #075e54; margin-bottom: 2px; }
    .bubble-translation { font-size: .92rem; color: #1c1e21; white-space: pre-wrap; word-break: break-word; }
    .bubble-original { font-size: .8rem; color: #999; margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
    .bubble-meta { font-size: .7rem; color: #aaa; margin-top: 4px; text-align: right; }
    .lang-badge {
      font-size: .65rem;
      font-weight: 700;
      background: #eee;
      color: #777;
      padding: 1px 5px;
      border-radius: 6px;
      margin-left: 6px;
      text-transform: uppercase;
    }
    .bubble-media { font-size: .85rem; color: #888; font-style: italic; }
    .bubble-failed { font-size: .8rem; color: #c62828; }
    #feed-loading { text-align: center; color: #888; font-size: .8rem; padding: 6px; }
    #translate-error {
      background: #fce4ec; color: #c62828; border-radius: 8px;
      padding: 10px 14px; font-size: .85rem; margin-bottom: 12px;
    }
```

- [ ] **Step 2: Add the tab bar and Translate view markup**

Immediately after `</header>` and before `<main>`, add:

```html
<nav class="tabs hidden" id="tab-bar">
  <button class="tab active" data-tab="scheduler">Scheduler</button>
  <button class="tab" data-tab="translate">Translate</button>
</nav>
```

Inside `<main>`, after the Download Images card (`</div>` that closes `#download-card`), add:

```html
  <!-- Translate: group picker -->
  <div class="card hidden" id="translate-groups-card">
    <h2>Translate Groups</h2>
    <div class="form-group">
      <label for="group-search-input">Add a group</label>
      <div class="contact-wrapper">
        <input type="text" id="group-search-input" placeholder="Click to browse or type to search groups…" autocomplete="off">
        <div id="group-search-dropdown" style="position:absolute;top:calc(100% + 4px);left:0;right:0;background:white;border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.1);z-index:100;max-height:220px;overflow-y:auto;display:none;"></div>
      </div>
    </div>
    <div id="group-chips"></div>
  </div>

  <!-- Translate: feed -->
  <div class="card hidden" id="translate-feed-card">
    <h2 id="feed-title">Messages</h2>
    <div id="translate-error" class="hidden"></div>
    <div id="feed">
      <div id="feed-loading" class="hidden">Loading older messages…</div>
    </div>
  </div>
```

- [ ] **Step 3: Add the Translate view JavaScript**

In the `<script>` block, add to the `── State ──` section:

```js
  let activeTab = 'scheduler';
  let translateGroups = [];        // saved [{id, name}]
  let activeGroup = null;          // currently viewed {id, name}
  let feedLimit = 50;
  let feedPollInterval = null;
  let feedMessages = [];
  let feedFetchInFlight = false;
```

Then, before the `── Init ──` section, add:

```js
  // ── Tabs ──────────────────────────────────────────────────────────────────
  const tabBar = document.getElementById('tab-bar');

  tabBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn || btn.dataset.tab === activeTab) return;
    activeTab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.tab === activeTab));
    applyTabVisibility();
    if (activeTab === 'translate') {
      loadTranslateGroups();
      startFeedPolling();
    } else {
      stopFeedPolling();
    }
  });

  function applyTabVisibility() {
    const connected = waStatus === 'connected';
    tabBar.classList.toggle('hidden', !connected);
    // Scheduler cards
    document.getElementById('compose-card').classList.toggle('hidden', !connected || activeTab !== 'scheduler');
    document.getElementById('download-card').classList.toggle('hidden', !connected || activeTab !== 'scheduler');
    // list-card visibility is handled by renderScheduled(), but hide it off-tab:
    if (activeTab !== 'scheduler') document.getElementById('list-card').classList.add('hidden');
    // Translate cards
    document.getElementById('translate-groups-card').classList.toggle('hidden', !connected || activeTab !== 'translate');
    document.getElementById('translate-feed-card').classList.toggle('hidden', !connected || activeTab !== 'translate' || !activeGroup);
  }

  // ── Translate: saved groups ───────────────────────────────────────────────
  async function loadTranslateGroups() {
    try {
      const res = await fetch('/api/translate/groups');
      translateGroups = await res.json();
      renderGroupChips();
    } catch (_) { /* server may be restarting */ }
  }

  async function saveTranslateGroupsToServer() {
    try {
      await fetch('/api/translate/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups: translateGroups }),
      });
    } catch (_) { alert('Failed to save group list'); }
  }

  function renderGroupChips() {
    const el = document.getElementById('group-chips');
    if (translateGroups.length === 0) {
      el.innerHTML = '<div class="empty-state" style="padding:12px;width:100%;">No groups yet — search above to add one.</div>';
      return;
    }
    el.innerHTML = translateGroups.map((g) => `
      <button class="group-chip ${activeGroup && activeGroup.id === g.id ? 'active' : ''}" data-group-id="${escapeHtml(g.id)}">
        ${escapeHtml(g.name)}
        <span class="chip-remove" data-remove-id="${escapeHtml(g.id)}" title="Remove">&times;</span>
      </button>
    `).join('');
  }

  document.getElementById('group-chips').addEventListener('click', (e) => {
    const removeEl = e.target.closest('[data-remove-id]');
    if (removeEl) {
      e.stopPropagation();
      const id = removeEl.dataset.removeId;
      translateGroups = translateGroups.filter((g) => g.id !== id);
      if (activeGroup && activeGroup.id === id) { activeGroup = null; feedMessages = []; }
      saveTranslateGroupsToServer();
      renderGroupChips();
      applyTabVisibility();
      return;
    }
    const chip = e.target.closest('[data-group-id]');
    if (!chip) return;
    const group = translateGroups.find((g) => g.id === chip.dataset.groupId);
    if (group) openGroupFeed(group);
  });

  // ── Translate: group search ───────────────────────────────────────────────
  const groupSearchInput = document.getElementById('group-search-input');
  const groupSearchDropdown = document.getElementById('group-search-dropdown');
  let groupSearchTimeout = null;

  groupSearchInput.addEventListener('focus', () => searchGroups(groupSearchInput.value.trim()));
  groupSearchInput.addEventListener('input', () => {
    clearTimeout(groupSearchTimeout);
    groupSearchTimeout = setTimeout(() => searchGroups(groupSearchInput.value.trim()), 200);
  });

  async function searchGroups(q) {
    try {
      const res = await fetch(`/api/contacts?q=${encodeURIComponent(q)}`);
      const groups = (await res.json()).filter((c) => c.isGroup);
      if (groups.length === 0) { groupSearchDropdown.style.display = 'none'; return; }
      groupSearchDropdown.innerHTML = groups.map((g) => `
        <div class="contact-item" data-id="${escapeHtml(g.id)}" data-name="${escapeHtml(g.name)}">
          <div class="contact-name">${escapeHtml(g.name)} <span class="group-tag">group</span></div>
        </div>
      `).join('');
      groupSearchDropdown.style.display = 'block';
    } catch (_) { groupSearchDropdown.style.display = 'none'; }
  }

  groupSearchDropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.contact-item');
    if (!item) return;
    groupSearchDropdown.style.display = 'none';
    groupSearchInput.value = '';
    if (!translateGroups.some((g) => g.id === item.dataset.id)) {
      translateGroups.push({ id: item.dataset.id, name: item.dataset.name });
      saveTranslateGroupsToServer();
      renderGroupChips();
    }
    openGroupFeed(translateGroups.find((g) => g.id === item.dataset.id));
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#translate-groups-card .contact-wrapper')) groupSearchDropdown.style.display = 'none';
  });

  // ── Translate: feed ───────────────────────────────────────────────────────
  function openGroupFeed(group) {
    activeGroup = group;
    feedLimit = 50;
    feedMessages = [];
    document.getElementById('feed-title').textContent = group.name;
    renderGroupChips();
    applyTabVisibility();
    renderFeed(true);
    fetchFeed({ scrollToBottom: true });
  }

  async function fetchFeed({ scrollToBottom = false, keepScroll = false } = {}) {
    if (!activeGroup || feedFetchInFlight) return;
    feedFetchInFlight = true;
    const feedEl = document.getElementById('feed');
    const prevHeight = feedEl.scrollHeight;
    try {
      const res = await fetch(`/api/translate/messages?groupId=${encodeURIComponent(activeGroup.id)}&limit=${feedLimit}`);
      const data = await res.json();
      const errEl = document.getElementById('translate-error');
      if (!res.ok) {
        errEl.textContent = data.error || 'Failed to load messages';
        errEl.classList.remove('hidden');
        return;
      }
      errEl.classList.toggle('hidden', !data.translationError);
      if (data.translationError) errEl.textContent = `Translation failed (will retry): ${data.translationError}`;
      feedMessages = data.messages;
      renderFeed();
      if (scrollToBottom) feedEl.scrollTop = feedEl.scrollHeight;
      if (keepScroll) feedEl.scrollTop = feedEl.scrollHeight - prevHeight; // keep viewport anchored after prepending history
    } catch (_) {
      // transient network error — next poll retries
    } finally {
      feedFetchInFlight = false;
      document.getElementById('feed-loading').classList.add('hidden');
    }
  }

  function mediaLabel(type) {
    const labels = { image: '📷 photo', video: '🎥 video', ptt: '🎤 voice message', audio: '🎵 audio', document: '📄 document', sticker: '🩵 sticker', location: '📍 location', vcard: '👤 contact card' };
    return labels[type] || `[${type}]`;
  }

  function renderFeed(loadingOnly = false) {
    const feedEl = document.getElementById('feed');
    const loading = '<div id="feed-loading" class="hidden">Loading older messages…</div>';
    if (loadingOnly) { feedEl.innerHTML = loading + '<div class="empty-state">Loading…</div>'; return; }
    feedEl.innerHTML = loading + feedMessages.map((m) => {
      const hasText = m.body && m.body.trim();
      const isMedia = m.type !== 'chat';
      let content = '';
      if (isMedia) content += `<div class="bubble-media">${escapeHtml(mediaLabel(m.type))}</div>`;
      if (hasText) {
        if (m.translated && m.translation !== null) {
          content += `<div class="bubble-translation">${escapeHtml(m.translation)}</div>`;
          content += `<div class="bubble-original">${escapeHtml(m.body)}</div>`;
        } else if (m.translated) {
          // already English
          content += `<div class="bubble-translation">${escapeHtml(m.body)}<span class="lang-badge">EN</span></div>`;
        } else {
          content += `<div class="bubble-translation">${escapeHtml(m.body)}</div>`;
          content += `<div class="bubble-failed">translation pending — retrying…</div>`;
        }
      }
      return `
        <div class="bubble ${m.fromMe ? 'from-me' : ''}">
          <div class="bubble-sender">${escapeHtml(m.senderName)}</div>
          ${content}
          <div class="bubble-meta">${escapeHtml(formatDateTime(m.timestamp))}${m.lang && m.translation !== null ? `<span class="lang-badge">${escapeHtml(m.lang)}</span>` : ''}</div>
        </div>
      `;
    }).join('');
  }

  // Scroll-up → load more history (fetchMessages only supports "latest N", so grow the limit)
  document.getElementById('feed').addEventListener('scroll', (e) => {
    if (e.target.scrollTop === 0 && activeGroup && !feedFetchInFlight && feedMessages.length >= feedLimit) {
      feedLimit += 100;
      document.getElementById('feed-loading').classList.remove('hidden');
      fetchFeed({ keepScroll: true });
    }
  });

  function startFeedPolling() {
    if (feedPollInterval) return;
    feedPollInterval = setInterval(() => {
      if (activeTab === 'translate' && activeGroup && waStatus === 'connected') fetchFeed();
    }, 4000);
  }

  function stopFeedPolling() {
    if (feedPollInterval) { clearInterval(feedPollInterval); feedPollInterval = null; }
  }
```

- [ ] **Step 4: Wire tab visibility into the existing status logic**

In `updateStatus(status)`, replace these two lines:

```js
    composeCard.classList.toggle('hidden', waStatus !== 'connected');
    document.getElementById('download-card').classList.toggle('hidden', waStatus !== 'connected');
```

with:

```js
    applyTabVisibility();
```

And in `renderScheduled()`, change the guard so the list never shows on the Translate tab:

```js
    if (waStatus !== 'connected' || activeTab !== 'scheduler' || scheduledMessages.length === 0) {
```

- [ ] **Step 5: Verify in the browser**

Restart (`./start.sh`), open `http://localhost:3000`, and check:

1. Scheduler tab looks and works exactly as before (compose, list, download visible when connected).
2. Translate tab: search finds only groups; selecting one adds a chip and opens the feed.
3. Feed shows sender names, English translations with dim originals, `EN` badge on English messages, media placeholders.
4. Reopening the same group is instant (cache hit — watch server log for absence of new API traffic).
5. Scroll to the top of the feed → older messages load, viewport doesn't jump.
6. Send a Romanian test message to the group from your phone → appears translated within ~4–8 s.
7. Remove chip works; reload page → saved groups persist.

If any check fails, fix before committing.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "Add Translate tab: group picker, translated chat feed, scroll-up history

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 6: End-to-end verification and knowledge capture

**Files:**
- None (verification + KB writes)

- [ ] **Step 1: Full-flow check with the real API key**

With `ANTHROPIC_API_KEY` set in `.env` and the server freshly restarted, run through the Task 5 browser checklist once more end-to-end on a real Romanian group. Confirm `translations/<groupId>.json` exists and grows, and that a second server restart still serves cached translations without new API calls.

- [ ] **Step 2: Failure-path check**

Temporarily rename `.env` → `.env.bak`, restart, open a group feed: originals must display with the "translation pending" state and the red banner naming the missing key — no crash, no 500 rendering failure. Restore `.env` and restart.

- [ ] **Step 3: Save KB learnings**

```bash
python3 .kb/kb.py learn "translate feature implementation | Translate tab lives in public/index.html behind a tab bar; endpoints /api/translate/groups + /api/translate/messages in server.js; lib/translator.js (claude-haiku-4-5, structured outputs, batches of 40) + lib/translationCache.js (translations/<groupId>.json). Failed translations are never cached so they self-retry. npm test runs node --test test/ | translation architecture"
```

- [ ] **Step 4: Final commit if anything changed, then push**

```bash
git status --porcelain   # commit any stragglers with an appropriate message, then:
git push
```
