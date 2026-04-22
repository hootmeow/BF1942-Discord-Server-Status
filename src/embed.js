const { EmbedBuilder } = require('discord.js');

const MAP_DISPLAY = {
  'berlin':               'Berlin',
  'bocage':               'Bocage',
  'coral_sea':            'Battle of Coral Sea',
  'el_alamein':           'El Alamein',
  'fall_of_tobruk':       'Fall of Tobruk',
  'gazala':               'Gazala',
  'guadalcanal':          'Guadalcanal',
  'iwo_jima':             'Iwo Jima',
  'kursk':                'Kursk',
  'liberation_of_caen':   'Liberation of Caen',
  'market_garden':        'Market Garden',
  'midway':               'Midway',
  'moscow':               'Battle of Moscow',
  'operation_aberdeen':   'Operation Aberdeen',
  'operation_battleaxe':  'Operation Battleaxe',
  'operation_crusader':   'Operation Crusader',
  'operation_overlord':   'Operation Overlord',
  'roads_to_rome':        'Roads to Rome',
  'stalingrad':           'Stalingrad',
  'the_great_wall':       'The Great Wall',
  'tobruk':               'Tobruk',
};

const BF1942_URL = 'https://bf1942.online';
const BAR_WIDTH  = 12;
// The live poller refreshes snapshots ~every minute. If the newest row is
// older than this, the poller is probably wedged — show a warning.
const STALE_SNAPSHOT_MS = 180_000; // 3 minutes

function formatMap(rawMap) {
  if (!rawMap) return 'Unknown';
  const key = rawMap.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return MAP_DISPLAY[key] ?? rawMap.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatGametype(gt) {
  if (!gt) return '';
  const types = { conquest: 'Conquest', coop: 'Co-op', ctf: 'CTF' };
  return types[gt.toLowerCase()] ?? gt;
}

function formatTimeRemaining(seconds) {
  if (seconds == null || seconds < 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function buildPlayerBar(current, max) {
  if (!max || max === 0) return `${current}/0`;
  const filled = Math.round((current / max) * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled) + `  ${current}/${max}`;
}

function fillColor(count, max) {
  if (!max || count === 0) return 0x747f8d;
  const pct = count / max;
  if (pct <= 0.25) return 0xfee75c;
  if (pct <= 0.50) return 0xf97316;
  if (pct <= 0.75) return 0x3ba55d;
  return 0x57f287;
}


function isSnapshotStale(snapshot) {
  if (!snapshot?.snapshot_time) return false;
  const age = Date.now() - new Date(snapshot.snapshot_time).getTime();
  return age > STALE_SNAPSHOT_MS;
}

// ── Error embed ───────────────────────────────────────────────────────────────

function buildErrorEmbed(label, errorMessage) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`⚠️  ${label} — Database Unreachable`)
    .setURL(BF1942_URL)
    .setDescription(
      `The stats database could not be reached.\n\`\`\`${errorMessage}\`\`\`\nServer data will resume automatically when the connection is restored.`
    )
    .setFooter({ text: 'Powered by bf1942.online' })
    .setTimestamp();
}

// ── Scoreboard rendering ──────────────────────────────────────────────────────

// Fixed-width columns: Name(16) Score(5) K(3) D(3) Ping(4). Total ~39 chars —
// fits comfortably on Discord mobile without wrapping.
function renderTeamScoreboard(teamPlayers) {
  if (teamPlayers.length === 0) return '```\n— no players —\n```';

  const header = 'Player                   Score   K   D  Ping';
  const sep    = '────────────────────────────────────────────';
  const lines  = [header, sep];

  for (const p of teamPlayers) {
    const name  = (p.player_name || '').slice(0, 24).padEnd(24);
    const score = String(p.score ?? 0).padStart(5);
    const k     = String(p.kills  ?? 0).padStart(3);
    const d     = String(p.deaths ?? 0).padStart(3);
    const ping  = String(p.ping   ?? 0).padStart(4);
    lines.push(`${name} ${score} ${k} ${d}  ${ping}`);
  }

  let body = lines.join('\n');
  if (body.length > 1000) body = body.slice(0, 997) + '...';
  return '```\n' + body + '\n```';
}

// ── Main single-server embed ──────────────────────────────────────────────────

function buildStatusEmbed(servers, label, _serverIds = [], players = [], snapshot = null) {
  const title  = `🎖️  ${label}`;
  const server = servers[0] ?? null;

  if (!server) {
    return new EmbedBuilder()
      .setColor(0x747f8d)
      .setTitle(title)
      .setURL(BF1942_URL)
      .setDescription('⚫  Server is currently offline or not found.')
      .setFooter({ text: 'Powered by bf1942.online' })
      .setTimestamp();
  }

  const count    = server.current_player_count ?? 0;
  const max      = server.current_max_players  ?? 0;
  const map      = formatMap(server.current_map);
  const gt       = formatGametype(server.current_gametype || snapshot?.gametype);
  const name     = server.current_server_name || 'Unknown Server';
  const joinPort = server.current_game_port || server.port;
  const joinAddr = joinPort ? `${server.ip}:${joinPort}` : server.ip;
  const isOnline = count > 0;
  const locked   = snapshot?.has_password === 1;
  const timeLeft = formatTimeRemaining(snapshot?.round_time_remain);
  const stale    = isSnapshotStale(snapshot);

  // Header: status · 🔒 (if locked) · ⚠️ (if stale)
  const headerBits = [`**Server:** ${isOnline ? '🟢' : '⚪'}  **${isOnline ? 'Online' : 'Empty'}**`];
  if (locked) headerBits.push('🔒  Password');
  if (stale)  headerBits.push('⚠️  Stale data');
  const headerLine = headerBits.join('  ·  ');

  const alliedTickets = snapshot?.tickets1;
  const axisTickets   = snapshot?.tickets2;

  const descLines = [
    headerLine,
    '',
    `📡  \`${joinAddr}\``,
    '',
    `👥  \`${buildPlayerBar(count, max)}\``,
  ];

  const serverUrl = `${BF1942_URL}/servers/${server.server_id}`;

  const embed = new EmbedBuilder()
    .setColor(fillColor(count, max))
    .setTitle(title)
    .setURL(serverUrl)
    .setDescription(descLines.join('\n'))
    .setFooter({ text: 'Powered by bf1942.online  ·  Last Update', iconURL: 'https://bf1942.online/favicon.ico' })
    .setTimestamp();

  // Inline info fields: map, mode, time remaining
  const infoFields = [
    { name: '🗺️  Map',  value: map, inline: true },
  ];
  if (gt)       infoFields.push({ name: '⚔️  Mode',      value: gt,               inline: true });
  if (timeLeft) infoFields.push({ name: '⏱️  Time left', value: timeLeft,          inline: true });
  embed.addFields(infoFields);

  if (players && players.length > 0) {
    const allied = players.filter(p => p.team === 1);
    const axis   = players.filter(p => p.team === 2);
    const other  = players.filter(p => p.team !== 1 && p.team !== 2);

    const fmtLabel = (color, side, roster, tickets) => {
      const count = `${roster.length} player${roster.length === 1 ? '' : 's'}`;
      return tickets != null
        ? `${color}  ${side} — ${count} · ${tickets} tickets`
        : `${color}  ${side} — ${count}`;
    };

    embed.addFields(
      { name: fmtLabel('🔵', 'Allied', allied, alliedTickets),
        value: renderTeamScoreboard(allied), inline: false },
      { name: fmtLabel('🔴', 'Axis',   axis,   axisTickets),
        value: renderTeamScoreboard(axis),   inline: false },
    );
    if (other.length > 0) {
      embed.addFields({
        name: `⚪  Unassigned — ${other.length}`,
        value: renderTeamScoreboard(other),
        inline: false,
      });
    }
  }

  return embed;
}

// ── Bot presence line (shown under the bot's name in the member list) ────────

function buildPresenceText(servers) {
  const s = servers[0];
  if (!s) return 'Offline';
  const players = s.current_player_count || 0;
  const max     = s.current_max_players  || 0;
  const map     = formatMap(s.current_map);
  if (players === 0) return `Empty · ${map}`;
  return `${players}/${max} · ${map}`;
}

module.exports = { buildStatusEmbed, buildErrorEmbed, buildPresenceText };
