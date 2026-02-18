const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
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
let anySentThisSession = false; // guards auto-shutdown from firing on a bare restart

const QUEUE_FILE = path.join(__dirname, 'queue.json');

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
      await client.sendMessage(msg.contactId, msg.message);
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

client.on('ready', async () => {
  waStatus = 'connected';
  qrDataUrl = null;
  console.log('WhatsApp client ready');

  try {
    const all = await client.getContacts();
    contacts = all
      .filter((c) => c.isMyContact && !c.isGroup && c.id && c.id.server === 'c.us')
      .filter((c) => c.name || c.pushname || c.number)
      .sort((a, b) => {
        const nameA = (a.name || a.pushname || '').toLowerCase();
        const nameB = (b.name || b.pushname || '').toLowerCase();
        return nameA.localeCompare(nameB);
      });
    console.log(`Loaded ${contacts.length} contacts`);
  } catch (err) {
    console.error('Error loading contacts:', err);
  }

  rescheduleFromQueue();
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
  try {
    await client.destroy();
  } catch (_) { /* ignore */ }
  process.exit(0);
}

// Clean exit on SIGTERM (sent by ./start.sh --restart)
process.on('SIGTERM', performShutdown);

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
      number: c.number,
    }))
  );
});

app.get('/api/scheduled', (_req, res) => {
  res.json(scheduledMessages.map(({ timer, ...m }) => m));
});

app.post('/api/schedule', (req, res) => {
  const { contactId, contactName, message, sendAt } = req.body;

  if (!contactId || !message || !sendAt) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const sendTime = new Date(sendAt).getTime();
  if (sendTime - Date.now() <= 0) {
    return res.status(400).json({ error: 'sendAt must be in the future' });
  }

  if (waStatus !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }

  cancelAutoShutdown();

  const id = crypto.randomUUID();
  const msg = { id, contactId, contactName, message, sendAt: sendTime, status: 'pending', timer: null };
  scheduledMessages.push(msg);
  armTimer(msg);
  saveQueue();

  res.json({ id, contactId, contactName, message, sendAt: sendTime, status: 'pending' });
});

app.delete('/api/schedule/:id', (req, res) => {
  const { id } = req.params;
  const idx = scheduledMessages.findIndex((m) => m.id === id);

  if (idx === -1) return res.status(404).json({ error: 'Message not found' });

  const msg = scheduledMessages[idx];
  if (msg.status === 'pending' && msg.timer) clearTimeout(msg.timer);
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
loadQueue(); // show queued messages in UI immediately, before WA finishes connecting

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  exec(`open http://localhost:${PORT}`);
  client.initialize();
});
