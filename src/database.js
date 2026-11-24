const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // Shows up in pg_stat_activity so these connections can be told apart.
  application_name: 'bf1942-discord-status',
  // A tick fires up to 6 short queries at once; extras wait for a free
  // connection rather than opening more.
  max: 3,
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

// Most recent finished round on the server plus its top scorer.
// Uses idx_rounds_server_id_start_time; the MVP lookup hits the
// round_player_stats primary key.
async function fetchLastRound(serverId) {
  const { rows } = await pool.query(
    `SELECT r.round_id, r.map_name, r.winner_team, r.duration_seconds, r.end_time,
            mvp.player_name AS mvp_name, mvp.score AS mvp_score
     FROM (SELECT round_id, map_name, winner_team, duration_seconds, end_time
           FROM rounds
           WHERE server_id = $1 AND end_time IS NOT NULL
           ORDER BY start_time DESC
           LIMIT 1) r
     LEFT JOIN LATERAL (
       SELECT p.canonical_name AS player_name, rps.final_score AS score
       FROM round_player_stats rps
       JOIN players p ON p.player_id = rps.player_id
       WHERE rps.round_id = r.round_id
       ORDER BY rps.final_score DESC NULLS LAST
       LIMIT 1
     ) mvp ON true`,
    [serverId]
  );
  return rows[0] ?? null;
}

// Rounds finished today and distinct players in them; "today" is local to tz.
async function fetchTodayStats(serverId, tz) {
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT r.round_id)::int  AS rounds,
            COUNT(DISTINCT rps.player_id)::int AS players
     FROM rounds r
     LEFT JOIN round_player_stats rps ON rps.round_id = r.round_id
     WHERE r.server_id = $1
       AND r.start_time >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2`,
    [serverId, tz]
  );
  return rows[0] ?? { rounds: 0, players: 0 };
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

// Columns added after the original setup.sql; safe to run on every start.
async function ensureSchema() {
  await pool.query(
    `ALTER TABLE discord_monitors
       ADD COLUMN IF NOT EXISTS peak_players SMALLINT,
       ADD COLUMN IF NOT EXISTS peak_date    DATE`
  );
}

// The engine keeps no concurrent-player history in Postgres, so the bot
// records the highest count it has seen today. Persisted so a restart
// doesn't reset it; resets when the date (in tz) changes.
async function recordPeak(channelId, count, tz) {
  const { rows } = await pool.query(
    `UPDATE discord_monitors
     SET peak_players = CASE WHEN peak_date = (now() AT TIME ZONE $3)::date
                             THEN GREATEST(COALESCE(peak_players, 0), $2)
                             ELSE $2 END,
         peak_date = (now() AT TIME ZONE $3)::date
     WHERE channel_id = $1
     RETURNING peak_players`,
    [channelId, count, tz]
  );
  return rows[0]?.peak_players ?? count;
}

async function updateMonitorMessage(channelId, messageId) {
  await pool.query(
    'UPDATE discord_monitors SET message_id = $1 WHERE channel_id = $2',
    [messageId, channelId]
  );
}

module.exports = {
  pool,
  testConnection,
  fetchServers,
  fetchLivePlayers,
  fetchLiveSnapshot,
  fetchLastRound,
  fetchTodayStats,
  findServerByAddress,
  upsertMonitor,
  updateMonitorMessage,
  ensureSchema,
  recordPeak,
};
