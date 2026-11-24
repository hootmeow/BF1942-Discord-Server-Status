const { EmbedBuilder, escapeMarkdown } = require('discord.js');

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

const BF1942_URL = 'https://captheflag.com/bf1942';
// PNG, not favicon.ico: Discord does not render .ico in embeds.
const FOOTER_ICON = 'https://captheflag.com/apple-icon';
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

// The underlying error is logged by the caller; it is not shown in the public
// channel because it can expose DB host, user and database names.
function buildErrorEmbed(label) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`⚠️  ${label} — Database Unreachable`)
    .setURL(BF1942_URL)
    .setDescription(
      'The stats database could not be reached.\nServer data will resume automatically when the connection is restored.'
    )
    .setFooter({ text: 'Powered by captheflag.com' })
    .setTimestamp();
}

// Discord timestamp markup, e.g. "2 hours ago" in each reader's own clock.
function discordTime(value, style = 'R') {
  return `<t:${Math.floor(new Date(value).getTime() / 1000)}:${style}>`;
}

// ── Offline cards ─────────────────────────────────────────────────────────────

// Game server not ACTIVE/EMPTY. `last` is its servers row in any state (null
// if the row is gone); the engine keeps the last map and player count.
function buildServerOfflineEmbed(label, last) {
  const lines = [];
  if (!last) {
    lines.push('⚫  Server not found in the stats database.');
  } else if (last.is_blacklisted) {
    lines.push('⚫  This server is no longer tracked.');
  } else {
    lines.push('⚫  **Server offline**');
    const seen = [];
    if (last.last_successful_poll) seen.push(`Last seen ${discordTime(last.last_successful_poll)}`);
    if (last.current_map) seen.push(`on ${formatMap(last.current_map)}`);
    if (last.current_player_count > 0) seen.push(plural(last.current_player_count, 'player'));
    if (seen.length) lines.push('', seen.join(' · '));
  }

  return new EmbedBuilder()
    .setColor(0x747f8d)
    .setTitle(`🎖️  ${label}`)
    .setURL(last ? `${BF1942_URL}/servers/${last.server_id}` : BF1942_URL)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Powered by captheflag.com  ·  Last Update', iconURL: FOOTER_ICON })
    .setTimestamp();
}

// Posted on shutdown so a stopped bot doesn't leave a normal-looking embed
// that is quietly out of date.
function buildBotOfflineEmbed(label) {
  return new EmbedBuilder()
    .setColor(0x747f8d)
    .setTitle(`🎖️  ${label}`)
    .setURL(BF1942_URL)
    .setDescription(
      `⚠️  **Status bot offline** since ${discordTime(Date.now())}\n` +
      'This message will update again when the bot is back.'
    )
    .setFooter({ text: 'Powered by captheflag.com', iconURL: FOOTER_ICON });
}

// ── Scoreboard rendering ──────────────────────────────────────────────────────

// Fixed-width columns: Rank(2) Name(24) Score(5) K(3) D(3) Ping(4), 47 chars
// a row. Discord caps a field at 1024 chars; minus the ``` wrapper that leaves
// room for about 20 rows, so a full 32-player team ends in a "+N more" line
// instead of being cut mid-row.
const FIELD_BODY_MAX = 1000;

function renderTeamScoreboard(teamPlayers) {
  if (teamPlayers.length === 0) return '```\n— no players —\n```';

  const header = ' # Player                   Score   K   D  Ping';
  const sep    = '───────────────────────────────────────────────';
  const lines  = [header, sep];
  let length   = header.length + 1 + sep.length;

  for (let i = 0; i < teamPlayers.length; i++) {
    const p     = teamPlayers[i];
    // A backtick in a name could close the ``` block and garble the table.
    const name  = (p.player_name || '').replace(/`/g, "'").slice(0, 24).padEnd(24);
    const score = String(p.score ?? 0).padStart(5);
    const k     = String(p.kills  ?? 0).padStart(3);
    const d     = String(p.deaths ?? 0).padStart(3);
    const ping  = String(p.ping   ?? 0).padStart(4);
    // Rank within the team; players arrive sorted by score.
    const rank  = String(i + 1).padStart(2);
    const row   = `${rank} ${name} ${score} ${k} ${d}  ${ping}`;

    // Keep room for the "+N more" line whenever rows remain after this one.
    const rest     = teamPlayers.length - i - 1;
    const reserve  = rest > 0 ? `\n+${rest} more`.length : 0;
    if (length + 1 + row.length + reserve > FIELD_BODY_MAX) {
      lines.push(`+${teamPlayers.length - i} more`);
      break;
    }
    lines.push(row);
    length += 1 + row.length;
  }

  return '```\n' + lines.join('\n') + '\n```';
}

// ── Summary card: last round, MVP, today ─────────────────────────────────────

// Team 1 is Axis, team 2 Allies (same as the scoreboard and the map-alert bot).
// Colours match the 🔴 / 🔵 team headings.
const TEAMS = {
  1: { name: 'Axis',   color: 0xed4245 },
  2: { name: 'Allies', color: 0x3b82f6 },
};
const DRAW_COLOR = 0x747f8d;

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Text Discord can put inside [text](url) as-is: one level of matched
// brackets (clan tags like =volpi=[duke]) and no markdown characters.
// Backslash escapes are NOT removed inside link text, so escaping would show
// up literally as \[duke\].
const LINKABLE_TEXT = /^(?:\[[^[\]]*\]|[^[\]*_~`|\\<>])+$/;

// Link that survives clan tags. Names that can't sit inside link text are
// shown as escaped plain text followed by a separate ↗ link. Parentheses in
// the URL are encoded so they can't end the link early.
function mdLink(text, url) {
  const href = url.replace(/\(/g, '%28').replace(/\)/g, '%29');
  const str  = String(text);
  return LINKABLE_TEXT.test(str) ? `[${str}](${href})` : `${escapeMarkdown(str)} [↗](${href})`;
}

function lastRoundField(round) {
  const team  = TEAMS[round.winner_team];
  const map   = mdLink(formatMap(round.map_name), `${BF1942_URL}/stats/rounds/${round.round_id}`);
  const lines = [team ? `**${team.name}** won` : '**Draw**', map];
  const when  = [];
  if (round.duration_seconds > 0) when.push(`${Math.round(round.duration_seconds / 60)} min`);
  // Discord renders <t:…:R> as "16 minutes ago" in each reader's own clock.
  if (round.end_time) when.push(`<t:${Math.floor(new Date(round.end_time).getTime() / 1000)}:R>`);
  if (when.length) lines.push(when.join(' · '));
  return { name: '🏁  Last round', value: lines.join('\n'), inline: true };
}

function mvpField(round) {
  return {
    name: '⭐  MVP',
    value: `${mdLink(round.mvp_name, `${BF1942_URL}/player/${encodeURIComponent(round.mvp_name)}`)}\n${round.mvp_score ?? 0} pts`,
    inline: true,
  };
}

function todayField(today, current, label) {
  const lines = [today.peak != null ? `Peak **${today.peak}** · now ${current}` : `Now ${current}`];
  const totals = [];
  if (today.players != null) totals.push(plural(today.players, 'player'));
  if (today.rounds  != null) totals.push(plural(today.rounds, 'round'));
  if (totals.length) lines.push(totals.join(' · '));
  return { name: `📈  ${label || 'Today'}`, value: lines.join('\n'), inline: true };
}

// Second embed under the status one: three side-by-side columns (stacked on
// mobile), striped in the last round's winning team colour. Null when there
// is nothing to show.
// Mean ping of a roster, ignoring 0/missing (bots and players still loading).
function averagePing(roster) {
  const pings = roster.map((p) => p.ping).filter((v) => v > 0);
  if (pings.length === 0) return null;
  return Math.round(pings.reduce((a, b) => a + b, 0) / pings.length);
}

function recentMapsField(maps) {
  // Oldest → newest so it reads like the rotation did; a map played twice in
  // a row (restart, admin re-run) shows once as "×2".
  const runs = [];
  for (const map of maps.slice().reverse().map(formatMap)) {
    const last = runs[runs.length - 1];
    if (last?.map === map) last.n++;
    else runs.push({ map, n: 1 });
  }
  return {
    name: '🗺️  Recent maps',
    value: runs.map((r) => (r.n > 1 ? `${r.map} ×${r.n}` : r.map)).join(' → '),
    inline: true,
  };
}

function winsTodayField(today) {
  return {
    name: '⚔️  Wins today',
    value: `🔴 Axis **${today.axis_wins ?? 0}**\n🔵 Allies **${today.allies_wins ?? 0}**`,
    inline: true,
  };
}

function leaderField(p) {
  return {
    name: '🔥  Leading now',
    value: `${mdLink(p.player_name, `${BF1942_URL}/player/${encodeURIComponent(p.player_name)}`)}\n` +
           `${p.score ?? 0} pts · ${p.kills ?? 0}/${p.deaths ?? 0} K/D`,
    inline: true,
  };
}

// Row 1 (cached, changes per round): Last round · MVP · Today.
// Row 2: Recent maps · Wins today · Leading now (live).
// leader: current top scorer, or null when empty/stale.
function buildSummaryEmbed(extras, current, leader = null) {
  const fields = [];
  const round  = extras.lastRound;
  if (round) {
    fields.push(lastRoundField(round));
    if (round.mvp_name) fields.push(mvpField(round));
  }
  if (extras.today) fields.push(todayField(extras.today, current, extras.todayLabel));
  if (extras.recentMaps?.length > 1) fields.push(recentMapsField(extras.recentMaps));
  if (extras.today?.rounds > 0) fields.push(winsTodayField(extras.today));
  if (leader) fields.push(leaderField(leader));
  if (fields.length === 0) return null;

  return new EmbedBuilder()
    .setColor(TEAMS[round?.winner_team]?.color ?? DRAW_COLOR)
    .addFields(fields);
}

// ── Main single-server embed ──────────────────────────────────────────────────

function buildStatusEmbed(servers, label, _serverIds = [], players = [], snapshot = null) {
  const title  = `🎖️  ${label}`;
  const server = servers[0] ?? null;

  if (!server) return buildServerOfflineEmbed(label, null);

  const count    = server.current_player_count ?? 0;
  const max      = server.current_max_players  ?? 0;
  const map      = formatMap(server.current_map);
  const gt       = formatGametype(server.current_gametype || snapshot?.gametype);
  const name     = server.current_server_name || 'Unknown Server';
  const joinPort = server.current_game_port || server.port;
  const joinAddr = joinPort ? `${server.ip}:${joinPort}` : server.ip;
  const isOnline = count > 0;
  const locked   = snapshot?.has_password === 1;
  const stale    = isSnapshotStale(snapshot);
  // A stale snapshot's clock is frozen; the ⚠️ header explains why it's gone.
  const timeLeft = stale ? null : formatTimeRemaining(snapshot?.round_time_remain);

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
    .setFooter({ text: 'Powered by captheflag.com  ·  Last Update', iconURL: FOOTER_ICON })
    .setTimestamp();

  // Inline info fields: map, mode, time remaining
  const infoFields = [
    { name: '🗺️  Map',  value: map, inline: true },
  ];
  if (gt)       infoFields.push({ name: '⚔️  Mode',      value: gt,               inline: true });
  if (timeLeft) infoFields.push({ name: '⏱️  Time left', value: timeLeft,          inline: true });
  embed.addFields(infoFields);

  // The live player table can keep rows after everyone leaves (the site's
  // API guards against the same ghosts), so trust the server's count.
  if (count > 0 && players && players.length > 0) {
    const allied = players.filter(p => p.team === 1);
    const axis   = players.filter(p => p.team === 2);
    const other  = players.filter(p => p.team !== 1 && p.team !== 2);

    const fmtLabel = (color, side, roster, tickets) => {
      const bits = [plural(roster.length, 'player')];
      if (tickets != null) bits.push(`${tickets} tickets`);
      const ping = averagePing(roster);
      if (ping != null) bits.push(`${ping} ms avg`);
      return `${color}  ${side} — ${bits.join(' · ')}`;
    };

    embed.addFields(
      { name: fmtLabel('🔴', 'Axis',   allied, alliedTickets),
        value: renderTeamScoreboard(allied), inline: false },
      { name: fmtLabel('🔵', 'Allied', axis,   axisTickets),
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

// Status card plus, when there's data for it, the summary card. The footer
// and timestamp move to whichever card is last so they sit at the bottom.
// extras: { lastRound, today: { peak, players, rounds }, todayLabel }; any may be missing.
// offline: the servers row (any state) when the server isn't ACTIVE/EMPTY.
function buildStatusEmbeds(servers, label, serverIds = [], players = [], snapshot = null, extras = {}, offline = null) {
  const online = servers[0] ?? null;
  const status = online
    ? buildStatusEmbed(servers, label, serverIds, players, snapshot)
    : buildServerOfflineEmbed(label, offline);

  // players arrive sorted by score; skip when empty (ghost rows) or stale.
  const current = online?.current_player_count ?? 0;
  const leader  = current > 0 && !isSnapshotStale(snapshot) ? players[0] ?? null : null;
  const summary = buildSummaryEmbed(extras, current, leader);
  if (!summary) return [status];

  // .data holds API-shaped keys (icon_url); setFooter wants iconURL.
  const { text, icon_url: iconURL } = status.data.footer;
  summary.setFooter({ text, iconURL }).setTimestamp(new Date(status.data.timestamp));
  status.setFooter(null).setTimestamp(null);
  return [status, summary];
}

// ── Bot presence line (shown under the bot's name in the member list) ────────

function buildPresenceText(servers, snapshot = null) {
  const s = servers[0];
  if (!s) return 'Offline';
  const players = s.current_player_count || 0;
  const max     = s.current_max_players  || 0;
  const map     = formatMap(s.current_map);
  if (players === 0) return `Empty · ${map}`;
  // Skip the clock when the snapshot is stale; it would show a frozen time.
  const timeLeft = isSnapshotStale(snapshot) ? null : formatTimeRemaining(snapshot?.round_time_remain);
  return timeLeft
    ? `${players}/${max} · ${map} · ${timeLeft} left`
    : `${players}/${max} · ${map}`;
}

module.exports = { buildStatusEmbeds, buildErrorEmbed, buildBotOfflineEmbed, buildPresenceText };
