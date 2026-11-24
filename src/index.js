require('dotenv').config();

const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const {
  pool, testConnection, fetchServers, fetchLivePlayers, fetchLiveSnapshot,
  findServerByAddress, upsertMonitor, updateMonitorMessage,
} = require('./database');
const { buildStatusEmbed, buildErrorEmbed, buildPresenceText } = require('./embed');

// ── Env validation ────────────────────────────────────────────────────────────

const REQUIRED_ENV = [
  'DISCORD_TOKEN',
  'DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
  'BF1942_SERVER_ADDRESS', 'BF1942_CHANNEL_ID',
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) { console.error(`[CONFIG] Missing env var: ${key}`); process.exit(1); }
}

const MIN_POLL_MS        = 15_000;
const POLL_INTERVAL_MS   = Math.max(MIN_POLL_MS, parseInt(process.env.POLL_INTERVAL_MS || '60000'));
const SERVER_ADDRESS     = process.env.BF1942_SERVER_ADDRESS;
const CHANNEL_ID         = process.env.BF1942_CHANNEL_ID;
const LABEL_OVERRIDE     = process.env.BF1942_LABEL || null;
// Every Discord login uses one of the bot's ~1000 daily gateway sessions, so a
// failed login waits this long before exiting rather than letting systemd
// restart it in a tight loop.
const LOGIN_RETRY_MS     = 5 * 60_000;
// Unchanged embeds/presence are not re-sent, except this often so the
// "Last Update" timestamp still moves on an empty server.
const FORCE_REFRESH_MS   = 5 * 60_000;

const [SERVER_IP, serverPortRaw] = SERVER_ADDRESS.split(':');
const SERVER_PORT = parseInt(serverPortRaw, 10);
if (!SERVER_IP || !Number.isFinite(SERVER_PORT)) {
  console.error(`[CONFIG] BF1942_SERVER_ADDRESS must be "ip:port" (got "${SERVER_ADDRESS}")`);
  process.exit(1);
}

if (parseInt(process.env.POLL_INTERVAL_MS || '60000') < MIN_POLL_MS) {
  console.warn(`[CONFIG] POLL_INTERVAL_MS is below the minimum (${MIN_POLL_MS}ms). Clamped to ${POLL_INTERVAL_MS}ms to avoid Discord rate limits.`);
}

// ── Discord client ────────────────────────────────────────────────────────────

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Single-monitor state: one bot instance = one server + one channel.
// Only the message ID is kept, never a Message object: a cached Message points
// at a channel object that discord.js can drop (reconnect, lost access), after
// which every edit fails with "Could not find the channel ... in the cache".
const monitor = {
  row: null, messageId: null, busy: false, lastError: null,
  lastEmbed: null, lastEditAt: 0, lastPresence: null, lastPresenceAt: 0,
};

// ── Poll / render ─────────────────────────────────────────────────────────────

// Cache hit after the first call; falls back to the API if the channel was evicted.
async function fetchChannel() {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel?.isTextBased()) {
    throw new Error(`Channel ${CHANNEL_ID} not found or not text-based. Is the bot in that server?`);
  }
  return channel;
}

async function publish(embed) {
  // Compare without the timestamp, which is "now" on every build.
  const { timestamp, ...content } = embed.toJSON();
  const fingerprint = JSON.stringify(content);
  const fresh = Date.now() - monitor.lastEditAt < FORCE_REFRESH_MS;
  if (monitor.messageId && fingerprint === monitor.lastEmbed && fresh) return;

  const channel = await fetchChannel();

  if (monitor.messageId) {
    try {
      await channel.messages.edit(monitor.messageId, { embeds: [embed] });
      monitor.lastEmbed = fingerprint;
      monitor.lastEditAt = Date.now();
      return;
    } catch (err) {
      if (err.code !== 10008) throw err;
      console.warn('[BOT] Status message deleted externally; posting a new one.');
    }
  }

  const message = await channel.send({ embeds: [embed] });
  monitor.messageId = message.id;
  monitor.lastEmbed = fingerprint;
  monitor.lastEditAt = Date.now();
  await updateMonitorMessage(CHANNEL_ID, message.id);
  console.log(`[BOT] Sent new status message (${message.id})`);
}

// Log an error once until it changes or clears, so a long outage doesn't
// write the same line every tick.
function reportError(err) {
  if (err.message !== monitor.lastError) console.error('[BOT]', err.message);
  monitor.lastError = err.message;
}

function clearError() {
  if (monitor.lastError) console.log('[BOT] Recovered.');
  monitor.lastError = null;
}

async function buildCurrentEmbed() {
  const serverIds = monitor.row.server_ids ?? [];
  try {
    const servers = await fetchServers(serverIds);
    const s = servers[0] ?? null;
    const [players, snapshot] = s
      ? await Promise.all([fetchLivePlayers(s.ip, s.port), fetchLiveSnapshot(s.ip, s.port)])
      : [[], null];
    return { embed: buildStatusEmbed(servers, monitor.row.label, serverIds, players, snapshot), servers, snapshot };
  } catch (err) {
    console.error('[DB]', err.message);
    return { embed: buildErrorEmbed(monitor.row.label), servers: [], snapshot: null };
  }
}

async function tick() {
  if (monitor.busy) return;
  monitor.busy = true;

  try {
    if (!monitor.row) await bootstrap();
    const { embed, servers, snapshot } = await buildCurrentEmbed();
    await publish(embed);
    clearError();

    // Reuse this tick's data — no second DB fetch needed.
    const presence = buildPresenceText(servers, snapshot);
    if (presence !== monitor.lastPresence || Date.now() - monitor.lastPresenceAt >= FORCE_REFRESH_MS) {
      try {
        client.user.setPresence({
          activities: [{ name: presence, type: ActivityType.Watching }],
          status: 'online',
        });
        monitor.lastPresence = presence;
        monitor.lastPresenceAt = Date.now();
      } catch { /* non-fatal */ }
    }
  } catch (err) {
    // Lost access, unknown channel, Discord outage: retry next tick.
    reportError(err);
  } finally {
    monitor.busy = false;
  }
}

// ── Ready ─────────────────────────────────────────────────────────────────────

// Runs from tick() until it succeeds. Failing here (server not polled yet,
// channel unreachable, DB down) used to exit, and systemd's restarts burned
// through the daily login limit; retrying in-process needs no new login.
async function bootstrap() {
  const ip = SERVER_IP, port = SERVER_PORT;
  const server = await findServerByAddress(ip, port);
  if (!server) {
    throw new Error(`No server found in Postgres with address ${ip}:${port}. Is it blacklisted or not yet polled?`);
  }

  const channel = await fetchChannel();

  const label = LABEL_OVERRIDE || server.current_server_name || `Server ${server.server_id}`;
  monitor.row = await upsertMonitor(channel.guildId, CHANNEL_ID, label, [server.server_id]);
  monitor.messageId = monitor.row.message_id ?? null;

  console.log(`[BOT] Pinned to ${ip}:${port} (server_id=${server.server_id}) in channel ${CHANNEL_ID}. Label: "${label}".`);
}

client.once('clientReady', async () => {
  console.log(`[BOT] Logged in as ${client.user.tag}`);

  try {
    await testConnection();
    console.log('[DB] Connection verified.');
  } catch (err) {
    console.warn('[DB] Initial check failed:', err.message, '— will retry on first poll.');
  }

  await tick();
  setInterval(tick, POLL_INTERVAL_MS);
  console.log(`[BOT] Polling every ${POLL_INTERVAL_MS / 1000}s. Ready.`);
});

// ── Error handling ────────────────────────────────────────────────────────────

client.on('error', (err) => console.error('[DISCORD] Client error:', err.message));
process.on('unhandledRejection', (err) => console.error('[PROCESS] Unhandled rejection:', err));

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`[BOT] ${signal} received — shutting down.`);
  client.destroy();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error(`[DISCORD] Login failed: ${err.message} — exiting in ${LOGIN_RETRY_MS / 60_000} min.`);
  setTimeout(() => process.exit(1), LOGIN_RETRY_MS);
});
