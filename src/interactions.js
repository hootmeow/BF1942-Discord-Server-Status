const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const {
  getMonitor, createMonitor, deleteMonitor,
  updateMonitorMessage, updateMonitorServerIds, getServerList,
  fetchServers,
} = require('./database');
const { buildStatusEmbed, buildErrorEmbed } = require('./embed');

/**
 * Factory that returns the interactionCreate handler.
 *
 * @param {Map} monitorCache  - Shared map: channelId → { row, message, busy }
 * @param {Function} triggerUpdate - Callback to immediately refresh one monitor's embed
 */
function createInteractionHandler(monitorCache, triggerUpdate) {
  return async function handleInteraction(interaction) {
    if (interaction.isAutocomplete()) return handleAutocomplete(interaction, monitorCache);
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'bf1942') return;

    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: '❌ You need the **Manage Server** permission to use this command.',
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup(false);

    try {
      if (sub === 'setup') return await handleSetup(interaction, monitorCache);
      if (sub === 'remove') return await handleRemove(interaction, monitorCache);
      if (sub === 'info') return await handleInfo(interaction, monitorCache);
      if (group === 'filter') {
        if (sub === 'add') return await handleFilterAdd(interaction, monitorCache, triggerUpdate);
        if (sub === 'remove') return await handleFilterRemove(interaction, monitorCache, triggerUpdate);
        if (sub === 'clear') return await handleFilterClear(interaction, monitorCache, triggerUpdate);
      }
    } catch (err) {
      console.error(`[INTERACTION] Error in /${interaction.commandName} ${group ?? ''} ${sub}:`, err.message);
      interaction.editReply({ content: `❌ Something went wrong: \`${err.message}\`` });
    }
  };
}

// ── /bf1942 setup ─────────────────────────────────────────────────────────────

async function handleSetup(interaction, monitorCache) {
  const channelId = interaction.channelId;

  const existing = await getMonitor(channelId);
  if (existing) {
    return interaction.editReply({
      content: '⚠️ This channel already has a status monitor. Use `/bf1942 remove` first if you want to recreate it.',
    });
  }

  const label = interaction.options.getString('label') ?? 'BF1942 Server Status';
  const row = await createMonitor(interaction.guildId, channelId, label);

  // Send the initial embed directly into this channel
  let embed;
  try {
    const servers = await fetchServers([]);
    embed = buildStatusEmbed(servers, label);
  } catch (err) {
    embed = buildErrorEmbed(label, err.message);
  }

  const message = await interaction.channel.send({ embeds: [embed] });
  await updateMonitorMessage(channelId, message.id);
  row.message_id = message.id;

  monitorCache.set(channelId, { row, message, busy: false });

  return interaction.editReply({ content: `✅ Status monitor created in <#${channelId}>!` });
}

// ── /bf1942 remove ────────────────────────────────────────────────────────────

async function handleRemove(interaction, monitorCache) {
  const channelId = interaction.channelId;

  const deleted = await deleteMonitor(channelId);
  if (!deleted) {
    return interaction.editReply({ content: '⚠️ No status monitor found in this channel.' });
  }

  const entry = monitorCache.get(channelId);
  if (entry?.message) {
    await entry.message.delete().catch(() => null);
  }
  monitorCache.delete(channelId);

  return interaction.editReply({ content: '✅ Status monitor removed.' });
}

// ── /bf1942 info ──────────────────────────────────────────────────────────────

async function handleInfo(interaction, monitorCache) {
  const channelId = interaction.channelId;
  const row = monitorCache.get(channelId)?.row ?? await getMonitor(channelId);

  if (!row) {
    return interaction.editReply({
      content: 'No status monitor in this channel. Use `/bf1942 setup` to create one.',
    });
  }

  let filterText = 'All servers';
  if (row.server_ids?.length > 0) {
    const list = await getServerList();
    const names = row.server_ids.map(id => {
      const s = list.find(s => BigInt(s.server_id) === BigInt(id));
      return s ? `• ${s.current_server_name || s.ip} (ID ${id})` : `• ID ${id}`;
    });
    filterText = names.join('\n');
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📋 Monitor Configuration')
    .addFields(
      { name: 'Label', value: row.label, inline: true },
      { name: 'Channel', value: `<#${row.channel_id}>`, inline: true },
      { name: 'Server Filter', value: filterText, inline: false },
    )
    .setFooter({ text: `Monitor ID: ${row.id}` })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

// ── /bf1942 filter add ────────────────────────────────────────────────────────

async function handleFilterAdd(interaction, monitorCache, triggerUpdate) {
  const channelId = interaction.channelId;
  const entry = monitorCache.get(channelId);
  const row = entry?.row ?? await getMonitor(channelId);

  if (!row) {
    return interaction.editReply({ content: '⚠️ No monitor in this channel. Run `/bf1942 setup` first.' });
  }

  const serverId = BigInt(interaction.options.getInteger('server', true));
  const current = (row.server_ids ?? []).map(BigInt);

  if (current.some(id => id === serverId)) {
    return interaction.editReply({ content: '⚠️ That server is already in the filter.' });
  }

  const newIds = [...current, serverId].map(Number);
  const updated = await updateMonitorServerIds(channelId, newIds);
  if (entry) entry.row = updated;

  await triggerUpdate(channelId);

  const serverList = await getServerList();
  const server = serverList.find(s => BigInt(s.server_id) === serverId);
  const name = server?.current_server_name || `ID ${serverId}`;

  return interaction.editReply({ content: `✅ **${name}** added to the filter. The embed has been updated.` });
}

// ── /bf1942 filter remove ─────────────────────────────────────────────────────

async function handleFilterRemove(interaction, monitorCache, triggerUpdate) {
  const channelId = interaction.channelId;
  const entry = monitorCache.get(channelId);
  const row = entry?.row ?? await getMonitor(channelId);

  if (!row) {
    return interaction.editReply({ content: '⚠️ No monitor in this channel.' });
  }

  const serverId = BigInt(interaction.options.getInteger('server', true));
  const current = (row.server_ids ?? []).map(BigInt);

  if (!current.some(id => id === serverId)) {
    return interaction.editReply({ content: '⚠️ That server is not in the current filter.' });
  }

  const newIds = current.filter(id => id !== serverId).map(Number);
  const updated = await updateMonitorServerIds(channelId, newIds);
  if (entry) entry.row = updated;

  await triggerUpdate(channelId);

  const serverList = await getServerList();
  const server = serverList.find(s => BigInt(s.server_id) === serverId);
  const name = server?.current_server_name || `ID ${serverId}`;
  const note = newIds.length === 0 ? ' Filter cleared — now showing all servers.' : '';

  return interaction.editReply({ content: `✅ **${name}** removed from the filter.${note} Embed updated.` });
}

// ── /bf1942 filter clear ──────────────────────────────────────────────────────

async function handleFilterClear(interaction, monitorCache, triggerUpdate) {
  const channelId = interaction.channelId;
  const entry = monitorCache.get(channelId);
  const row = entry?.row ?? await getMonitor(channelId);

  if (!row) {
    return interaction.editReply({ content: '⚠️ No monitor in this channel.' });
  }

  if ((row.server_ids ?? []).length === 0) {
    return interaction.editReply({ content: 'ℹ️ The filter is already empty — all servers are shown.' });
  }

  const updated = await updateMonitorServerIds(channelId, []);
  if (entry) entry.row = updated;

  await triggerUpdate(channelId);

  return interaction.editReply({ content: '✅ All filters cleared. The embed now shows every server.' });
}

// ── Autocomplete ──────────────────────────────────────────────────────────────

async function handleAutocomplete(interaction, monitorCache) {
  const sub = interaction.options.getSubcommand();
  const focusedValue = interaction.options.getFocused(true);
  if (focusedValue.name !== 'server') return interaction.respond([]);

  try {
    const allServers = await getServerList();
    const entry = monitorCache.get(interaction.channelId);
    const currentIds = (entry?.row?.server_ids ?? []).map(id => BigInt(id));

    let candidates;
    if (sub === 'add') {
      // Only offer servers not already in the filter
      candidates = currentIds.length > 0
        ? allServers.filter(s => !currentIds.some(id => id === BigInt(s.server_id)))
        : allServers;
    } else if (sub === 'remove') {
      // Only offer servers currently in the filter
      candidates = currentIds.length > 0
        ? allServers.filter(s => currentIds.some(id => id === BigInt(s.server_id)))
        : [];
    } else {
      candidates = allServers;
    }

    const query = focusedValue.value.toLowerCase();
    const choices = candidates
      .filter(s => {
        const name = (s.current_server_name || s.ip || '').toLowerCase();
        return name.includes(query);
      })
      .slice(0, 25)
      .map(s => ({
        name: s.current_server_name || s.ip || `Server ${s.server_id}`,
        value: Number(s.server_id),
      }));

    return interaction.respond(choices);
  } catch {
    return interaction.respond([]);
  }
}

module.exports = { createInteractionHandler };
