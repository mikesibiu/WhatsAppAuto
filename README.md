# WhatsAppAuto

A personal tool to queue WhatsApp messages while you're awake and have them send automatically at a civilized hour. The server shuts itself down cleanly once all messages are delivered.

## How it works

1. Run `./start.sh` — any running instance is stopped first, then the server starts as a daemon; your browser opens automatically a moment later
2. First launch: scan the QR code with WhatsApp on your phone (one-time setup)
3. Search a contact or group, type a message, pick a send time
4. Close your laptop — the server keeps running (Mac is kept awake via `caffeinate`)
5. Messages send at the scheduled time; the server exits 2 minutes after the last one

## Requirements

- macOS (uses `caffeinate` and `open`)
- Node.js 18+
- npm

## Setup & Usage

```bash
git clone <repo-url>
cd WhatsAppAuto
./start.sh
```

`start.sh` installs dependencies on first run, then launches the server under `caffeinate -s` so your Mac stays awake until Node exits.

Open **http://localhost:3000** (browser opens automatically).

## Features

- **QR auth with session persistence** — scan once, reconnect silently on future runs
- **Contact & group search** — debounced autocomplete from your saved WhatsApp contacts and groups
- **Scheduled messages** — set any future date/time; uses `setTimeout`, no extra scheduler library
- **Queue persistence** — pending messages are saved to `queue.json`; they survive server restarts
- **Live countdown** — pending messages show time remaining (updates every 3 s)
- **Auto-shutdown** — server exits 2 minutes after all messages are sent; `caffeinate` releases and Mac can sleep
- **Cancel / Keep Running** — override auto-shutdown from the UI at any time

## Project Structure

```
WhatsAppAuto/
├── package.json        # Dependencies: whatsapp-web.js, express, qrcode
├── server.js           # Express API + WhatsApp Web client
├── public/
│   └── index.html      # Single-page UI (vanilla JS, no framework)
├── start.sh            # Entry point — stops old instance, installs deps, starts daemon
├── queue.json          # Persisted pending messages (auto-created at runtime)
├── server.pid          # PID of the running server (auto-created at runtime)
├── server.log          # Server stdout/stderr (auto-created at runtime)
└── .gitignore
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | WA connection state, QR data URL, shutdown timestamp |
| GET | `/api/contacts?q=` | Search saved contacts (top 20) |
| GET | `/api/scheduled` | List all scheduled messages |
| POST | `/api/schedule` | Queue a new message |
| DELETE | `/api/schedule/:id` | Cancel a pending message |
| POST | `/api/shutdown` | Trigger immediate shutdown |
| POST | `/api/cancel-shutdown` | Cancel the auto-shutdown countdown |

## Notes

- Uses [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) (unofficial WhatsApp Web automation via Puppeteer)
- Session data is stored in `.wwebjs_auth/` — excluded from git
- Only contacts saved in your phone's address book appear in search results
