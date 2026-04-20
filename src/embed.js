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
  if (!max || max === 0) return '';
  const filled = Math.round((current / max) * 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  return `\`${bar}\` ${current}/${max}`;
}

function buildErrorEmbed(label, errorMessage) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`⚠️ ${label} — Database Unreachable`)
    .setDescription(
      `The stats database could not be reached.\n\`\`\`${errorMessage}\`\`\`\nServer data will resume automatically when the connection is restored.`
    )
    .setFooter({ text: 'BF1942 Command Center' })
    .setTimestamp();
}

function buildStatusEmbed(servers, label) {
  const totalPlayers = servers.reduce((sum, s) => sum + (s.current_player_count || 0), 0);
  const populated = servers.filter(s => (s.current_player_count || 0) > 0);

  let color;
  if (servers.length === 0)     color = 0x5865f2; // blurple — no servers
  else if (populated.length > 0) color = 0x57f287; // green — active games
  else                           color = 0xfee75c; // yellow — empty servers

  const title = label ? `🎖️ ${label}` : '🎖️ BF1942 Live Server Status';

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setFooter({ text: 'BF1942 Command Center • Refreshes every minute' })
    .setTimestamp();

  if (servers.length === 0) {
    embed.setDescription('No active servers found right now. Check back later, soldier.');
    return embed;
  }

  embed.addFields(servers.map(s => {
    const name = s.current_server_name || `Server ${s.server_id}`;
    const map = formatMap(s.current_map);
    const gametype = formatGametype(s.current_gametype);
    const players = s.current_player_count ?? 0;
    const max = s.current_max_players ?? 0;
    const gametypeStr = gametype ? ` · ${gametype}` : '';
    const statusIcon = players > 0 ? '🟢' : '⚪';

    return {
      name: `${statusIcon} ${name}`,
      value: `**Map:** ${map}${gametypeStr}\n**Players:** ${buildPlayerBar(players, max)}`,
      inline: false,
    };
  }));

  const summary = [
    `**${servers.length}** server${servers.length !== 1 ? 's' : ''} online`,
    totalPlayers > 0
      ? `**${totalPlayers}** player${totalPlayers !== 1 ? 's' : ''} in-game`
      : 'No players currently in-game',
  ];
  embed.setDescription(summary.join(' · '));

  return embed;
}

/**
 * Summarise all monitors into one presence string for the bot's sidebar status.
 * Shows total players across every monitor's server list.
 */
function buildPresenceText(allServers) {
  const totalPlayers = allServers.reduce((sum, s) => sum + (s.current_player_count || 0), 0);
  if (totalPlayers === 0) return 'No active games';
  const top = allServers.find(s => (s.current_player_count || 0) > 0);
  const map = top ? formatMap(top.current_map) : '';
  return `${totalPlayers} players · ${map}`;
}

module.exports = { buildStatusEmbed, buildErrorEmbed, buildPresenceText };
