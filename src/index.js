require('dotenv').config();

const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { testConnection, fetchServers, getAllMonitors, updateMonitorMessage } = require('./database');
const { buildStatusEmbed, buildErrorEmbed, buildPresenceText } = require('./embed');
const { registerCommands } = require('./commands');
const { createInteractionHandler } = require('./interactions');

// ── Env validation ────────────────────────────────────────────────────────────

const REQUIRED_ENV = ['DISCORD_TOKEN', 'DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) { console.error(`[CONFIG] Missing env var: ${key}`); process.exit(1); }
}

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000');

// ── Discord client ────────────────────────────────────────────────────────────

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// monitorCache: Map<channelId, { row: dbRow, message: Message|null, busy: boolean }>
const monitorCache = new Map();

// ── Per-entry helpers ─────────────────────────────────────────────────────────

async function ensureMessage(channelId) {
  const entry = monitorCache.get(channelId);
  if (!entry || entry.message) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  if (entry.row.message_id) {
    try {
      entry.message = await channel.messages.fetch(entry.row.message_id);
      return;
    } catch {
      // Message is gone — fall through to send a new one
    }
  }

  let embed;
  try {
    const servers = await fetchServers(entry.row.server_ids ?? []);
    embed = buildStatusEmbed(servers, entry.row.label);
  } catch (err) {
    embed = buildErrorEmbed(entry.row.label, err.message);
  }

  entry.message = await channel.send({ embeds: [embed] });
  await updateMonitorMessage(channelId, entry.message.id);
  entry.row.message_id = entry.message.id;
  console.log(`[${channelId}] Sent new status message (${entry.message.id})`);
}

async function updateEntry(channelId) {
  const entry = monitorCache.get(channelId);
  if (!entry || entry.busy || !entry.message) return null;
  entry.busy = true;

  let servers = [];
  let embed;

  try {
    servers = await fetchServers(entry.row.server_ids ?? []);
    embed = buildStatusEmbed(servers, entry.row.label);
  } catch (err) {
    console.error(`[${channelId}] DB error: ${err.message}`);
    embed = buildErrorEmbed(entry.row.label, err.message);
  }

  try {
    await entry.message.edit({ embeds: [embed] });
  } catch (err) {
    if (err.code === 10008) {
      // Message deleted externally — will recreate on next poll
      console.warn(`[${channelId}] Status message deleted externally. Will recreate next tick.`);
      entry.message = null;
      await updateMonitorMessage(channelId, null);
    } else if (err.code === 429) {
      console.warn(`[${channelId}] Rate limited — skipping tick.`);
    } else {
      console.error(`[${channelId}] Edit failed: ${err.message}`);
    }
  }

  entry.busy = false;
  return servers;
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollAll() {
  const channelIds = [...monitorCache.keys()];
  await Promise.all(channelIds.map(ensureMessage));
  const results = await Promise.all(channelIds.map(updateEntry));

  const allServers = results.flat().filter(Boolean);
  client.user.setPresence({
    activities: [{ name: buildPresenceText(allServers), type: ActivityType.Watching }],
    status: 'online',
  });
}

// Triggered by slash commands after a filter change so the embed updates immediately.
async function triggerUpdate(channelId) {
  await ensureMessage(channelId);
  await updateEntry(channelId);
}

// ── Ready ─────────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`[BOT] Logged in as ${client.user.tag}`);

  try {
    await testConnection();
    console.log('[DB] Connection verified.');
  } catch (err) {
    console.warn('[DB] Initial check failed:', err.message, '— will retry on first poll.');
  }

  // Register slash commands
  try {
    await registerCommands(client.user.id, process.env.DISCORD_TOKEN);
  } catch (err) {
    console.error('[CMD] Failed to register slash commands:', err.message);
  }

  // Load monitors from DB and populate cache
  const monitors = await getAllMonitors().catch(() => []);
  for (const row of monitors) {
    monitorCache.set(row.channel_id, { row, message: null, busy: false });
  }
  console.log(`[BOT] Loaded ${monitors.length} monitor(s) from database.`);

  await pollAll();
  setInterval(pollAll, POLL_INTERVAL_MS);
  console.log(`[BOT] Polling every ${POLL_INTERVAL_MS / 1000}s. Ready.`);
});

// ── Interaction handling ──────────────────────────────────────────────────────

const handleInteraction = createInteractionHandler(monitorCache, triggerUpdate);
client.on('interactionCreate', handleInteraction);

// ── Error handling ────────────────────────────────────────────────────────────

client.on('error', (err) => console.error('[DISCORD] Client error:', err.message));
process.on('unhandledRejection', (err) => console.error('[PROCESS] Unhandled rejection:', err));

client.login(process.env.DISCORD_TOKEN);
