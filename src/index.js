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

if (parseInt(process.env.POLL_INTERVAL_MS || '60000') < MIN_POLL_MS) {
  console.warn(`[CONFIG] POLL_INTERVAL_MS is below the minimum (${MIN_POLL_MS}ms). Clamped to ${POLL_INTERVAL_MS}ms to avoid Discord rate limits.`);
}

// ── Discord client ────────────────────────────────────────────────────────────

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Single-monitor state: one bot instance = one server + one channel.
const monitor = { row: null, message: null, busy: false };

// ── Poll / render ─────────────────────────────────────────────────────────────

async function ensureMessage() {
  if (!monitor.row || monitor.message) return;

  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) return;

  if (monitor.row.message_id) {
    try {
      monitor.message = await channel.messages.fetch(monitor.row.message_id);
      return;
    } catch {
      // Previous message was deleted; fall through to send a new one.
    }
  }

  monitor.message = await channel.send({ embeds: [await buildCurrentEmbed()] });
  await updateMonitorMessage(CHANNEL_ID, monitor.message.id);
  monitor.row.message_id = monitor.message.id;
  console.log(`[BOT] Sent new status message (${monitor.message.id})`);
}

async function buildCurrentEmbed() {
  const serverIds = monitor.row.server_ids ?? [];
  try {
    const servers = await fetchServers(serverIds);
    const s = servers[0] ?? null;
    const [players, snapshot] = s
      ? await Promise.all([fetchLivePlayers(s.ip, s.port), fetchLiveSnapshot(s.ip, s.port)])
      : [[], null];
    return { embed: buildStatusEmbed(servers, monitor.row.label, serverIds, players, snapshot), servers };
  } catch (err) {
    console.error('[DB]', err.message);
    return { embed: buildErrorEmbed(monitor.row.label, err.message), servers: [] };
  }
}

async function tick() {
  await ensureMessage();
  if (!monitor.message || monitor.busy) return;
  monitor.busy = true;

  try {
    const { embed, servers } = await buildCurrentEmbed();

    try {
      await monitor.message.edit({ embeds: [embed] });
    } catch (err) {
      if (err.code === 10008) {
        console.warn('[BOT] Status message deleted externally; will recreate next tick.');
        monitor.message = null;
        monitor.row.message_id = null;
        await updateMonitorMessage(CHANNEL_ID, null);
      } else if (err.code === 429) {
        console.warn('[BOT] Rate limited — skipping tick.');
      } else {
        console.error('[BOT] Edit failed:', err.message);
      }
    }

    // Reuse servers from this tick — no second DB fetch needed.
    try {
      client.user.setPresence({
        activities: [{ name: buildPresenceText(servers), type: ActivityType.Watching }],
        status: 'online',
      });
    } catch { /* non-fatal */ }
  } finally {
    monitor.busy = false;
  }
}

// ── Ready ─────────────────────────────────────────────────────────────────────

async function bootstrap() {
  const [ip, portRaw] = SERVER_ADDRESS.split(':');
  const port = parseInt(portRaw, 10);
  if (!ip || !Number.isFinite(port)) {
    throw new Error(`BF1942_SERVER_ADDRESS must be "ip:port" (got "${SERVER_ADDRESS}")`);
  }

  const server = await findServerByAddress(ip, port);
  if (!server) {
    throw new Error(`No server found in Postgres with address ${ip}:${port}. Is it blacklisted or not yet polled?`);
  }

  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) {
    throw new Error(`Channel ${CHANNEL_ID} not found or not text-based. Is the bot in that server?`);
  }

  const label = LABEL_OVERRIDE || server.current_server_name || `Server ${server.server_id}`;
  monitor.row = await upsertMonitor(channel.guildId, CHANNEL_ID, label, [server.server_id]);

  console.log(`[BOT] Pinned to ${ip}:${port} (server_id=${server.server_id}) in channel ${CHANNEL_ID}. Label: "${label}".`);
}

client.once('ready', async () => {
  console.log(`[BOT] Logged in as ${client.user.tag}`);

  try {
    await testConnection();
    console.log('[DB] Connection verified.');
  } catch (err) {
    console.warn('[DB] Initial check failed:', err.message, '— will retry on first poll.');
  }

  try {
    await bootstrap();
  } catch (err) {
    console.error('[BOT]', err.message);
    process.exit(1);
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

client.login(process.env.DISCORD_TOKEN);
