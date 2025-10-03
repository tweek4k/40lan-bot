import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionsBitField, MessageFlags
} from 'discord.js';
import fs from 'fs';

// ----------------- client setup -----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel]
});

// ----------------- constants -----------------
const BUTTONS = {
  LAN: 'join_lan',
  MAYBE: 'join_maybe',
  REMOTE: 'join_remote',
  NAME: 'set_name',
  NOT: 'not_attending'
};
const MODAL_ID = 'name_modal';
const NICK_ID = 'nick_input';
const REAL_ID = 'real_input';

const ROLES = {
  LAN: 'LAN Seat',
  MAYBE: 'Interested / Maybe',
  REMOTE: 'Play From Home',
  WAIT: 'Waitlist'
};

// ----------------- load games + state -----------------
const games = JSON.parse(fs.readFileSync('./games.json', 'utf8'));
const DATA_FILE = process.env.DATA_FILE || './lan-data.json';
const state = loadState();
if (!state.votes) state.votes = {}; 
if (!state.maxVotes) state.maxVotes = 3;
if (!state.voteMessageId) state.voteMessageId = null;
if (!state.voteChannelId) state.voteChannelId = null;
if (!state.panelMessageId) state.panelMessageId = null;
if (!state.signupChannelId) state.signupChannelId = null;

function loadState() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch {
    return {
      capacity: 48,
      lan: [],
      maybe: [],
      remote: [],
      waitlist: [],
      timestamps: {},
      votes: {},
      maxVotes: 3,
      voteMessageId: null,
      voteChannelId: null,
      panelMessageId: null,
      signupChannelId: null
    };
  }
}
function saveState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

// ----------------- helpers -----------------
function statusString() {
  return `**Seats:** ${state.lan.length}/${state.capacity} • **Maybe:** ${state.maybe.length} • **Remote:** ${state.remote.length} • **Waitlist:** ${state.waitlist.length}`;
}
function signupEmbed(guildName) {
  return new EmbedBuilder()
    .setTitle(`🎮 ${guildName} — LAN Signup`)
    .setDescription(
      'First set your display name using ✏️ (format: `nick - real name`).\n' +
      'After that, pick your status below. LAN seats are limited.'
    )
    .addFields(
      { name: 'Statuses', value: `🟢 **LAN seat** (waitlist if full)\n🟡 **Interested/Maybe**\n🔵 **Play from home**\n🚫 **Not attending**`, inline: true },
      { name: 'Live Totals', value: statusString(), inline: true }
    )
    .setColor(0x5865F2);
}
function buttonsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BUTTONS.NAME).setLabel('✏️ Set nick + real name').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(BUTTONS.LAN).setLabel('🟢 I’m attending (LAN seat / waitlist)').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(BUTTONS.MAYBE).setLabel('🟡 Interested / Maybe').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(BUTTONS.REMOTE).setLabel('🔵 Play from home').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(BUTTONS.NOT).setLabel('🚫 Not attending').setStyle(ButtonStyle.Danger)
  );
}
async function refreshPanel(channel, messageId) {
  try {
    const msg = await channel.messages.fetch(messageId);
    await msg.edit({ embeds: [signupEmbed(channel.guild.name)], components: [buttonsRow()] });
  } catch {}
}
async function ensureRoles(guild) {
  const wanted = Object.values(ROLES);
  const existing = await guild.roles.fetch();
  const result = {};
  for (const name of wanted) {
    let role = existing.find(r => r.name === name);
    if (!role) role = await guild.roles.create({ name, reason: 'LAN bot setup' });
    result[name] = role;
  }
  return result;
}
async function swapRoles(member, map, target) {
  const toRemove = [];
  for (const [key, role] of Object.entries(map)) {
    if (key !== target) toRemove.push(role);
  }
  await member.roles.remove(toRemove.filter(r => member.roles.cache.has(r.id)).map(r => r.id)).catch(()=>{});
  if (target) await member.roles.add(map[target]).catch(()=>{});
}

// ----------------- voting helpers -----------------
function tallyVotes() {
  const tally = {};
  for (const arr of Object.values(state.votes)) {
    for (const g of arr) tally[g] = (tally[g] || 0) + 1;
  }
  return Object.entries(tally).sort((a,b) => b[1]-a[1]);
}
function voteResultsEmbed() {
  const sorted = tallyVotes();
  return new EmbedBuilder()
    .setTitle("🎮 LAN Game Votes")
    .setColor(0x00AE86)
    .setDescription(sorted.length === 0
      ? "No votes yet."
      : sorted.map(([g,n],idx)=>`**${idx+1}. ${g}** — ${n} vote${n!==1?'s':''}`).join('\n'));
}
async function updateVoteMessage(guild) {
  if (!state.voteMessageId || !state.voteChannelId) return;
  try {
    const ch = await guild.channels.fetch(state.voteChannelId);
    const msg = await ch.messages.fetch(state.voteMessageId);
    await msg.edit({ embeds: [voteResultsEmbed()] });
  } catch {}
}

// ----------------- boot -----------------
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  await ensureRoles(guild);

  await guild.commands.set([
    // Signup commands
    { name: 'postsignup', description: 'Post the signup panel', options: [{ type: 4, name: 'capacity', description: 'Seat capacity', required: false }] },
    { name: 'setcapacity', description: 'Set LAN seat capacity', options: [{ type: 4, name: 'capacity', description: 'New seat capacity', required: true }] },
    { name: 'clearstatus', description: 'Clear a user’s status', options: [{ type: 6, name: 'user', description: 'User to clear', required: true }] },
    { name: 'approve', description: 'Approve a user from waitlist', options: [{ type: 6, name: 'user', description: 'User to approve', required: true }] },
    { name: 'deny', description: 'Remove a user from waitlist', options: [{ type: 6, name: 'user', description: 'User to deny', required: true }] },
    { name: 'statuslist', description: 'Show current signup lists' },
    { name: 'export', description: 'Export CSV of signups' },
    { name: 'name', description: 'Set your display to "nick - real name"' },

    // Voting
    { name: 'vote', description: 'Vote for a game', options: [{ type: 3, name: 'game', description: 'Game name', required: true, autocomplete: true }] },
    { name: 'unvote', description: 'Remove one of your votes' },
    { name: 'results', description: 'Show votes' },
    { name: 'suggestgame', description: 'Add a new game', options: [{ type: 3, name: 'title', description: 'Game title', required: true }] },
    { name: 'setmaxvotes', description: 'Set max votes per user', options: [{ type: 4, name: 'number', description: 'Max votes', required: true }] },
    { name: 'votemessage', description: 'Post voting instructions' },
    { name: 'votereset', description: 'Clear all votes' }
  ]);
});

// ----------------- interactions -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    // autocomplete for /vote
    if (i.isAutocomplete()) {
      const focused = i.options.getFocused();
      const filtered = games.filter(g => g.toLowerCase().includes(focused.toLowerCase())).slice(0, 25);
      return i.respond(filtered.map(g => ({ name: g, value: g })));
    }

    // Slash commands
    if (i.isChatInputCommand()) {
      // signup: postsignup
      if (i.commandName === 'postsignup') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return i.reply({ content: '❌ Need Manage Server.', flags: MessageFlags.Ephemeral });
        const cap = i.options.getInteger('capacity');
        if (cap) state.capacity = cap;
        saveState();
        const ch = i.channel;
        const msg = await ch.send({ embeds: [signupEmbed(i.guild.name)], components: [buttonsRow()] });
        state.panelMessageId = msg.id;
        state.signupChannelId = ch.id;
        saveState();
        return i.reply({ content: `📢 Signup panel posted in <#${ch.id}>.`, flags: MessageFlags.Ephemeral });
      }

      // signup: setcapacity
      if (i.commandName === 'setcapacity') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return i.reply({ content: '❌ Need Manage Server.', flags: MessageFlags.Ephemeral });
        const newCap = i.options.getInteger('capacity');
        const oldCap = state.capacity;
        state.capacity = newCap;
        if (newCap > oldCap) {
          while (state.lan.length < newCap && state.waitlist.length > 0) {
            const next = state.waitlist.shift();
            state.lan.push(next);
          }
        } else if (newCap < oldCap && state.lan.length > newCap) {
          const sorted = [...state.lan].sort((a,b)=> new Date(state.timestamps[a]) - new Date(state.timestamps[b]));
          const keep = sorted.slice(0, newCap);
          const drop = sorted.slice(newCap);
          state.lan = keep;
          state.waitlist = [...drop, ...state.waitlist];
        }
        saveState();
        return i.reply({ content: `✅ Capacity set to ${newCap}.`, flags: MessageFlags.Ephemeral });
      }

      // voting commands
      if (i.commandName === 'vote') {
        const game = i.options.getString('game');
        const match = games.find(g => g.toLowerCase() === game.toLowerCase());
        if (!match) return i.reply({ content: `⚠️ "${game}" not found.`, flags: MessageFlags.Ephemeral });
        if (!state.votes[i.user.id]) state.votes[i.user.id] = [];
        if (state.votes[i.user.id].includes(match)) return i.reply({ content: `⚠️ Already voted for ${match}.`, flags: MessageFlags.Ephemeral });
        if (state.votes[i.user.id].length >= state.maxVotes) return i.reply({ content: `⚠️ Max ${state.maxVotes} votes.`, flags: MessageFlags.Ephemeral });
        state.votes[i.user.id].push(match);
        state.timestamps[i.user.id] = new Date().toISOString();
        saveState();
        await updateVoteMessage(i.guild);
        return i.reply({ content: `✅ Voted for ${match}.`, flags: MessageFlags.Ephemeral });
      }
      if (i.commandName === 'unvote') {
        const userVotes = state.votes[i.user.id] || [];
        if (userVotes.length === 0) return i.reply({ content: `⚠️ No votes to remove.`, flags: MessageFlags.Ephemeral });
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('unvote_menu')
            .setPlaceholder('Select vote to remove')
            .addOptions(userVotes.map(v => ({ label: v, value: v })))
        );
        return i.reply({ content: '🗑️ Select a vote to remove:', components: [row], flags: MessageFlags.Ephemeral });
      }
      if (i.commandName === 'results') return i.reply({ embeds: [voteResultsEmbed()] });
      if (i.commandName === 'suggestgame') {
        const title = i.options.getString('title').trim();
        if (games.find(g => g.toLowerCase() === title.toLowerCase())) return i.reply({ content: `⚠️ ${title} already exists.`, flags: MessageFlags.Ephemeral });
        games.push(title);
        fs.writeFileSync('./games.json', JSON.stringify(games, null, 2));
        return i.reply({ content: `📥 Added ${title}.` });
      }
      if (i.commandName === 'setmaxvotes') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return i.reply({ content: '❌ Need Manage Server.', flags: MessageFlags.Ephemeral });
        state.maxVotes = i.options.getInteger('number');
        saveState();
        return i.reply({ content: `✅ Max votes set to ${state.maxVotes}.`, flags: MessageFlags.Ephemeral });
      }
      if (i.commandName === 'votemessage') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return i.reply({ content: '❌ Need Manage Server.', flags: MessageFlags.Ephemeral });
        const instr = new EmbedBuilder()
          .setTitle("🗳️ LAN Game Voting")
          .setColor(0x5865F2)
          .setDescription(`Use /vote, /unvote, /results.\nMax ${state.maxVotes} votes per user.`);
        await i.channel.send({ embeds: [instr] });
        const msg = await i.channel.send({ embeds: [voteResultsEmbed()] });
        state.voteMessageId = msg.id;
        state.voteChannelId = i.channel.id;
        saveState();
        return i.reply({ content: `📢 Voting setup posted.`, flags: MessageFlags.Ephemeral });
      }
      if (i.commandName === 'votereset') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return i.reply({ content: '❌ Need Manage Server.', flags: MessageFlags.Ephemeral });
        state.votes = {};
        saveState();
        await updateVoteMessage(i.guild);
        return i.reply({ content: `🗑️ Votes cleared.` });
      }
    }

    // Button handlers
    if (i.isButton()) {
      const roles = await ensureRoles(i.guild);
      const member = await i.guild.members.fetch(i.user.id);

      if (![BUTTONS.NAME, BUTTONS.NOT].includes(i.customId)) {
        if (!member.nickname || !member.nickname.includes('-')) {
          return i.reply({ content: '⚠️ Please set your nickname first with ✏️.', flags: MessageFlags.Ephemeral });
        }
      }

      let msg = '';
      if (i.customId === BUTTONS.NAME) {
        const modal = new ModalBuilder().setCustomId(MODAL_ID).setTitle('Set your display');
        const nickInput = new TextInputBuilder().setCustomId(NICK_ID).setLabel('Nickname').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(28);
        const realInput = new TextInputBuilder().setCustomId(REAL_ID).setLabel('Real name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(28);
        modal.addComponents(new ActionRowBuilder().addComponents(nickInput), new ActionRowBuilder().addComponents(realInput));
        return i.showModal(modal);
      }
      if (i.customId === BUTTONS.LAN) {
        if (state.lan.includes(i.user.id)) msg = '✅ Already in LAN.';
        else if (state.lan.length < state.capacity) { state.lan.push(i.user.id); msg = '✅ LAN seat taken.'; await swapRoles(member, roles, ROLES.LAN); }
        else { if (!state.waitlist.includes(i.user.id)) state.waitlist.push(i.user.id); msg = `LAN full. Waitlist #${state.waitlist.indexOf(i.user.id)+1}`; await swapRoles(member, roles, ROLES.WAIT); }
      }
      if (i.customId === BUTTONS.MAYBE) { if (!state.maybe.includes(i.user.id)) state.maybe.push(i.user.id); msg = '🟡 Maybe.'; await swapRoles(member, roles, ROLES.MAYBE); }
      if (i.customId === BUTTONS.REMOTE) { if (!state.remote.includes(i.user.id)) state.remote.push(i.user.id); msg = '🔵 Remote.'; await swapRoles(member, roles, ROLES.REMOTE); }
      if (i.customId === BUTTONS.NOT) {
        state.lan = state.lan.filter(x=>x!==i.user.id);
        state.maybe = state.maybe.filter(x=>x!==i.user.id);
        state.remote = state.remote.filter(x=>x!==i.user.id);
        state.waitlist = state.waitlist.filter(x=>x!==i.user.id);
        msg = '🚫 Not attending. Roles cleared.';
        await member.roles.remove(Object.values(roles).map(r => r.id)).catch(()=>{});
        try { await member.setNickname(null); } catch {}
      }
      saveState();
      await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
      if (state.panelMessageId && state.signupChannelId) {
        const ch = await i.guild.channels.fetch(state.signupChannelId);
        await refreshPanel(ch, state.panelMessageId);
      }
    }

    // Modal nickname
    if (i.isModalSubmit() && i.customId === MODAL_ID) {
      const nick = i.fields.getTextInputValue(NICK_ID);
      const real = i.fields.getTextInputValue(REAL_ID);
      const newNick = `${nick.trim()} - ${real.trim()}`.slice(0, 32);
      try {
        const member = await i.guild.members.fetch(i.user.id);
        if (member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return i.reply({ content: '⚠️ Admins keep own nick.', flags: MessageFlags.Ephemeral });
        }
        await member.setNickname(newNick, 'LAN bot');
        return i.reply({ content: `✅ Nick set to ${newNick}`, flags: MessageFlags.Ephemeral });
      } catch {
        return i.reply({ content: '❌ Could not change nickname.', flags: MessageFlags.Ephemeral });
      }
    }

    // unvote menu
    if (i.isStringSelectMenu() && i.customId === 'unvote_menu') {
      const game = i.values[0];
      state.votes[i.user.id] = state.votes[i.user.id].filter(g => g !== game);
      saveState();
      await updateVoteMessage(i.guild);
      await i.update({ content: `🗑️ Removed vote for ${game}`, components: [] });
    }
  } catch (err) {
    console.error("Interaction error:", err);
    try { await i.reply({ content: "⚠️ Something went wrong.", flags: MessageFlags.Ephemeral }); } catch {}
  }
});

// ----------------- error handling -----------------
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

client.login(process.env.DISCORD_TOKEN);
