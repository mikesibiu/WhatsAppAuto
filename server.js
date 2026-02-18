const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');

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

client.on('ready', async () => {
  waStatus = 'connected';
  qrDataUrl = null;
  console.log('WhatsApp client ready');

  try {
    const all = await client.getContacts();
    contacts = all.filter(
      (c) => c.isMyContact && !c.isGroup && c.id && c.id.server === 'c.us' && c.name
    );
    console.log(`Loaded ${contacts.length} contacts`);
  } catch (err) {
    console.error('Error loading contacts:', err);
  }
});

client.on('disconnected', (reason) => {
  waStatus = 'disconnected';
  console.log('Disconnected:', reason);
});

// ── Shutdown helpers ───────────────────────────────────────────────────────
function checkAutoShutdown() {
  const hasPending = scheduledMessages.some((m) => m.status === 'pending');
  const hasAny = scheduledMessages.length > 0;

  if (!hasPending && hasAny && !shutdownTimer) {
    console.log('All messages sent — auto-shutdown in 2 minutes');
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
  try {
    await client.destroy();
  } catch (_) {
    /* ignore */
  }
  process.exit(0);
}

// ── API Routes ─────────────────────────────────────────────────────────────

// GET /api/status
app.get('/api/status', (_req, res) => {
  res.json({ wa: waStatus, qr: qrDataUrl, contactsLoaded: contacts.length > 0, shutdownAt });
});

// GET /api/contacts?q=
app.get('/api/contacts', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);

  const results = contacts
    .filter(
      (c) =>
        (c.name && c.name.toLowerCase().includes(q)) ||
        (c.number && c.number.includes(q))
    )
    .slice(0, 20)
    .map((c) => ({
      id: c.id._serialized,
      name: c.name || c.pushname || c.number,
      number: c.number,
    }));

  res.json(results);
});

// GET /api/scheduled
app.get('/api/scheduled', (_req, res) => {
  // strip non-serialisable timer handles
  const safe = scheduledMessages.map(({ timer, ...m }) => m);
  res.json(safe);
});

// POST /api/schedule
app.post('/api/schedule', (req, res) => {
  const { contactId, contactName, message, sendAt } = req.body;

  if (!contactId || !message || !sendAt) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const sendTime = new Date(sendAt).getTime();
  const delay = sendTime - Date.now();

  if (delay <= 0) {
    return res.status(400).json({ error: 'sendAt must be in the future' });
  }

  if (waStatus !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }

  cancelAutoShutdown();

  const id = crypto.randomUUID();

  const timer = setTimeout(async () => {
    const msg = scheduledMessages.find((m) => m.id === id);
    if (!msg || msg.status !== 'pending') return;

    try {
      await client.sendMessage(contactId, message);
      msg.status = 'sent';
      msg.sentAt = Date.now();
      console.log(`✓ Message sent to ${contactName}`);
    } catch (err) {
      msg.status = 'failed';
      msg.error = err.message;
      console.error(`✗ Failed to send to ${contactName}:`, err.message);
    }

    checkAutoShutdown();
  }, delay);

  scheduledMessages.push({ id, contactId, contactName, message, sendAt: sendTime, status: 'pending', timer });

  res.json({ id, contactId, contactName, message, sendAt: sendTime, status: 'pending' });
});

// DELETE /api/schedule/:id
app.delete('/api/schedule/:id', (req, res) => {
  const { id } = req.params;
  const idx = scheduledMessages.findIndex((m) => m.id === id);

  if (idx === -1) return res.status(404).json({ error: 'Message not found' });

  const msg = scheduledMessages[idx];
  if (msg.status === 'pending' && msg.timer) clearTimeout(msg.timer);

  scheduledMessages.splice(idx, 1);
  res.json({ success: true });
});

// POST /api/shutdown
app.post('/api/shutdown', (_req, res) => {
  res.json({ success: true });
  setTimeout(performShutdown, 500);
});

// POST /api/cancel-shutdown
app.post('/api/cancel-shutdown', (_req, res) => {
  cancelAutoShutdown();
  res.json({ success: true });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  exec(`open http://localhost:${PORT}`);
  client.initialize();
});
