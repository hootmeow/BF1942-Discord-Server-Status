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

function buildPlayerBar(current, max) {
  if (!max || max === 0) return `${current}/0`;
  const filled = Math.round((current / max) * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + `  ${current}/${max}`;
}

// ── Error embed ───────────────────────────────────────────────────────────────

function buildErrorEmbed(label, errorMessage) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`⚠️ ${label} — Database Unreachable`)
    .setDescription(
      `The stats database could not be reached.\n\`\`\`${errorMessage}\`\`\`\nServer data will resume automatically when the connection is restored.`
    )
    .setURL('https://bf1942.online')
    .setFooter({ text: 'Powered by bf1942.online' })
    .setTimestamp();
}

// ── Single-server embed (used when the monitor is filtered to one server) ─────

// Format seconds → "MM:SS". Returns null if no time data.
function formatTimeRemaining(seconds) {
  if (seconds == null || seconds < 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Render one team's scoreboard as a full-width monospace block.
// Column widths tuned for Discord desktop + mobile (~40 char line fits both).
function renderTeamScoreboard(teamPlayers) {
  if (teamPlayers.length === 0) return '```\n— no players —\n```';

  // Header: Name (18) | Score (5) | K (3) | D (3) | Ping (4)
  const header = 'Player             Score   K    D  Ping';
  const sep    = '─────────────────────────────────────────';
  const lines  = [header, sep];

  for (const p of teamPlayers) {
    const name  = (p.player_name || '').slice(0, 18).padEnd(18);
    const score = String(p.score ?? 0).padStart(5);
    const k     = String(p.kills  ?? 0).padStart(3);
    const d     = String(p.deaths ?? 0).padStart(3);
    const ping  = String(p.ping   ?? 0).padStart(4);
    lines.push(`${name} ${score} ${k}  ${d}  ${ping}`);
  }

  let body = lines.join('\n');
  if (body.length > 1000) body = body.slice(0, 997) + '...';
  return '```\n' + body + '\n```';
}

function buildSingleServerEmbed(server, label, players = [], snapshot = null) {
  const title = `🎖️  ${label}`;

  if (!server) {
    return new EmbedBuilder()
      .setColor(0x747f8d)
      .setTitle(title)
      .setURL('https://bf1942.online')
      .setDescription('⚫  Server is currently offline or not found.')
      .setFooter({ text: 'Powered by bf1942.online' })
      .setTimestamp();
  }

  const count    = server.current_player_count ?? 0;
  const max      = server.current_max_players  ?? 0;
  const map      = formatMap(server.current_map);
  const gt       = formatGametype(server.current_gametype || snapshot?.gametype);
  const name     = server.current_server_name || 'Unknown Server';
  // Join address uses the GAME port (current_game_port), not the query port.
  const joinPort = server.current_game_port || server.port;
  const joinAddr = joinPort ? `${server.ip}:${joinPort}` : server.ip;
  const isOnline = count > 0;

  const statusIcon = isOnline ? '🟢' : '⚪';
  const statusText = isOnline ? 'Online' : 'Empty';
  const timeLeft   = formatTimeRemaining(snapshot?.round_time_remain);

  // Header line: status · gametype · time remaining
  const headerBits = [`${statusIcon}  **${statusText}**`];
  if (gt) headerBits.push(gt);
  if (timeLeft) headerBits.push(`⏱️  ${timeLeft}`);
  const headerLine = headerBits.join('  ·  ');

  const alliedTickets = snapshot?.tickets1;
  const axisTickets   = snapshot?.tickets2;

  const descLines = [
    headerLine,
    '',
    `**${name}**`,
    `📡  \`${joinAddr}\`   ·   🗺️  ${map}`,
    '',
    `\`${buildPlayerBar(count, max)}\``,
  ];

  const embed = new EmbedBuilder()
    .setColor(isOnline ? 0x57f287 : 0xfee75c)
    .setTitle(title)
    .setURL('https://bf1942.online')
    .setDescription(descLines.join('\n'))
    .setFooter({ text: 'Powered by bf1942.online' })
    .setTimestamp();

  if (players && players.length > 0) {
    const allied = players.filter(p => p.team === 1);
    const axis   = players.filter(p => p.team === 2);
    const other  = players.filter(p => p.team !== 1 && p.team !== 2);

    const alliedLabel = alliedTickets != null
      ? `🔵  Allied — ${allied.length} player${allied.length === 1 ? '' : 's'} · ${alliedTickets} tickets`
      : `🔵  Allied — ${allied.length} player${allied.length === 1 ? '' : 's'}`;
    const axisLabel = axisTickets != null
      ? `🔴  Axis — ${axis.length} player${axis.length === 1 ? '' : 's'} · ${axisTickets} tickets`
      : `🔴  Axis — ${axis.length} player${axis.length === 1 ? '' : 's'}`;

    // inline:false → each team gets its own full-width row. Easier to read
    // than side-by-side columns, especially on mobile.
    embed.addFields(
      { name: alliedLabel, value: renderTeamScoreboard(allied), inline: false },
      { name: axisLabel,   value: renderTeamScoreboard(axis),   inline: false },
    );
    if (other.length > 0) {
      embed.addFields({
        name: `⚪  Unassigned — ${other.length}`,
        value: renderTeamScoreboard(other), inline: false,
      });
    }
  }

  return embed;
}

// ── Multi-server embed (all servers, or a multi-server filter) ─────────────────

function buildMultiServerEmbed(servers, label, isFiltered) {
  const totalPlayers = servers.reduce((sum, s) => sum + (s.current_player_count || 0), 0);
  const active = servers.filter(s => (s.current_player_count || 0) > 0);
  const empty  = servers.filter(s => (s.current_player_count || 0) === 0);

  let color;
  if (servers.length === 0)   color = 0x5865f2;
  else if (active.length > 0) color = 0x57f287;
  else                         color = 0xfee75c;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🎖️ ${label}`)
    .setURL('https://bf1942.online')
    .setFooter({ text: 'Powered by bf1942.online' })
    .setTimestamp();

  if (servers.length === 0) {
    embed.setDescription('No servers found. Check back later, soldier.');
    return embed;
  }

  const lines = [];

  // Active servers — one clean line each
  const MAX_ACTIVE = 20;
  for (const s of active.slice(0, MAX_ACTIVE)) {
    const name    = (s.current_server_name || `Server ${s.server_id}`).slice(0, 45);
    const map     = formatMap(s.current_map);
    const players = s.current_player_count ?? 0;
    const max     = s.current_max_players ?? 0;
    lines.push(`🟢  **${name}** — ${map} — ${players}/${max}`);
  }
  if (active.length > MAX_ACTIVE) {
    lines.push(`*…and ${active.length - MAX_ACTIVE} more active servers*`);
  }

  // Empty servers
  if (empty.length > 0) {
    if (isFiltered) {
      // Filtered view: show each empty server individually
      for (const s of empty) {
        const name = (s.current_server_name || `Server ${s.server_id}`).slice(0, 45);
        const map  = formatMap(s.current_map);
        const max  = s.current_max_players ?? 0;
        lines.push(`⚪  **${name}** — ${map} — 0/${max}`);
      }
    } else {
      // Global view: compact summary so it doesn't dominate
      const shown = empty.slice(0, 4).map(s => s.current_server_name || `Server ${s.server_id}`);
      const more  = empty.length > 4 ? ` +${empty.length - 4} more` : '';
      lines.push(`\n⚪  *${empty.length} empty:* ${shown.join(', ')}${more}`);
    }
  }

  // Summary line — no global totals when filtered
  let summary;
  if (isFiltered) {
    const parts = [];
    if (totalPlayers > 0) parts.push(`**${totalPlayers}** player${totalPlayers !== 1 ? 's' : ''} in-game`);
    parts.push(`**${servers.length}** server${servers.length !== 1 ? 's' : ''}`);
    summary = parts.join(' · ');
  } else {
    const parts = [];
    if (totalPlayers > 0) parts.push(`**${totalPlayers}** in-game`);
    parts.push(`**${active.length}** active`);
    if (empty.length > 0) parts.push(`**${empty.length}** empty`);
    summary = parts.join(' · ');
  }

  let body = lines.join('\n');
  if (body.length > 3800) body = body.slice(0, 3797) + '…';

  embed.setDescription(summary + (body.length ? '\n\n' + body : ''));
  return embed;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * @param {object[]} servers   - Rows from fetchServers()
 * @param {string}   label     - Embed title label
 * @param {number[]} serverIds - Active filter; empty = show all
 */
function buildStatusEmbed(servers, label, serverIds = [], players = [], snapshot = null) {
  if (serverIds.length === 1) {
    return buildSingleServerEmbed(servers[0] ?? null, label, players, snapshot);
  }
  return buildMultiServerEmbed(servers, label, serverIds.length > 0);
}

// Dedupe by server_id so a server tracked by multiple monitors isn't counted twice.
function buildPresenceText(allServers) {
  const unique = new Map();
  for (const s of allServers) {
    if (s && s.server_id != null && !unique.has(s.server_id)) unique.set(s.server_id, s);
  }
  const servers = [...unique.values()];

  if (servers.length === 0) return 'No active games';

  if (servers.length === 1) {
    const s = servers[0];
    const players = s.current_player_count || 0;
    const max = s.current_max_players || 0;
    const map = formatMap(s.current_map);
    if (players === 0) return `Empty · ${map}`;
    return `${players}/${max} · ${map}`;
  }

  const totalPlayers = servers.reduce((sum, s) => sum + (s.current_player_count || 0), 0);
  const active = servers.filter(s => (s.current_player_count || 0) > 0).length;
  if (totalPlayers === 0) return `${servers.length} servers · empty`;
  return `${totalPlayers} players · ${active} active servers`;
}

module.exports = { buildStatusEmbed, buildErrorEmbed, buildPresenceText };
