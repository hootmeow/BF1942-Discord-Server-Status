const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => console.error('[DB] Pool error:', err.message));

async function testConnection() {
  const client = await pool.connect();
  client.release();
}

// ── Game server queries ───────────────────────────────────────────────────────

async function fetchServers(serverIds = []) {
  const staleMinutes = parseInt(process.env.SERVER_STALE_MINUTES || '10');
  const conditions = [
    'is_blacklisted = false',
    `last_successful_poll > NOW() - ($1 || ' minutes')::INTERVAL`,
  ];
  const params = [staleMinutes];

  if (serverIds.length > 0) {
    params.push(serverIds);
    conditions.push(`server_id = ANY($${params.length})`);
  }

  const { rows } = await pool.query(`
    SELECT
      server_id,
      ip::text             AS ip,
      current_server_name,
      current_map,
      current_player_count,
      current_max_players,
      current_gametype,
      current_state,
      last_successful_poll
    FROM servers
    WHERE ${conditions.join(' AND ')}
    ORDER BY current_player_count DESC, current_server_name ASC
  `, params);

  return rows;
}

// Returns all known non-blacklisted servers — used for autocomplete in slash commands.
async function getServerList() {
  const { rows } = await pool.query(`
    SELECT server_id, current_server_name, ip::text AS ip
    FROM servers
    WHERE is_blacklisted = false
    ORDER BY current_server_name ASC
    LIMIT 25
  `);
  return rows;
}

// ── Monitor CRUD ──────────────────────────────────────────────────────────────

async function getAllMonitors() {
  const { rows } = await pool.query('SELECT * FROM discord_monitors ORDER BY created_at ASC');
  return rows;
}

async function getMonitor(channelId) {
  const { rows } = await pool.query(
    'SELECT * FROM discord_monitors WHERE channel_id = $1',
    [channelId]
  );
  return rows[0] ?? null;
}

async function createMonitor(guildId, channelId, label) {
  const { rows } = await pool.query(`
    INSERT INTO discord_monitors (guild_id, channel_id, label)
    VALUES ($1, $2, $3)
    RETURNING *
  `, [guildId, channelId, label]);
  return rows[0];
}

async function deleteMonitor(channelId) {
  const { rows } = await pool.query(
    'DELETE FROM discord_monitors WHERE channel_id = $1 RETURNING *',
    [channelId]
  );
  return rows[0] ?? null;
}

async function updateMonitorMessage(channelId, messageId) {
  await pool.query(
    'UPDATE discord_monitors SET message_id = $1 WHERE channel_id = $2',
    [messageId, channelId]
  );
}

async function updateMonitorServerIds(channelId, serverIds) {
  const { rows } = await pool.query(
    'UPDATE discord_monitors SET server_ids = $1 WHERE channel_id = $2 RETURNING *',
    [serverIds, channelId]
  );
  return rows[0] ?? null;
}

module.exports = {
  testConnection,
  fetchServers,
  getServerList,
  getAllMonitors,
  getMonitor,
  createMonitor,
  deleteMonitor,
  updateMonitorMessage,
  updateMonitorServerIds,
};
