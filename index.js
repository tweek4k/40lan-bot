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

// Ensure a user is not present in multiple signup lists simultaneously
function removeFromAllLists(userId) {
  state.lan = state.lan.filter(x => x !== userId);
  state.maybe = state.maybe.filter(x => x !== userId);
  state.remote = state.remote.filter(x => x !== userId);
  state.waitlist = state.waitlist.filter(x => x !== userId);
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
  { name: 'waitlist', description: 'Admin: view waitlist and order', options: [] },
    // Signup commands
    { name: 'postsignup', description: 'Post the signup panel', options: [{ type: 4, name: 'capacity', description: 'Seat capacity', required: false }] },
    { name: 'setcapacity', description: 'Set LAN seat capacity', options: [{ type: 4, name: 'capacity', description: 'New seat capacity', required: true }] },
    { name: 'clearstatus', description: 'Clear a user’s status', options: [{ type: 6, name: 'user', description: 'User to clear', required: true }] },
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
    ,
    { name: 'reorderwaitlist', description: 'Admin: move user in waitlist', options: [
      { type: 6, name: 'user', description: 'User to move', required: true },
      { type: 4, name: 'position', description: 'New position (1 = top)', required: true }
    ] }
  ]);
});

// ----------------- interactions -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    // Autocomplete for /vote
    if (i.isAutocomplete()) {
      const focused = i.options.getFocused();
      const filtered = games.filter(g => g.toLowerCase().includes(focused.toLowerCase())).slice(0, 25);
      return i.respond(filtered.map(g => ({ name: g, value: g })));
    }

    // Slash commands
    if (i.isChatInputCommand()) {
      // Admin: view waitlist
      if (i.commandName === 'waitlist') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.Administrator)) return i.reply({ content: '❌ Need Admin.', flags: MessageFlags.Ephemeral });
        if (!state.waitlist.length) return i.reply({ content: 'Waitlist is empty.', flags: MessageFlags.Ephemeral });
        const lines = state.waitlist.map((id, idx) => `${idx + 1}. <@${id}>`).join('\n');
        return i.reply({ content: `**Current Waitlist:**\n${lines}`, flags: MessageFlags.Ephemeral });
      }

      // Signup: postsignup
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

      // Signup: clearstatus
      if (i.commandName === 'clearstatus') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return i.reply({ content: '❌ Need Manage Server.', flags: MessageFlags.Ephemeral });
        const userId = i.options.getUser('user').id;
        state.lan = state.lan.filter(x => x !== userId);
        state.maybe = state.maybe.filter(x => x !== userId);
        state.remote = state.remote.filter(x => x !== userId);
        state.waitlist = state.waitlist.filter(x => x !== userId);
        saveState();
        if (state.panelMessageId && state.signupChannelId) {
          const ch = await i.guild.channels.fetch(state.signupChannelId);
          await refreshPanel(ch, state.panelMessageId);
        }
        return i.reply({ content: `✅ Cleared status for <@${userId}>.`, flags: MessageFlags.Ephemeral });
      }

      // Signup: setcapacity
      if (i.commandName === 'setcapacity') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return i.reply({ content: '❌ Need Manage Server.', flags: MessageFlags.Ephemeral });
        const newCap = i.options.getInteger('capacity');
        const oldCap = state.capacity;
        state.capacity = newCap;
        let promoted = [];
        let demoted = [];
        const roles = await ensureRoles(i.guild);
        if (newCap > oldCap) {
          // Promote from waitlist by timestamp
          state.waitlist.sort((a, b) => {
            const ta = new Date(state.timestamps[a] || 0);
            const tb = new Date(state.timestamps[b] || 0);
            return ta - tb;
          });
          while (state.lan.length < newCap && state.waitlist.length > 0) {
            const next = state.waitlist.shift();
            state.lan.push(next);
            promoted.push(next);
          }
          // Update roles for promoted users
          await Promise.all(promoted.map(async (uid) => {
            try { const m = await i.guild.members.fetch(uid); await swapRoles(m, roles, ROLES.LAN); } catch {}
          }));
        } else if (newCap < oldCap && state.lan.length > newCap) {
          // Demote overflow by oldest timestamp first
          const sorted = [...state.lan].sort((a,b)=> new Date(state.timestamps[a]) - new Date(state.timestamps[b]));
          const keep = sorted.slice(0, newCap);
          const drop = sorted.slice(newCap);
          state.lan = keep;
          state.waitlist = [...drop, ...state.waitlist];
          demoted = drop;
          // Update roles for demoted users
          await Promise.all(demoted.map(async (uid) => {
            try { const m = await i.guild.members.fetch(uid); await swapRoles(m, roles, ROLES.WAIT); } catch {}
          }));
        }
        saveState();
        if (state.panelMessageId && state.signupChannelId) {
          const ch = await i.guild.channels.fetch(state.signupChannelId);
          await refreshPanel(ch, state.panelMessageId);
        }
        const summary = [`✅ Capacity set to ${newCap}.`];
        if (promoted.length) summary.push(`Promoted ${promoted.length} from waitlist to seats.`);
        if (demoted.length) summary.push(`Moved ${demoted.length} from seats to waitlist.`);
        return i.reply({ content: summary.join(' '), flags: MessageFlags.Ephemeral });
      }

      // Signup: reorderwaitlist (move user to position)
      if (i.commandName === 'reorderwaitlist') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.Administrator)) return i.reply({ content: '❌ Need Admin.', flags: MessageFlags.Ephemeral });
        const userOpt = i.options.getUser('user');
        const posOpt = i.options.getInteger('position');
        if (!userOpt || typeof posOpt !== 'number') {
          return i.reply({ content: '❌ Missing user or position.', flags: MessageFlags.Ephemeral });
        }
        const userId = userOpt.id;
        let position = posOpt;
        if (!state.waitlist.includes(userId)) {
          return i.reply({ content: '❌ User is not on the waitlist.', flags: MessageFlags.Ephemeral });
        }
        position = Math.max(1, Math.min(position, state.waitlist.length));
        state.waitlist = state.waitlist.filter(id => id !== userId);
        state.waitlist.splice(position - 1, 0, userId);
        saveState();
        if (state.panelMessageId && state.signupChannelId) {
          const ch = await i.guild.channels.fetch(state.signupChannelId);
          await refreshPanel(ch, state.panelMessageId);
        }
        return i.reply({ content: `✅ Moved <@${userId}> to position ${position} in the waitlist.`, flags: MessageFlags.Ephemeral });
      }

      // Voting commands
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
          .setTitle('🗳️ LAN Game Voting')
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
        return i.reply({ content: '🗑️ Votes cleared.' });
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
        else if (state.lan.length < state.capacity) {
          removeFromAllLists(i.user.id);
          state.lan.push(i.user.id);
          msg = '✅ LAN seat taken.';
          await swapRoles(member, roles, ROLES.LAN);
        } else {
          removeFromAllLists(i.user.id);
          if (!state.waitlist.includes(i.user.id)) state.waitlist.push(i.user.id);
          msg = 'LAN full. You have been placed on the waitlist.';
          await swapRoles(member, roles, ROLES.WAIT);
        }
        saveState();
        await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
        if (state.panelMessageId && state.signupChannelId) {
          const ch = await i.guild.channels.fetch(state.signupChannelId);
          await refreshPanel(ch, state.panelMessageId);
        }
        return;
      }

      if (i.customId === BUTTONS.MAYBE) {
        removeFromAllLists(i.user.id);
        if (!state.maybe.includes(i.user.id)) state.maybe.push(i.user.id);
        msg = '🟡 Maybe.';
        await swapRoles(member, roles, ROLES.MAYBE);
        saveState();
        await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
        if (state.panelMessageId && state.signupChannelId) {
          const ch = await i.guild.channels.fetch(state.signupChannelId);
          await refreshPanel(ch, state.panelMessageId);
        }
        return;
      }

      if (i.customId === BUTTONS.REMOTE) {
        removeFromAllLists(i.user.id);
        if (!state.remote.includes(i.user.id)) state.remote.push(i.user.id);
        msg = '🔵 Remote.';
        await swapRoles(member, roles, ROLES.REMOTE);
        saveState();
        await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
        if (state.panelMessageId && state.signupChannelId) {
          const ch = await i.guild.channels.fetch(state.signupChannelId);
          await refreshPanel(ch, state.panelMessageId);
        }
        return;
      }

      if (i.customId === BUTTONS.NOT) {
        removeFromAllLists(i.user.id);
        msg = '🚫 Not attending. Roles cleared.';
        await member.roles.remove(Object.values(roles).map(r => r.id)).catch(()=>{});
        try { await member.setNickname(null); } catch {}
        saveState();
        await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
        if (state.panelMessageId && state.signupChannelId) {
          const ch = await i.guild.channels.fetch(state.signupChannelId);
          await refreshPanel(ch, state.panelMessageId);
        }
        return;
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
    console.error('Interaction error:', err);
    try { await i.reply({ content: '⚠️ Something went wrong.', flags: MessageFlags.Ephemeral }); } catch {}
  }
});

// ----------------- error handling -----------------
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

client.login(process.env.DISCORD_TOKEN);
