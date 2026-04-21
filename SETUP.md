# BF1942 Discord Server Status Bot — Setup Guide

## How it works

Each bot instance is pinned via `.env` to **one** BF1942 game server and **one** Discord channel. On startup it finds the server in Postgres, posts a live status embed in the channel, and refreshes it every minute. No slash commands, no in-Discord configuration — everything is driven by environment variables so multiple instances can run side-by-side in the same Discord without cluttering the `/` command menu.

To change which server or channel a bot points at, edit its `.env` and restart.

---

## Prerequisites

- **Node.js 18+** on the machine running the bot.
- The **bf1942-stats-engine** running with its **PostgreSQL database** reachable (host, port, name, user, password).
- The stats engine's live poller populating `live_server_snapshot` and `live_player_snapshot`. The bot reads tickets, time remaining, and the player scoreboard from those tables.
- A Discord account with permission to create a bot application.

---

## Step 1 — Create the Discord Bot Application

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**.
2. Name it (e.g. `BF1942 Status`) → **Create**.
3. Click **Bot** in the left sidebar.
4. Click **Reset Token**, confirm, then **copy the token** — you'll need it in Step 5.
5. Under **Privileged Gateway Intents** — leave them all off; none are needed.

---

## Step 2 — Invite the Bot to Your Server

1. Go to **OAuth2 → URL Generator** in the left sidebar.
2. Under **Scopes**, tick **`bot`** only. (No `applications.commands` — this bot doesn't register any.)
3. Under **Bot Permissions**, tick:
   - View Channels
   - Send Messages
   - Embed Links
   - Read Message History
   - Manage Messages *(so the bot can delete its old embed on replacement)*
4. Copy the generated URL, open it in a browser, and invite the bot to your Discord server.

---

## Step 3 — Run the Database Migration

The bot needs one table in the **same PostgreSQL database** as the stats engine. Run this once:

```bash
psql -h YOUR_DB_HOST -U YOUR_DB_USER -d YOUR_DB_NAME -f setup.sql
```

You should see:

```
CREATE TABLE
CREATE INDEX
```

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

Open `.env` and fill in every value. All fields below are **required**:

```env
# Discord
DISCORD_TOKEN=paste_your_bot_token_here

# Postgres — same credentials as bf1942-stats-engine
DB_HOST=localhost
DB_PORT=5432
DB_NAME=bf1942
DB_USER=postgres
DB_PASSWORD=your_db_password

# Which game server to monitor — "ip:query_port" exactly as it appears
# in the bf1942-stats-engine `servers` table.
BF1942_SERVER_ADDRESS=1.1.1.1:23000

# The Discord channel where the status embed is posted.
# Enable Discord Developer Mode → right-click channel → Copy Channel ID.
BF1942_CHANNEL_ID=123456789012345678

# Optional — overrides the embed title. Defaults to the server's current name.
BF1942_LABEL=Your Game Server

# Refresh interval in milliseconds (minimum ~15000). Default 60000 = 1 minute.
POLL_INTERVAL_MS=60000
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
[BOT] Pinned to 1.1.1.1:23000 (server_id=xx) in channel 123456789012345678. Label: "HootGamers.com".
[BOT] Sent new status message (...)
[BOT] Polling every 60s. Ready.
```

If the bot exits with `No server found in Postgres with address ...`, verify the IP/port match a row in the `servers` table:

```sql
SELECT server_id, host(ip), port, current_server_name
FROM servers
WHERE host(ip) = '1.1.1.1';
```

---

## Step 7 — Run as a Background Service (Recommended)

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

## Running Multiple Bot Instances in the Same Discord Server

You can run 2, 3, or more copies of this bot in a single Discord — one per game server. Each instance appears as its own member with its own name, avatar, and presence line.

**Each instance must be its own Discord Application** with its own token. Discord identifies bots by Application ID; you cannot invite the same bot twice.

### Step A — Create one Discord Application per instance

Repeat **Step 1** and **Step 2** for each instance. Give each a distinct name (e.g. `BF1942 Status · EU`, `BF1942 Status · US`, `BF1942 Status · Pacific`) and save each token separately.

### Step B — Give each instance its own folder and `.env`

```
bots/
  bf1942-status-eu/       ← copy of this project, own .env
  bf1942-status-us/
  bf1942-status-pacific/
```

Only the `.env` file differs between folders — different `DISCORD_TOKEN`, different `BF1942_SERVER_ADDRESS`, different `BF1942_CHANNEL_ID`.

All instances share the same Postgres. The `discord_monitors` table is keyed by `channel_id`, so **each instance must target a different channel**.

### Step C — Run each instance as its own service

**PM2 (recommended):**

```bash
cd bots/bf1942-status-eu      && pm2 start src/index.js --name bf1942-eu
cd bots/bf1942-status-us      && pm2 start src/index.js --name bf1942-us
cd bots/bf1942-status-pacific && pm2 start src/index.js --name bf1942-pacific
pm2 save
```

`pm2 list` shows all three. Logs are per-instance: `pm2 logs bf1942-eu`.

### Checklist

- [ ] Each instance has a unique `DISCORD_TOKEN`.
- [ ] Each instance was invited using its own OAuth URL.
- [ ] Each instance posts in a **different channel**.
- [ ] All instances share Postgres credentials — that's expected; the `discord_monitors` table is shared.

---

## Adding More Map Names

Open `src/embed.js` and add entries to the `MAP_DISPLAY` object:

```js
'your_map_key': 'Display Name',
```

The key is the lowercase underscore-separated value from the `current_map` column. Unknown maps are auto-formatted (underscores replaced with spaces, title-cased), so only add entries where the auto-format isn't good enough.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing env var` on startup | `.env` incomplete | Check all required values in `.env` |
| `Connection verified` never appears | Wrong DB credentials or DB unreachable | Test: `psql -h HOST -U USER -d DB_NAME` |
| `relation "discord_monitors" does not exist` | Migration not run | Run `psql ... -f setup.sql` (Step 3) |
| `No server found in Postgres with address ...` | IP/port doesn't match a row in `servers` | Verify: `SELECT server_id, host(ip), port FROM servers WHERE host(ip) = 'YOUR.IP';` |
| Bot not visible in user list | Missing `bot` scope on invite | Re-invite using the URL from Step 2 |
| Embed appears but tickets / time remaining / player scoreboard missing | `live_server_snapshot` / `live_player_snapshot` empty | The stats engine's live poller isn't running or isn't writing those tables. Verify: `SELECT COUNT(*) FROM live_server_snapshot;` |
| Wrong IP shown in embed | Confused query port vs game port | The embed uses `current_game_port` for the displayed join address. If that column is 0, the query port is shown as a fallback. |
