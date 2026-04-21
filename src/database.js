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

// pg returns BIGINT[] columns as arrays of strings; coerce to numbers.
function normaliseMonitor(row) {
  if (!row) return null;
  return {
    ...row,
    server_ids: Array.isArray(row.server_ids) ? row.server_ids.map(Number) : [],
  };
}

// ── Game server queries ───────────────────────────────────────────────────────

async function fetchServers(serverIds = []) {
  const params = [];
  let serverFilter = '';

  if (Array.isArray(serverIds) && serverIds.length > 0) {
    const ids = serverIds.map(Number).filter(Number.isFinite);
    if (ids.length > 0) {
      params.push(ids);
      serverFilter = `AND server_id = ANY($1::BIGINT[])`;
    }
  }

  const { rows } = await pool.query(
    `SELECT
       server_id,
       host(ip)             AS ip,
       port,
       current_game_port,
       current_server_name,
       current_map,
       current_player_count,
       current_max_players,
       current_gametype,
       current_state,
       last_successful_poll
     FROM servers
     WHERE is_blacklisted = false
       AND current_state IN ('ACTIVE', 'EMPTY')
       ${serverFilter}
     ORDER BY current_player_count DESC, current_server_name ASC`,
    params
  );

  return rows;
}

async function fetchLivePlayers(serverIp, serverPort) {
  if (!serverIp || !serverPort) return [];
  const { rows } = await pool.query(
    `SELECT player_name, score, kills, deaths, ping, team
     FROM live_player_snapshot
     WHERE server_ip = $1::inet AND server_port = $2
     ORDER BY score DESC NULLS LAST, kills DESC NULLS LAST`,
    [serverIp, serverPort]
  );
  return rows;
}

async function fetchLiveSnapshot(serverIp, serverPort) {
  if (!serverIp || !serverPort) return null;
  const { rows } = await pool.query(
    `SELECT tickets1, tickets2, round_time_remain, roundtime,
            gametype, gamemode, has_password, snapshot_time
     FROM live_server_snapshot
     WHERE server_ip = $1::inet AND server_port = $2`,
    [serverIp, serverPort]
  );
  return rows[0] ?? null;
}

async function findServerByAddress(ip, port) {
  const { rows } = await pool.query(
    `SELECT server_id, current_server_name, host(ip) AS ip, port
     FROM servers
     WHERE host(ip) = $1 AND port = $2
     LIMIT 1`,
    [ip, port]
  );
  return rows[0] ?? null;
}

// ── Monitor row ───────────────────────────────────────────────────────────────

async function upsertMonitor(guildId, channelId, label, serverIds) {
  const { rows } = await pool.query(
    `INSERT INTO discord_monitors (guild_id, channel_id, label, server_ids)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (channel_id)
     DO UPDATE SET guild_id = EXCLUDED.guild_id,
                   label = EXCLUDED.label,
                   server_ids = EXCLUDED.server_ids
     RETURNING *`,
    [guildId, channelId, label, serverIds]
  );
  return normaliseMonitor(rows[0]);
}

async function updateMonitorMessage(channelId, messageId) {
  await pool.query(
    'UPDATE discord_monitors SET message_id = $1 WHERE channel_id = $2',
    [messageId, channelId]
  );
}

module.exports = {
  testConnection,
  fetchServers,
  fetchLivePlayers,
  fetchLiveSnapshot,
  findServerByAddress,
  upsertMonitor,
  updateMonitorMessage,
};
