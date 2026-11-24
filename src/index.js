require('dotenv').config();

const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const {
  pool, testConnection, fetchServers, fetchServerById, fetchLivePlayers, fetchLiveSnapshot,
  fetchLastRound, fetchRecentMaps, fetchTodayStats, findServerByAddress, upsertMonitor,
  updateMonitorMessage, ensureSchema, recordPeak,
} = require('./database');
const { buildStatusEmbeds, buildErrorEmbed, buildBotOfflineEmbed, buildPresenceText } = require('./embed');

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
// Longest the Last round / Today card goes without being re-queried.
const EXTRAS_TTL_MS      = 5 * 60_000;
// How long shutdown waits for the "bot offline" edit before giving up.
const SHUTDOWN_EDIT_MS   = 5_000;

// Timezone for the "Today" line (when today's peak and counts reset).
const STATS_TIMEZONE     = process.env.STATS_TIMEZONE || 'UTC';
try {
  new Intl.DateTimeFormat('en', { timeZone: STATS_TIMEZONE });
} catch {
  console.error(`[CONFIG] STATS_TIMEZONE "${STATS_TIMEZONE}" is not a valid IANA timezone (e.g. America/New_York).`);
  process.exit(1);
}
const TODAY_LABEL = STATS_TIMEZONE === 'UTC' ? 'Today (UTC)' : 'Today';

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
  peakEnabled: false, extras: null, timer: null, shuttingDown: false,
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

async function publish(embeds) {
  // Compare without the timestamp, which is "now" on every build.
  const fingerprint = JSON.stringify(embeds.map((e) => {
    const { timestamp, ...content } = e.toJSON();
    return content;
  }));
  const fresh = Date.now() - monitor.lastEditAt < FORCE_REFRESH_MS;
  if (monitor.messageId && fingerprint === monitor.lastEmbed && fresh) return;
  // Don't overwrite the "bot offline" notice with a tick that was mid-flight.
  if (monitor.shuttingDown) return;

  const channel = await fetchChannel();

  if (monitor.messageId) {
    try {
      await channel.messages.edit(monitor.messageId, { embeds });
      monitor.lastEmbed = fingerprint;
      monitor.lastEditAt = Date.now();
      return;
    } catch (err) {
      if (err.code !== 10008) throw err;
      console.warn('[BOT] Status message deleted externally; posting a new one.');
    }
  }

  const message = await channel.send({ embeds });
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

// Last round + today's numbers. Each part fails on its own so a problem here
// never replaces the live status with the "Database Unreachable" embed.
async function loadExtras(serverId, count) {
  const [lastRound, recentMaps, today, peak] = await Promise.all([
    fetchLastRound(serverId).catch((err) => { console.error('[DB] last round:', err.message); return null; }),
    fetchRecentMaps(serverId).catch((err) => { console.error('[DB] recent maps:', err.message); return []; }),
    fetchTodayStats(serverId, STATS_TIMEZONE).catch((err) => { console.error('[DB] today:', err.message); return null; }),
    monitor.peakEnabled
      ? recordPeak(CHANNEL_ID, count, STATS_TIMEZONE).catch((err) => { console.error('[DB] peak:', err.message); return null; })
      : null,
  ]);
  return {
    lastRound,
    recentMaps,
    today: today ? { ...today, peak } : null,
    todayLabel: TODAY_LABEL,
  };
}

// The extras only change when a round ends, so they're re-queried when the
// map changes (and once more on the next tick, in case the engine hadn't
// written the finished round yet) or every EXTRAS_TTL_MS. In between, the
// peak is written only when the live count beats it.
async function fetchExtras(server, count) {
  const cache      = monitor.extras;
  const mapChanged = cache != null && server.current_map !== cache.map;
  if (!cache || mapChanged || cache.recheck || Date.now() - cache.at >= EXTRAS_TTL_MS) {
    const value = await loadExtras(server.server_id, count);
    monitor.extras = { value, at: Date.now(), map: server.current_map, recheck: mapChanged };
    return value;
  }

  const today = cache.value.today;
  if (monitor.peakEnabled && today && count > (today.peak ?? 0)) {
    const peak = await recordPeak(CHANNEL_ID, count, STATS_TIMEZONE)
      .catch((err) => { console.error('[DB] peak:', err.message); return null; });
    if (peak != null) today.peak = peak;
  }
  return cache.value;
}

async function buildCurrentEmbed() {
  const serverIds = monitor.row.server_ids ?? [];
  const label     = monitor.row.label;
  try {
    const servers = await fetchServers(serverIds);
    const s = servers[0] ?? null;
    if (s) {
      const [players, snapshot, extras] = await Promise.all([
        fetchLivePlayers(s.ip, s.port), fetchLiveSnapshot(s.ip, s.port), fetchExtras(s, s.current_player_count ?? 0),
      ]);
      return { embeds: buildStatusEmbeds(servers, label, serverIds, players, snapshot, extras), servers, snapshot };
    }

    // Not ACTIVE/EMPTY: show when it was last seen, plus the last round.
    const offline = serverIds.length > 0 ? await fetchServerById(serverIds[0]) : null;
    const extras  = offline ? await fetchExtras(offline, 0) : {};
    return { embeds: buildStatusEmbeds(servers, label, serverIds, [], null, extras, offline), servers, snapshot: null };
  } catch (err) {
    console.error('[DB]', err.message);
    return { embeds: [buildErrorEmbed(monitor.row.label)], servers: [], snapshot: null };
  }
}

async function tick() {
  if (monitor.busy || monitor.shuttingDown) return;
  monitor.busy = true;

  try {
    if (!monitor.row) await bootstrap();
    const { embeds, servers, snapshot } = await buildCurrentEmbed();
    await publish(embeds);
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

  try {
    await ensureSchema();
    monitor.peakEnabled = true;
  } catch (err) {
    console.warn('[DB] Could not add peak columns to discord_monitors; today\'s peak is disabled:', err.message);
  }

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
  monitor.timer = setInterval(tick, POLL_INTERVAL_MS);
  console.log(`[BOT] Polling every ${POLL_INTERVAL_MS / 1000}s. Ready.`);
});

// ── Error handling ────────────────────────────────────────────────────────────

client.on('error', (err) => console.error('[DISCORD] Client error:', err.message));
process.on('unhandledRejection', (err) => console.error('[PROCESS] Unhandled rejection:', err));

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal) {
  if (monitor.shuttingDown) return;
  monitor.shuttingDown = true;
  clearInterval(monitor.timer);
  console.log(`[BOT] ${signal} received — shutting down.`);

  // Mark the message so nobody trusts a frozen embed. Capped so a slow or
  // unreachable Discord can't hold up the stop.
  if (monitor.messageId && client.isReady()) {
    const label = monitor.row?.label || LABEL_OVERRIDE || 'BF1942 Server Status';
    const edit  = fetchChannel().then((channel) =>
      channel.messages.edit(monitor.messageId, { embeds: [buildBotOfflineEmbed(label)] }));
    try {
      await Promise.race([edit, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_EDIT_MS))]);
    } catch (err) {
      console.warn('[BOT] Could not mark the status message offline:', err.message);
    }
  }

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
