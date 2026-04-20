# BF1942 Discord Server Status Bot — Setup Guide

## How it works

Once running, Discord server admins configure the bot entirely through slash commands — no config files to edit and no bot restarts needed.

| Command | Permission | What it does |
|---|---|---|
| `/bf1942 setup [label]` | Manage Server | Creates a live status embed in the current channel |
| `/bf1942 remove` | Manage Server | Removes the monitor and deletes the embed |
| `/bf1942 info` | Manage Server | Shows what this channel is currently configured to display |
| `/bf1942 filter add <server>` | Manage Server | Restricts the embed to a specific game server (autocompletes from live data) |
| `/bf1942 filter remove <server>` | Manage Server | Removes a server from the filter |
| `/bf1942 filter clear` | Manage Server | Clears all filters — shows every game server |

An empty filter means **all servers are shown**. Once you add at least one filter, only those servers appear. You can run `/bf1942 setup` in as many channels as you like — each gets its own independent embed and filter.

The bot's presence in the Discord sidebar shows the total live player count and the top active map, updated every minute.

---

## Prerequisites

- **Node.js 18+** on the machine running the bot.
- The **bf1942-stats-engine** must already be running and its **PostgreSQL database** accessible (host, port, name, user, password).
- A Discord account with permission to create a bot application.

---

## Step 1 — Create the Discord Bot Application

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**.
2. Name it (e.g. `BF1942 Status`) → **Create**.
3. Click **Bot** in the left sidebar.
4. Click **Reset Token**, confirm, then **copy the token** — you'll need this in Step 5.
5. Under **Privileged Gateway Intents** — no extras are required. Leave them all off.

---

## Step 2 — Invite the Bot to Your Server

1. Go to **OAuth2 → URL Generator** in the left sidebar.
2. Under **Scopes**, tick **`bot`** and **`applications.commands`**.
3. Under **Bot Permissions**, tick:
   - View Channels
   - Send Messages
   - Embed Links
   - Read Message History
   - Manage Messages *(needed to delete the embed on `/bf1942 remove`)*
4. Copy the generated URL, open it in a browser, and invite the bot to your server.

---

## Step 3 — Run the Database Migration

The bot needs one new table in the **same PostgreSQL database** as the stats engine. Run this once:

```bash
psql -h YOUR_DB_HOST -U YOUR_DB_USER -d YOUR_DB_NAME -f setup.sql
```

You should see:

```
CREATE TABLE
CREATE INDEX
```

That's it — no other schema changes are required and nothing in the stats engine is modified.

---

## Step 4 — Install Dependencies

```bash
cd BF1942-Discord-Server-Status
npm install
```

---

## Step 5 — Configure Environment Variables

```bash
cp .env.example .env
```

Open `.env` and fill in every value:

```env
# From Step 1 → Bot → Reset Token
DISCORD_TOKEN=paste_your_bot_token_here

# Same connection details used by bf1942-stats-engine
DB_HOST=localhost
DB_PORT=5432
DB_NAME=bf1942
DB_USER=postgres
DB_PASSWORD=your_db_password

# Refresh interval in milliseconds (60000 = 1 minute)
POLL_INTERVAL_MS=60000

# Game servers not seen within this many minutes are hidden from embeds
SERVER_STALE_MINUTES=10
```

---

## Step 6 — Start the Bot

```bash
node src/index.js
```

Expected startup output:

```
[BOT] Logged in as BF1942 Status#1234
[DB] Connection verified.
[CMD] Global slash commands registered.
[BOT] Loaded 0 monitor(s) from database.
[BOT] Polling every 60s. Ready.
```

> **Note:** Global slash commands can take up to **1 hour** to appear in Discord after the very first run. After that initial propagation they are always available, including on any new server you add the bot to.

---

## Step 7 — Set Up a Status Channel (in Discord)

1. Go to the channel where you want the live status embed.
2. Type `/bf1942 setup` — optionally add a label: `/bf1942 setup label:Pacific Servers`.
3. The bot posts the embed immediately and starts updating it every minute.

To add more channels, repeat in any other channel. Each one is independent.

**To filter a channel to specific game servers:**

```
/bf1942 filter add   → pick a server from the autocomplete list
/bf1942 filter add   → pick another to add it too
/bf1942 filter clear → go back to showing everything
```

---

## Step 8 — Run as a Background Service (Recommended)

### PM2 (Linux / Mac / Windows)

```bash
npm install -g pm2
pm2 start src/index.js --name bf1942-status-bot
pm2 save
pm2 startup   # follow the printed command to auto-start on reboot
```

### Windows Task Scheduler

1. Open **Task Scheduler → Create Task**.
2. Trigger: **At startup**.
3. Action: run `node`, argument `C:\path\to\BF1942-Discord-Server-Status\src\index.js`.
4. **Start in**: `C:\path\to\BF1942-Discord-Server-Status`.

---

## Adding More Map Names

Open `src/embed.js` and add entries to the `MAP_DISPLAY` object:

```js
'your_map_key': 'Display Name',
```

The key is the lowercase underscore-separated value exactly as it appears in the `current_map` column of the `servers` table. Unknown maps are auto-formatted (underscores replaced with spaces, title-cased), so you only need to add entries where the auto-format isn't good enough.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/bf1942` command doesn't appear | Global commands still propagating | Wait up to 1 hour after first launch |
| `Missing env var` on startup | `.env` incomplete | Check all values in `.env` |
| `Connection verified` never appears | Wrong DB credentials or DB unreachable | Test: `psql -h HOST -U USER -d DB_NAME` |
| `relation "discord_monitors" does not exist` | Migration not run | Run `psql ... -f setup.sql` (Step 3) |
| Bot not visible in user list | Missing `bot` scope on invite | Re-invite using the URL from Step 2 |
| Embed stays after `/bf1942 remove` | Bot lacks Manage Messages permission | Re-invite with the corrected permissions from Step 2 |
| Autocomplete shows no servers | No servers in DB or all blacklisted | Check the `servers` table: `SELECT server_id, current_server_name FROM servers WHERE is_blacklisted = false;` |
