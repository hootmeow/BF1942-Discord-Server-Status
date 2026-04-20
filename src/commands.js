const { SlashCommandBuilder, PermissionFlagsBits, REST, Routes } = require('discord.js');

const command = new SlashCommandBuilder()
  .setName('bf1942')
  .setDescription('BF1942 server status monitor — admin only')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub =>
    sub.setName('setup')
      .setDescription('Create a live status embed in this channel')
      .addStringOption(opt =>
        opt.setName('label')
          .setDescription('Title shown in the embed (default: BF1942 Server Status)')
          .setRequired(false)
          .setMaxLength(80)
      )
  )
  .addSubcommand(sub =>
    sub.setName('remove')
      .setDescription('Remove the status monitor from this channel')
  )
  .addSubcommand(sub =>
    sub.setName('info')
      .setDescription('Show the current monitor configuration for this channel')
  )
  .addSubcommandGroup(group =>
    group.setName('filter')
      .setDescription('Control which game servers are shown in this channel')
      .addSubcommand(sub =>
        sub.setName('add')
          .setDescription('Show only specific game servers (removes all-server view)')
          .addIntegerOption(opt =>
            opt.setName('server')
              .setDescription('Game server to add to the filter')
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
      .addSubcommand(sub =>
        sub.setName('remove')
          .setDescription('Remove a game server from this channel\'s filter')
          .addIntegerOption(opt =>
            opt.setName('server')
              .setDescription('Game server to remove from the filter')
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
      .addSubcommand(sub =>
        sub.setName('clear')
          .setDescription('Clear all filters — show every game server')
      )
  );

async function registerCommands(clientId, token) {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: [command.toJSON()] });
  console.log('[CMD] Global slash commands registered.');
}

module.exports = { command, registerCommands };
