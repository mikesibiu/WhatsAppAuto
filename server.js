require('dotenv').config();
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('⚠ ANTHROPIC_API_KEY not set — the Translate feature will return errors until you add it to .env');
}

const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const crypto = require('crypto');
const multer = require('multer');
const { translateBatch } = require('./lib/translator');
const { createCache } = require('./lib/translationCache');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 64 * 1024 * 1024 } });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── State ──────────────────────────────────────────────────────────────────
let waStatus = 'initializing'; // 'initializing' | 'qr' | 'loading' | 'connected' | 'disconnected'
let qrDataUrl = null;
let contacts = [];
let scheduledMessages = []; // { id, contactId, contactName, message, sendAt, status, timer }
let shutdownTimer = null;
let shutdownAt = null;
let anySentThisSession = false; // guards auto-shutdown from firing on a bare restart

const QUEUE_FILE    = path.join(__dirname, 'queue.json');
const CONTACTS_FILE = path.join(__dirname, 'contacts.json');
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

// WhatsApp now addresses group senders by LID, which doesn't match the contact
// cache (@c.us). Map LID → phone number once per author and remember it.
const lidPnCache = new Map(); // '<id>@lid' -> '<number>@c.us' | null

async function resolveLidAuthors(msgs) {
  const authorIds = [...new Set(msgs.filter((m) => !m.fromMe).map((m) => m.author || m.from))];
  const unknown = authorIds.filter((id) => id && id.endsWith('@lid') && !lidPnCache.has(id));
  if (!unknown.length) return;
  try {
    const mapped = await client.getContactLidAndPhone(unknown);
    for (const r of mapped) if (r.lid) lidPnCache.set(r.lid, r.pn || null);
  } catch (e) {
    console.error('LID→phone resolution failed:', e.message);
  }
}

// Resolve a group message's author to a display name via the contact cache.
function resolveSenderName(msg) {
  if (msg.fromMe) return 'You';
  const authorId = msg.author || msg.from;
  const candidateIds = [authorId, lidPnCache.get(authorId)].filter(Boolean);
  for (const id of candidateIds) {
    const contact = contacts.find((c) => (c.id?._serialized ?? c.id) === id);
    if (contact && (contact.name || contact.pushname)) return contact.name || contact.pushname;
  }
  if (msg._data && msg._data.notifyName) return msg._data.notifyName; // sender's push name
  const pn = lidPnCache.get(authorId);
  return String(pn || authorId).split('@')[0];
}

// ── Contact cache ──────────────────────────────────────────────────────────

function saveContactsCache() {
  try {
    const serialisable = contacts.map((c) => ({
      id:       c.id?._serialized ?? c.id,
      name:     c.name || c.pushname || '',
      number:   c.number || '',
      isGroup:  !!c.isGroup,
    }));
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(serialisable, null, 2));
  } catch (e) {
    console.error('Failed to save contacts cache:', e.message);
  }
}

function loadContactsCache() {
  try {
    if (!fs.existsSync(CONTACTS_FILE)) return;
    const cached = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
    if (!cached.length) return;
    // Use cached entries as stand-ins until real objects arrive from WhatsApp.
    contacts = cached.map((c) => ({
      id: { _serialized: c.id },
      name: c.name,
      number: c.number,
      isGroup: c.isGroup,
      _fromCache: true,
    }));
    console.log(`Loaded ${cached.length} contacts from local cache`);
  } catch (e) {
    console.error('Failed to load contacts cache:', e.message);
  }
}

// ── Queue persistence ──────────────────────────────────────────────────────

// Only pending messages are persisted — sent/failed/missed are ephemeral.
function saveQueue() {
  try {
    const pending = scheduledMessages
      .filter((m) => m.status === 'pending')
      .map(({ timer, ...m }) => m);
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(pending, null, 2));
  } catch (e) {
    console.error('Failed to save queue:', e.message);
  }
}

// Called once at startup so the UI can show queued messages before WA connects.
function loadQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    // All items in the file are pending; timers are armed later in rescheduleFromQueue.
    scheduledMessages = raw.map((m) => ({ ...m, status: 'pending', timer: null }));
    console.log(`Loaded ${scheduledMessages.length} pending message(s) from queue`);
  } catch (e) {
    console.error('Failed to load queue:', e.message);
  }
}

// Arms the send timer for a single pending message.
function armTimer(msg) {
  const delay = msg.sendAt - Date.now();
  msg.timer = setTimeout(async () => {
    if (msg.status !== 'pending') return;
    try {
      if (msg.filePath) {
        const media = MessageMedia.fromFilePath(msg.filePath);
        await client.sendMessage(msg.contactId, media, msg.message ? { caption: msg.message } : {});
      } else {
        await client.sendMessage(msg.contactId, msg.message);
      }
      msg.status = 'sent';
      msg.sentAt = Date.now();
      anySentThisSession = true;
      console.log(`✓ Sent to ${msg.contactName}`);
    } catch (err) {
      msg.status = 'failed';
      msg.error = err.message;
      anySentThisSession = true; // failed attempts still count for shutdown logic
      console.error(`✗ Failed to send to ${msg.contactName}:`, err.message);
    }
    if (msg.filePath) {
      fs.unlink(msg.filePath, () => {});
      msg.filePath = null;
    }
    saveQueue();
    checkAutoShutdown();
  }, delay);
}

// Called when WA becomes ready — re-arms surviving messages or marks them missed.
function rescheduleFromQueue() {
  const now = Date.now();
  let missed = 0;
  scheduledMessages.forEach((msg) => {
    if (msg.status !== 'pending') return;
    if (msg.sendAt <= now) {
      msg.status = 'missed';
      if (msg.filePath) {
        fs.unlink(msg.filePath, () => {});
        msg.filePath = null;
      }
      missed++;
    } else {
      armTimer(msg);
    }
  });
  if (missed) {
    console.log(`⚠ ${missed} message(s) missed their window while the server was down`);
    saveQueue(); // removes missed ones from disk
  }
}

// ── WhatsApp Client ────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', async (qr) => {
  waStatus = 'qr';
  qrDataUrl = await qrcode.toDataURL(qr);
  console.log('QR code ready — open http://localhost:3000 to scan');
});

client.on('loading_screen', (percent, message) => {
  waStatus = 'loading';
  console.log(`Loading: ${percent}% — ${message}`);
});

client.on('authenticated', () => {
  waStatus = 'loading';
  console.log('Authenticated');
});

client.on('auth_failure', (msg) => {
  waStatus = 'disconnected';
  console.error('Auth failure:', msg);
});

let contactRefreshTimer = null;

async function refreshContacts(label = 'Refreshed') {
  try {
    const [allContacts, allChats] = await Promise.all([
      client.getContacts(),
      client.getChats(),
    ]);

    const individuals = allContacts
      .filter((c) => c.isMyContact && !c.isGroup && c.id && c.id.server === 'c.us')
      .filter((c) => c.name || c.pushname || c.number);

    const groups = allChats
      .filter((c) => c.isGroup && c.name);

    contacts = [...individuals, ...groups].sort((a, b) => {
      const nameA = (a.name || a.pushname || '').toLowerCase();
      const nameB = (b.name || b.pushname || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });

    console.log(`${label} ${individuals.length} contacts and ${groups.length} groups`);
    saveContactsCache();
  } catch (err) {
    console.error('Error loading contacts/groups:', err);
  }
}

client.on('ready', async () => {
  waStatus = 'connected';
  qrDataUrl = null;
  console.log('WhatsApp client ready');

  await refreshContacts('Loaded');
  rescheduleFromQueue();

  // Periodically re-sync contacts (catches new contacts added after initial link)
  if (contactRefreshTimer) clearInterval(contactRefreshTimer);
  contactRefreshTimer = setInterval(() => refreshContacts('Refreshed'), 2 * 60 * 1000);
});

client.on('disconnected', (reason) => {
  waStatus = 'disconnected';
  console.log('Disconnected:', reason);
});

// ── Shutdown helpers ───────────────────────────────────────────────────────
function checkAutoShutdown() {
  const hasPending = scheduledMessages.some((m) => m.status === 'pending');

  // Only arm the countdown if this session actually sent/failed something.
  // Prevents a bare restart (with future-dated pending messages still waiting)
  // from immediately triggering the 2-minute exit timer.
  if (!hasPending && anySentThisSession && !shutdownTimer) {
    console.log('All messages resolved — auto-shutdown in 2 minutes');
    shutdownAt = Date.now() + 2 * 60 * 1000;
    shutdownTimer = setTimeout(performShutdown, 2 * 60 * 1000);
  }
}

function cancelAutoShutdown() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
    shutdownAt = null;
    console.log('Auto-shutdown cancelled');
  }
}

async function performShutdown() {
  console.log('Shutting down…');
  if (contactRefreshTimer) clearInterval(contactRefreshTimer);
  try {
    await Promise.race([
      client.destroy(),
      new Promise(resolve => setTimeout(resolve, 4000)),
    ]);
  } catch (_) { /* ignore */ }
  process.exit(0);
}

// Clean exit on SIGUSR1 (sent by ./start.sh restart) or SIGINT (Ctrl+C on direct node run).
// SIGTERM is intentionally NOT caught — macOS Terminal sends it when closing a tab,
// and nohup only blocks SIGHUP.  The queue is persisted so no messages are lost on a
// hard kill; the OS will clean up the Puppeteer/Chrome child process automatically.
process.on('SIGUSR1', performShutdown);
process.on('SIGINT', performShutdown);

// ── API Routes ─────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  res.json({ wa: waStatus, qr: qrDataUrl, contactsLoaded: contacts.length > 0, shutdownAt });
});

app.get('/api/contacts', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();

  const pool = q
    ? contacts.filter(
        (c) =>
          (c.name && c.name.toLowerCase().includes(q)) ||
          (c.pushname && c.pushname.toLowerCase().includes(q)) ||
          (c.number && c.number.includes(q))
      )
    : contacts;

  res.json(
    pool.slice(0, 50).map((c) => ({
      id: c.id._serialized,
      name: c.name || c.pushname || c.number,
      number: c.number || null,
      isGroup: !!c.isGroup,
    }))
  );
});

app.post('/api/download-images', async (req, res) => {
  const { contactId, contactName } = req.body;

  if (!contactId) return res.status(400).json({ error: 'Missing contactId' });
  if (waStatus !== 'connected') return res.status(400).json({ error: 'WhatsApp not connected' });

  try {
    const chat = await client.getChatById(contactId);
    const messages = await chat.fetchMessages({ limit: 100000 });
    const imageMessages = messages.filter((m) => m.hasMedia && m.type === 'image');
    const documentMessages = messages.filter((m) => m.hasMedia && m.type === 'document');

    const safeName = (contactName || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const folder = path.join(DOWNLOADS_DIR, `${safeName || 'chat'}-${Date.now()}`);
    const documentsFolder = path.join(folder, 'documents');
    fs.mkdirSync(folder, { recursive: true });
    fs.mkdirSync(documentsFolder, { recursive: true });

    let savedImages = 0;
    for (const msg of imageMessages) {
      try {
        const media = await msg.downloadMedia();
        if (!media) continue;
        const ext = (media.mimetype.split('/')[1] || 'jpg').split(';')[0];
        fs.writeFileSync(path.join(folder, `${msg.timestamp}-${msg.id.id}.${ext}`), Buffer.from(media.data, 'base64'));
        savedImages++;
      } catch (e) {
        console.error('Failed to download an image:', e.message);
      }
    }

    let savedDocuments = 0;
    for (const msg of documentMessages) {
      try {
        const media = await msg.downloadMedia();
        if (!media) continue;
        const ext = (media.filename && path.extname(media.filename)) || `.${(media.mimetype.split('/')[1] || 'bin').split(';')[0]}`;
        const baseName = media.filename ? path.basename(media.filename, path.extname(media.filename)) : msg.id.id;
        fs.writeFileSync(path.join(documentsFolder, `${msg.timestamp}-${baseName}${ext}`), Buffer.from(media.data, 'base64'));
        savedDocuments++;
      } catch (e) {
        console.error('Failed to download a document:', e.message);
      }
    }

    console.log(`Downloaded ${savedImages} image(s) and ${savedDocuments} document(s) from ${contactName || contactId} to ${folder}`);
    res.json({ success: true, count: savedImages, documentCount: savedDocuments, folder, documentsFolder });
  } catch (err) {
    console.error('Error downloading images:', err);
    res.status(500).json({ error: err.message || 'Failed to download images' });
  }
});

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
    await resolveLidAuthors(fetched);

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

app.get('/api/scheduled', (_req, res) => {
  res.json(scheduledMessages.map(({ timer, ...m }) => m));
});

app.post('/api/schedule', upload.single('file'), (req, res) => {
  const { contactId, contactName, message, sendAt } = req.body;
  const hasMessage = message && message.trim();

  if (!contactId || !sendAt) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!hasMessage && !req.file) {
    return res.status(400).json({ error: 'Provide a message or attach a file' });
  }

  const sendTime = Number(sendAt);
  if (sendTime - Date.now() <= 0) {
    return res.status(400).json({ error: 'sendAt must be in the future' });
  }

  if (waStatus !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }

  cancelAutoShutdown();

  const id = crypto.randomUUID();
  const msg = {
    id,
    contactId,
    contactName,
    message: hasMessage ? message.trim() : '',
    sendAt: sendTime,
    status: 'pending',
    timer: null,
    filePath: req.file ? req.file.path : null,
    fileName: req.file ? req.file.originalname : null,
  };
  scheduledMessages.push(msg);
  armTimer(msg);
  saveQueue();

  res.json({ id, contactId, contactName, message: msg.message, sendAt: sendTime, status: 'pending', fileName: msg.fileName });
});

app.delete('/api/schedule/:id', (req, res) => {
  const { id } = req.params;
  const idx = scheduledMessages.findIndex((m) => m.id === id);

  if (idx === -1) return res.status(404).json({ error: 'Message not found' });

  const msg = scheduledMessages[idx];
  if (msg.status === 'pending' && msg.timer) clearTimeout(msg.timer);
  if (msg.filePath) fs.unlink(msg.filePath, () => {});
  scheduledMessages.splice(idx, 1);
  saveQueue();
  res.json({ success: true });
});

app.post('/api/shutdown', (_req, res) => {
  res.json({ success: true });
  setTimeout(performShutdown, 500);
});

app.post('/api/cancel-shutdown', (_req, res) => {
  cancelAutoShutdown();
  res.json({ success: true });
});

// ── Start ──────────────────────────────────────────────────────────────────
loadQueue();          // show queued messages in UI immediately, before WA finishes connecting
loadContactsCache();  // pre-populate contacts from last session so search works instantly

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  exec(`open http://localhost:${PORT}`);
  client.initialize();
});
