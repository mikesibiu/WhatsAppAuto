# WhatsApp Group Translation — Design

**Date:** 2026-07-18
**Status:** Approved

## Purpose

Let the user pick WhatsApp groups and read their messages in English in the
browser. Messages are mostly Romanian, but language is auto-detected, so any
non-English message gets translated. Read-only: nothing is posted back into
WhatsApp; other group members see nothing.

## Decisions (settled with user)

- **Extend WhatsAppAuto** — new "Translate" view in the existing app, new
  endpoints in `server.js`. Reuses the single WhatsApp session, group cache,
  and `start.sh` daemon. No second linked device.
- **Engine: Claude API (Haiku, `claude-haiku-4-5`)** — handles chat slang,
  typos, diacritic-less Romanian, and mixed languages; detects language as
  part of the same call. API key in gitignored `.env`.
- **On-demand only** — translation happens when a feed is open (initial load,
  poll for new, scroll-up for history). Nothing translates in the background.
  All results cached permanently; no message is ever translated twice.
- **Architecture: polling, not SSE** — matches the app's existing pattern.
  Frontend polls every ~4 s while a feed is open.

## UI

New "Translate" tab in `public/index.html` alongside the scheduler:

- **Group picker** — searches the already-cached groups; selected groups are
  saved as the user's translate list (`translate-groups.json`, gitignored).
- **Feed** — chat-style view per group. Each message shows sender name, time,
  the **English translation prominently**, and the original in smaller/dimmer
  text below. Messages detected as English show as-is with a small "EN" badge.
- **Media** — placeholders (`[photo]`, `[voice message]`, `[document]`,
  `[sticker]`, …); media captions are translated like normal text.
- **Scroll-up** — reaching the top loads older history.
- **Connection state** — reuses the existing WA status display; if WhatsApp
  isn't connected the tab says so, same as the scheduler.

## Server

### New endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/translate/groups` | Saved translate-group list |
| `POST /api/translate/groups` | Add/remove a group from the list |
| `GET /api/translate/messages?groupId=&limit=` | Fetch latest `limit` messages for the group, translate uncached ones, return the merged feed |

Feed items: `{ id, senderName, timestamp, type, body, caption, lang,
translation }` — `translation` is `null` for English or media-only messages.

Any `/api/translate/*` request calls `cancelAutoShutdown()` so the server
doesn't exit while the user is reading.

### Translation flow

1. `chat.fetchMessages({ limit })` for the group.
2. Partition into cached vs uncached by message ID.
3. Batch uncached text (bodies + captions) into **one** Claude Haiku request:
   JSON in (id → text), JSON out (id → `{ lang, translation | null }`,
   `translation: null` when already English).
4. Merge, write cache, return feed ordered by timestamp.

### Cache

`translations/<groupId>.json` (directory gitignored), keyed by message ID:
`{ lang, translation, body, senderName, timestamp, type }`. Storing the
original body and sender means cached history renders without re-fetching
from WhatsApp when possible. Loaded lazily per group, written after each
batch.

### Constraint: history fetching

whatsapp-web.js `fetchMessages` only supports "latest N", not "N before
message X". Scroll-up therefore refetches with a growing limit
(50 → 150 → 300 → …) and translates only cache misses. Wasteful on fetch,
free on translation.

### Sender names

Resolve group message `author` IDs through the existing in-memory contact
cache; fall back to the raw number when unknown.

## Error handling

- **Claude call fails** — feed still returns; affected messages carry
  `translation: null` and an `error` flag; UI shows original with a
  "translation failed — retry" affordance (retry re-requests the feed; failed
  items are not cached, so they retry automatically).
- **WhatsApp not connected** — `400` with the same error shape as existing
  endpoints; UI shows the connection state.
- **Missing `ANTHROPIC_API_KEY`** — server logs a clear warning at startup;
  translate endpoints return a descriptive error instead of crashing.

## Cost

Haiku on chat-length text: fractions of a cent per hundred messages. With
permanent caching, realistic usage is well under $1/month.

## Testing

Manual verification against a real group (project has no test infrastructure):
initial load, EN detection, scroll-up backfill, cache hit on reopen, Claude
failure path (bad key), WA-disconnected path.

## Out of scope (YAGNI)

- Posting translations back into WhatsApp
- Background/always-on translation
- Translating individual (non-group) chats — trivial to add later if wanted
- Voice message transcription
- SSE/websockets
