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

// ── Scoreboard rendering ──────────────────────────────────────────────────────

// Fixed-width columns: Name(24) Score(5) K(3) D(3) Ping(4), 44 chars a row.
// Discord caps a field at 1024 chars; minus the ``` wrapper that leaves room
// for about 21 rows, so a full 32-player team ends in a "+N more" line
// instead of being cut mid-row.
const FIELD_BODY_MAX = 1000;

function renderTeamScoreboard(teamPlayers) {
  if (teamPlayers.length === 0) return '```\n— no players —\n```';

  const header = 'Player                   Score   K   D  Ping';
  const sep    = '────────────────────────────────────────────';
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
    const row   = `${name} ${score} ${k} ${d}  ${ping}`;

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

function lastRoundField(round) {
  const team  = TEAMS[round.winner_team];
  const lines = [team ? `**${team.name}** won` : '**Draw**', formatMap(round.map_name)];
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
    value: `${escapeMarkdown(round.mvp_name)}\n${round.mvp_score ?? 0} pts`,
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
function buildSummaryEmbed(extras, current) {
  const fields = [];
  const round  = extras.lastRound;
  if (round) {
    fields.push(lastRoundField(round));
    if (round.mvp_name) fields.push(mvpField(round));
  }
  if (extras.today) fields.push(todayField(extras.today, current, extras.todayLabel));
  if (fields.length === 0) return null;

  return new EmbedBuilder()
    .setColor(TEAMS[round?.winner_team]?.color ?? DRAW_COLOR)
    .addFields(fields);
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
      .setFooter({ text: 'Powered by captheflag.com' })
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
      const count = `${roster.length} player${roster.length === 1 ? '' : 's'}`;
      return tickets != null
        ? `${color}  ${side} — ${count} · ${tickets} tickets`
        : `${color}  ${side} — ${count}`;
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
function buildStatusEmbeds(servers, label, serverIds = [], players = [], snapshot = null, extras = {}) {
  const status = buildStatusEmbed(servers, label, serverIds, players, snapshot);
  if (!servers[0]) return [status];

  const summary = buildSummaryEmbed(extras, servers[0].current_player_count ?? 0);
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

module.exports = { buildStatusEmbeds, buildErrorEmbed, buildPresenceText };
