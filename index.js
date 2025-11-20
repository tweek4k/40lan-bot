import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionsBitField, MessageFlags
} from 'discord.js';
import fs from 'fs';
import { google } from 'googleapis';

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
const GAME_SIGNUP = {
  SELECT: 'game_signup_select',
  LEAVE: 'game_signup_leave'
};
const SHEET_SIGNUP = {
  SELECT: 'sheet_signup_select',
  LEAVE: 'sheet_signup_leave'
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

// Feedback mode for poll button clicks: 'ephemeral' (default) or 'none'
const FEEDBACK_MODE = process.env.POLL_FEEDBACK || 'ephemeral';

const POLL = { LONG: 'long', SHORT: 'short' };
const POLL_MODAL = { [POLL.LONG]: 'long_edit_modal', [POLL.SHORT]: 'short_edit_modal' };
const POLL_INPUT = { [POLL.LONG]: 'long_choices_input', [POLL.SHORT]: 'short_choices_input' };
const MAX_POLL_BUTTONS = 25;
const makeChoiceId = (which, idx) => `${which}_select_${idx}`;

// ----------------- load games + state -----------------
const games = JSON.parse(fs.readFileSync('./games.json', 'utf8'));
const DATA_FILE = process.env.DATA_FILE || './lan-data.json';
const state = loadState();
if (!state.votes) state.votes = {}; 
if (!state.maxVotes) state.maxVotes = 3;
if (!state.voteMessageId) state.voteMessageId = null;
if (!state.voteChannelId) state.voteChannelId = null;
if (!state.voteInstructionMessageId) state.voteInstructionMessageId = null;
if (!state.panelMessageId) state.panelMessageId = null;
if (!state.signupChannelId) state.signupChannelId = null;
if (typeof state.votingActive === 'undefined') state.votingActive = false;
if (typeof state.voteLabel === 'undefined') state.voteLabel = null;
if (!state.gameSignup) {
  state.gameSignup = {
    active: false,
    label: null,
    games: [], // [{ name, max, members: [userId,...] }]
    messageId: null,
    channelId: null,
    sheet: null // { id, tab }
  };
}
if (!state.sheetSignup) {
  state.sheetSignup = {
    active: false,
    label: null,
    sheetId: null,
    tab: null,
    choices: [],
    messageId: null,
    channelId: null
  };
}
// New: single-choice polls for long/short formats
state.longPoll = ensurePollState(state.longPoll);
state.shortPoll = ensurePollState(state.shortPoll);

function ensurePollState(existing = {}) {
  const poll = {
    active: Boolean(existing?.active),
    choices: Array.isArray(existing?.choices) ? existing.choices : [],
    selections: (existing?.selections && typeof existing.selections === 'object') ? existing.selections : {},
    maxSelections: Math.max(1, Number(existing?.maxSelections) || 1),
    messageId: existing?.messageId || null,
    channelId: existing?.channelId || null
  };
  sanitizePollSelections(poll);
  return poll;
}

function normalizeSelectionValue(value) {
  if (Array.isArray(value)) return value.filter((idx) => Number.isInteger(idx));
  if (Number.isInteger(value)) return [value];
  return [];
}

function sanitizePollSelections(poll) {
  if (!poll || !poll.selections) {
    if (poll) poll.selections = {};
    return;
  }
  for (const [userId, rawValue] of Object.entries(poll.selections)) {
    const normalized = normalizeSelectionValue(rawValue);
    if (normalized.length) poll.selections[userId] = normalized;
    else delete poll.selections[userId];
  }
}

const getPollByName = (name) => name === POLL.LONG ? state.longPoll : state.shortPoll;
const setPollByName = (name, poll) => {
  if (name === POLL.LONG) state.longPoll = poll; else state.shortPoll = poll;
};

function pollDescription(poll) {
  if (!poll.active) return 'Poll is closed.';
  if (poll.maxSelections > 1) return `Pick up to ${poll.maxSelections} choices. Click again to remove.`;
  return 'Click a button to choose. You can change your vote anytime.';
}

function renderPollEmbed(poll, which, guildName) {
  sanitizePollSelections(poll);
  const isLong = which === POLL.LONG;
  const embed = new EmbedBuilder()
    .setTitle(isLong ? '🗳️ Long-format Poll' : '🗳️ Short-format Poll')
    .setColor(isLong ? 0x9b59b6 : 0xf1c40f)
    .setDescription(pollDescription(poll));
  if (!poll.choices.length) {
    embed.addFields({ name: 'No choices', value: 'Use /' + which + ' edit to add choices.' });
    return embed;
  }
  for (let idx = 0; idx < poll.choices.length; idx++) {
    const name = poll.choices[idx];
    const usersIn = Object.entries(poll.selections)
      .filter(([, stored]) => normalizeSelectionValue(stored).includes(idx))
      .map(([uid]) => `<@${uid}>`);
    let value = '(empty)';
    if (usersIn.length > 0) {
      const shown = usersIn.slice(0, 20);
      value = shown.join(', ');
      if (usersIn.length > shown.length) value += `, +${usersIn.length - shown.length} more`;
    }
    embed.addFields({ name: `${name} (${usersIn.length})`, value, inline: false });
  }
  return embed;
}

function renderPollComponents(poll, which, disabled = false) {
  const rows = [];
  const buttonsDisabled = disabled || !poll.active;
  const isLong = which === POLL.LONG;
  poll.choices.slice(0, MAX_POLL_BUTTONS).forEach((label, idx) => {
    const btn = new ButtonBuilder()
      .setCustomId(makeChoiceId(which, idx))
      .setStyle(isLong ? ButtonStyle.Primary : ButtonStyle.Success)
      .setLabel(label)
      .setDisabled(buttonsDisabled);
    if (rows.length === 0 || rows[rows.length - 1].components.length >= 5) rows.push(new ActionRowBuilder().addComponents(btn));
    else rows[rows.length - 1].addComponents(btn);
  });
  if (poll.choices.length > 0) {
    const clearBtn = new ButtonBuilder()
      .setCustomId(`${which}_clear`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel(poll.maxSelections > 1 ? 'Clear my selections' : 'Clear my selection')
      .setDisabled(buttonsDisabled);
    if (rows.length === 0) rows.push(new ActionRowBuilder().addComponents(clearBtn));
    else if (rows[rows.length - 1].components.length < 5) rows[rows.length - 1].addComponents(clearBtn);
    else if (rows.length < 5) rows.push(new ActionRowBuilder().addComponents(clearBtn));
  }
  return rows;
}

const pollEmbed = (which, guildName) => renderPollEmbed(getPollByName(which), which, guildName);
const pollComponents = (which, disabled = false) => renderPollComponents(getPollByName(which), which, disabled);

async function updatePollMessage(guild, which) {
  const poll = getPollByName(which);
  if (!poll.messageId || !poll.channelId) return;
  try {
    const ch = await guild.channels.fetch(poll.channelId);
    const msg = await ch.messages.fetch(poll.messageId);
    await msg.edit({ embeds: [renderPollEmbed(poll, which, guild.name)], components: renderPollComponents(poll, which) });
  } catch {}
}

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
      voteInstructionMessageId: null,
      panelMessageId: null,
      signupChannelId: null,
      votingActive: false,
      voteLabel: null
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

// ----------------- game signup helpers -----------------
function parseGamesInput(input, defaultMax = 4) {
  return input
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(token => {
      const m = token.match(/^(.*?)(?:\s*\((\d+)\))?$/);
      const name = (m?.[1] || token).trim();
      const max = m?.[2] ? parseInt(m[2], 10) : defaultMax;
      return { name, max: Math.max(1, max), members: [] };
    });
}
function gameSignupEmbed(guildName) {
  const e = new EmbedBuilder()
    .setTitle(`📝 Game Signup${state.gameSignup.label ? ' — ' + state.gameSignup.label : ''}`)
    .setColor(0x2ecc71)
    .setDescription('Pick a game from the dropdown to join. You can only be in one game at a time.')
    .addFields(
      ...state.gameSignup.games.map(g => ({
        name: `${g.name} (${g.members.length}/${g.max})`,
        value: g.members.length ? g.members.map(id => `- <@${id}>`).join('\n') : '(empty)',
        inline: false
      }))
    );
  if (!state.gameSignup.games.length) e.addFields({ name: 'No games configured', value: 'Ask an admin to start a session.' });
  return e;
}
function gameSignupComponents() {
  if (!state.gameSignup.active) return [];
  const select = new StringSelectMenuBuilder()
    .setCustomId(GAME_SIGNUP.SELECT)
    .setPlaceholder('Choose a game to join')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      state.gameSignup.games.slice(0, 25).map((g, idx) => ({
        label: g.name,
        value: String(idx),
        description: `${g.members.length}/${g.max} players`
      }))
    );
  const row1 = new ActionRowBuilder().addComponents(select);
  const leaveBtn = new ButtonBuilder()
    .setCustomId(GAME_SIGNUP.LEAVE)
    .setLabel('Leave current game')
    .setStyle(ButtonStyle.Danger);
  const row2 = new ActionRowBuilder().addComponents(leaveBtn);
  return [row1, row2];
}
async function updateGameSignupMessage(guild) {
  if (!state.gameSignup.messageId || !state.gameSignup.channelId) return;
  try {
    const ch = await guild.channels.fetch(state.gameSignup.channelId);
    const msg = await ch.messages.fetch(state.gameSignup.messageId);
    await msg.edit({ embeds: [gameSignupEmbed(guild.name)], components: gameSignupComponents() });
  } catch {}
}
function removeUserFromAllGames(userId) {
  for (const g of state.gameSignup.games) {
    g.members = g.members.filter(id => id !== userId);
  }
}
async function getSheetsClientOrNull() {
  const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  let key = process.env.GOOGLE_SHEETS_PRIVATE_KEY;
  if (!email || !key) {
    console.warn('Sheets auth not configured: missing ' + (!email ? 'GOOGLE_SHEETS_CLIENT_EMAIL ' : '') + (!key ? 'GOOGLE_SHEETS_PRIVATE_KEY' : ''));
    return null;
  }
  // Handle "\n" escaped newlines in .env
  key = key.replace(/\\n/g, '\n');
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: { client_email: email, private_key: key },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const client = await auth.getClient();
    return google.sheets({ version: 'v4', auth: client });
  } catch (err) {
    console.error('Google Sheets auth error:', err.response?.data || err.message || err);
    return null;
  }
}
async function syncGameSignupToSheet(guild) {
  try {
    if (!state.gameSignup.sheet?.id || !state.gameSignup.sheet?.tab) return;
    const sheets = await getSheetsClientOrNull();
    if (!sheets) return;

    const header = ['Game', 'Max', 'Count', 'Players...'];
    const values = [header];

    const nameOf = async (id) => {
      try {
        const cached = guild.members.cache.get(id);
        const m = cached || await guild.members.fetch(id);
        return m?.displayName || m?.user?.username || `<@${id}>`;
      } catch {
        return `<@${id}>`;
      }
    };

    for (const g of state.gameSignup.games) {
      const names = await Promise.all(g.members.map(id => nameOf(id)));
      values.push([g.name, String(g.max), String(g.members.length), ...names]);
    }

    const range = `${state.gameSignup.sheet.tab}!A1:Z1000`;
    await sheets.spreadsheets.values.clear({ spreadsheetId: state.gameSignup.sheet.id, range });
    await sheets.spreadsheets.values.update({
      spreadsheetId: state.gameSignup.sheet.id,
      range,
      valueInputOption: 'RAW',
      requestBody: { values }
    });
  } catch (e) {
    console.error('Sheet sync error:', e.message);
  }
}

// ----------------- sheet-driven signup helpers -----------------
function colIndexToLetter(idx) {
  let s = '';
  idx += 1;
  while (idx > 0) {
    const rem = (idx - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    idx = Math.floor((idx - 1) / 26);
  }
  return s;
}
async function readSheetHeadersAndCounts(sheetId, tab) {
  const sheets = await getSheetsClientOrNull();
  if (!sheets) throw new Error('Sheets not configured');
  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${tab}!1:1` });
  const headers = (headerRes.data.values?.[0] || []).map(String).map(s => s.trim()).filter(Boolean);
  const countRes = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${tab}!A2:Z1000` });
  const grid = countRes.data.values || [];
  const counts = headers.map((_, c) => {
    let filled = 0;
    for (let r = 0; r < grid.length; r++) {
      const cell = grid[r]?.[c];
      if (cell && String(cell).trim().length > 0) filled++;
    }
    return filled;
  });
  return { headers, counts };
}
function parseHeaderToChoice(h) {
  const m = h.match(/^(.*?)(?:\s*\((\d+)\))?$/);
  const name = (m?.[1] || h).trim();
  const max = m?.[2] ? parseInt(m[2], 10) : null;
  return { name, max };
}
function sheetSignupEmbed(guildName) {
  const titleLabel = state.sheetSignup.label ? ` — ${state.sheetSignup.label}` : '';
  const e = new EmbedBuilder()
    .setTitle(`📝 Signup${titleLabel}`)
    .setColor(0x3498db)
    .setDescription('Choose an option from the dropdown. You can switch at any time.');
  if (state.sheetSignup.choices.length === 0) {
    e.addFields({ name: 'No choices found', value: 'Ensure row 1 in the sheet tab has headers.' });
  } else {
    e.addFields(
      ...state.sheetSignup.choices.map(ch => ({
        name: `${ch.name}${typeof ch.count === 'number' ? ` (${ch.count}${ch.max ? '/' + ch.max : ''})` : ''}`,
        value: ch.count > 0 ? ' ' : '(empty)',
        inline: false
      }))
    );
  }
  return e;
}
function sheetSignupComponents() {
  if (!state.sheetSignup.active) return [];
  const options = state.sheetSignup.choices.slice(0, 25).map((ch, idx) => ({
    label: ch.name,
    value: String(idx),
    description: (typeof ch.count === 'number') ? `${ch.count}${ch.max ? '/' + ch.max : ''}` : undefined
  }));
  const select = new StringSelectMenuBuilder()
    .setCustomId(SHEET_SIGNUP.SELECT)
    .setPlaceholder('Pick an option')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);
  const row1 = new ActionRowBuilder().addComponents(select);
  const leaveBtn = new ButtonBuilder().setCustomId(SHEET_SIGNUP.LEAVE).setLabel('Leave (clear choice)').setStyle(ButtonStyle.Secondary);
  const row2 = new ActionRowBuilder().addComponents(leaveBtn);
  return [row1, row2];
}
async function updateSheetSignupMessage(guild) {
  if (!state.sheetSignup.messageId || !state.sheetSignup.channelId) return;
  try {
    const ch = await guild.channels.fetch(state.sheetSignup.channelId);
    const msg = await ch.messages.fetch(state.sheetSignup.messageId);
    await msg.edit({ embeds: [sheetSignupEmbed(guild.name)], components: sheetSignupComponents() });
  } catch {}
}
async function removeUserFromAllSheetColumns(sheetId, tab, displayName) {
  const sheets = await getSheetsClientOrNull();
  if (!sheets) return;
  const range = `${tab}!A2:Z1000`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  const grid = res.data.values || [];
  let changed = false;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < Math.max(26, (grid[r]?.length || 0)); c++) {
      const cell = grid[r]?.[c];
      if (cell && String(cell).trim() === displayName) {
        if (!grid[r]) grid[r] = [];
        grid[r][c] = '';
        changed = true;
      }
    }
  }
  if (changed) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: grid }
    });
  }
}
async function appendUserToSheetColumnIfSpace(sheetId, tab, colIdx, displayName, maxOrNull) {
  const sheets = await getSheetsClientOrNull();
  if (!sheets) throw new Error('Sheets not configured');
  const colLetter = colIndexToLetter(colIdx);
  const colRange = `${tab}!${colLetter}2:${colLetter}1000`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: colRange });
  const col = (res.data.values || []).map(row => row[0]);
  const filtered = col.filter(v => v && String(v).trim().length > 0);
  if (typeof maxOrNull === 'number' && filtered.length >= maxOrNull) {
    return { ok: false, reason: 'full', count: filtered.length };
  }
  if (filtered.includes(displayName)) return { ok: true, count: filtered.length };
  filtered.push(displayName);
  const out = filtered.map(v => [v]);
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: colRange,
    valueInputOption: 'RAW',
    requestBody: { values: out }
  });
  return { ok: true, count: filtered.length };
}
function voteResultsEmbed() {
  const sorted = tallyVotes();
  const suffix = state.voteLabel ? ` — ${state.voteLabel}` : '';
  const title = state.votingActive ? `🎮 Game Vote${suffix}` : `🏁 Final Game Vote Results${suffix}`;
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(0x00AE86)
    .setDescription(sorted.length === 0
      ? "No votes yet."
      : sorted.map(([g,n],idx)=>`**${idx+1}. ${g}** — ${n} vote${n!==1?'s':''}`).join('\n'));
}
function voteInstructionEmbed() {
  const suffix = state.voteLabel ? ` — ${state.voteLabel}` : '';
  return new EmbedBuilder()
    .setTitle(`🗳️ LAN Game Voting${suffix}`)
    .setColor(0x5865F2)
    .setDescription(`Use /vote, /unvote, /suggestgame.\nMax ${state.maxVotes} votes per user.`);
}
async function updateVoteMessage(guild) {
  if (!state.voteMessageId || !state.voteChannelId) return;
  try {
    const ch = await guild.channels.fetch(state.voteChannelId);
    const msg = await ch.messages.fetch(state.voteMessageId);
    await msg.edit({ embeds: [voteResultsEmbed()] });
  } catch {}
}
async function updateVoteInstructionMessage(guild) {
  if (!state.voteInstructionMessageId || !state.voteChannelId) return;
  try {
    const ch = await guild.channels.fetch(state.voteChannelId);
    const msg = await ch.messages.fetch(state.voteInstructionMessageId);
    await msg.edit({ embeds: [voteInstructionEmbed()] });
  } catch {}
}

// ----------------- boot -----------------
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  await ensureRoles(guild);

  await guild.commands.set([
    // Only keep the new poll commands
    { name: 'suggestgame', description: 'Suggest a new game title', options: [
      { type: 3, name: 'title', description: 'Game title', required: true }
    ] },
    { name: 'long', description: 'Admin: manage Long-format poll', defaultMemberPermissions: PermissionsBitField.Flags.Administrator, options: [
      { type: 1, name: 'edit', description: 'Edit the list of choices (modal)' },
      { type: 1, name: 'start', description: 'Start the poll in this channel (clears previous selections)', options: [
        { type: 4, name: 'maxselect', description: 'How many choices each user can pick (default 1)', required: false, min_value: 1, max_value: 25 }
      ] },
      { type: 1, name: 'pause', description: 'Pause the poll (disable buttons, keep results visible)' },
      { type: 1, name: 'unpause', description: 'Unpause the poll (enable buttons)' }
    ] },
    { name: 'short', description: 'Admin: manage Short-format poll', defaultMemberPermissions: PermissionsBitField.Flags.Administrator, options: [
      { type: 1, name: 'edit', description: 'Edit the list of choices (modal)' },
      { type: 1, name: 'start', description: 'Start the poll in this channel (clears previous selections)' },
      { type: 1, name: 'pause', description: 'Pause the poll (disable buttons, keep results visible)' },
      { type: 1, name: 'unpause', description: 'Unpause the poll (enable buttons)' }
    ] }
  ]);
});

// ----------------- interactions -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    // Autocomplete for /vote
    if (i.isAutocomplete()) {
      const q = i.options.getFocused().trim().toLowerCase();

      // Require at least 2 characters before suggesting anything
      if (q.length < 2) {
        return i.respond([]);
      }

      // Rank prefix matches first, then substring matches
      const starts = games.filter(g => g.toLowerCase().startsWith(q));
      const contains = games.filter(g => !g.toLowerCase().startsWith(q) && g.toLowerCase().includes(q));

      const filtered = [...starts, ...contains].slice(0, 25); // Discord limit
      return i.respond(filtered.map(g => ({ name: g, value: g })));
    }

    // Slash commands
    if (i.isChatInputCommand()) {

      // Long/Short subcommands
      if (i.commandName === 'long' || i.commandName === 'short') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.Administrator)) return i.reply({ content: '❌ Need Admin.', flags: MessageFlags.Ephemeral });
        const which = i.commandName; // 'long' | 'short'
        const sub = i.options.getSubcommand();
        if (sub === 'edit') {
          const modal = new ModalBuilder().setCustomId(POLL_MODAL[which]).setTitle(which === POLL.LONG ? 'Edit Long-format choices' : 'Edit Short-format choices');
          const existing = (getPollByName(which)?.choices || []).join('\n');
          const input = new TextInputBuilder()
            .setCustomId(POLL_INPUT[which])
            .setLabel('Enter one choice per line')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder('Game A\\nGame B\\nGame C');
          if (existing.length > 0) input.setValue(existing);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return i.showModal(modal);
        }
        if (sub === 'start') {
          const poll = getPollByName(which);
          if (which === POLL.LONG) {
            const requestedMax = i.options.getInteger('maxselect');
            const clamped = Math.max(1, Math.min(MAX_POLL_BUTTONS, requestedMax || 1));
            poll.maxSelections = clamped;
          }
          if (!poll.choices.length) return i.reply({ content: '⚠️ No choices yet. Use /' + which + ' edit first.', flags: MessageFlags.Ephemeral });
          // clamp to Discord's button limit
          if (poll.choices.length > MAX_POLL_BUTTONS) poll.choices = poll.choices.slice(0, MAX_POLL_BUTTONS);
          // Clear previous selections when starting a new run
          poll.selections = {};
          poll.active = true;
          poll.channelId = i.channel.id;
          // If previous message exists, delete it to keep one active panel
          if (poll.messageId) {
            try {
              const ch = await i.guild.channels.fetch(poll.channelId);
              const old = await ch.messages.fetch(poll.messageId);
              await old.delete();
            } catch {}
            poll.messageId = null;
          }
          const msg = await i.channel.send({ embeds: [pollEmbed(which, i.guild.name)], components: pollComponents(which) });
          poll.messageId = msg.id;
          setPollByName(which, poll);
          saveState();
          const extra = which === POLL.LONG ? ` Users can pick up to ${poll.maxSelections} choice${poll.maxSelections === 1 ? '' : 's'}.` : '';
          return i.reply({ content: `🟢 ${which === POLL.LONG ? 'Long' : 'Short'} poll started.` + extra, flags: MessageFlags.Ephemeral });
        }
        if (sub === 'pause') {
          const poll = getPollByName(which);
          poll.active = false;
          setPollByName(which, poll);
          saveState();
          await updatePollMessage(i.guild, which);
          return i.reply({ content: `⏸️ ${which === POLL.LONG ? 'Long' : 'Short'} poll paused.`, flags: MessageFlags.Ephemeral });
        }
        if (sub === 'unpause') {
          const poll = getPollByName(which);
          poll.active = true;
          // If message was lost, re-post with existing selections
          if (!poll.messageId || !poll.channelId) {
            poll.channelId = i.channel.id;
            const msg = await i.channel.send({ embeds: [pollEmbed(which, i.guild.name)], components: pollComponents(which) });
            poll.messageId = msg.id;
          } else {
            await updatePollMessage(i.guild, which);
          }
          setPollByName(which, poll);
          saveState();
          return i.reply({ content: `▶️ ${which === POLL.LONG ? 'Long' : 'Short'} poll unpaused.`, flags: MessageFlags.Ephemeral });
        }
      }
      // Game signup: start
      if (i.commandName === 'gamesignup_start') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return i.reply({ content: '❌ Need Manage Server.', flags: MessageFlags.Ephemeral });
        const gamesStr = i.options.getString('games');
        const defMax = i.options.getInteger('defaultmax') || 4;
        const label = i.options.getString('label');
        const sheetId = i.options.getString('sheetid');
        const sheetTab = i.options.getString('sheettab');

        state.gameSignup.active = true;
        state.gameSignup.label = label?.trim() || null;
        state.gameSignup.games = parseGamesInput(gamesStr, defMax);
        state.gameSignup.channelId = i.channel.id;
        state.gameSignup.messageId = null;
        state.gameSignup.sheet = (sheetId && sheetTab) ? { id: sheetId.trim(), tab: sheetTab.trim() } : null;
        saveState();

        const msg = await i.channel.send({ embeds: [gameSignupEmbed(i.guild.name)], components: gameSignupComponents() });
        state.gameSignup.messageId = msg.id;
        saveState();
        await syncGameSignupToSheet(i.guild);
        return i.reply({ content: `🟢 Game signup started${state.gameSignup.label ? ` — ${state.gameSignup.label}` : ''}.`, flags: MessageFlags.Ephemeral });
      }

      // Game signup: stop
      if (i.commandName === 'gamesignup_stop') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return i.reply({ content: '❌ Need Manage Server.', flags: MessageFlags.Ephemeral });
        state.gameSignup.active = false;
        saveState();
        await updateGameSignupMessage(i.guild);
        await syncGameSignupToSheet(i.guild);
        return i.reply({ content: '🛑 Game signup stopped. Controls disabled.', flags: MessageFlags.Ephemeral });
      }

      // Game signup: export (ephemeral)
      if (i.commandName === 'gamesignup_export') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return i.reply({ content: '❌ Need Manage Server.', flags: MessageFlags.Ephemeral });
        const lines = [];
        const now = new Date();
        lines.push(`Game Signup — ${now.toLocaleString()}${state.gameSignup.label ? ` — ${state.gameSignup.label}` : ''}`);
        if (!state.gameSignup.games.length) return i.reply({ content: 'No games configured.', flags: MessageFlags.Ephemeral });
        for (const g of state.gameSignup.games) {
          lines.push(`${g.name} (${g.members.length}/${g.max})`);
          lines.push(g.members.length ? g.members.map(id => `- <@${id}>`).join('\n') : '(empty)');
          lines.push('');
        }
        const text = lines.join('\n');
        const content = '```text\n' + text + '\n```';
        if (content.length <= 1900) return i.reply({ content, flags: MessageFlags.Ephemeral });
        const buf = Buffer.from(text, 'utf8');
        return i.reply({ content: '📄 Overview attached.', files: [{ attachment: buf, name: `game-signup-${Date.now()}.txt` }], flags: MessageFlags.Ephemeral });
      }

      // Sheet signup: start
      if (i.commandName === 'signup-start') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return i.reply({ content: '❌ Need Manage Server.', flags: MessageFlags.Ephemeral });
        const tab = i.options.getString('tab').trim();
        const label = i.options.getString('label');
        const overrideSheet = i.options.getString('sheetid');
        const sheetId = (overrideSheet && overrideSheet.trim()) || process.env.SIGNUP_SHEET_ID || state.gameSignup?.sheet?.id || state.sheetSignup.sheetId;
        if (!sheetId) return i.reply({ content: '❌ No Sheet ID. Pass sheetid or set SIGNUP_SHEET_ID env.', flags: MessageFlags.Ephemeral });
        try {
          const { headers, counts } = await readSheetHeadersAndCounts(sheetId, tab);
          const choices = headers.map((h, idx) => ({ ...parseHeaderToChoice(h), count: counts[idx] }));
          state.sheetSignup.active = true;
          state.sheetSignup.label = label?.trim() || null;
          state.sheetSignup.sheetId = sheetId;
          state.sheetSignup.tab = tab;
          state.sheetSignup.choices = choices;
          state.sheetSignup.channelId = i.channel.id;
          state.sheetSignup.messageId = null;
          saveState();
          const msg = await i.channel.send({ embeds: [sheetSignupEmbed(i.guild.name)], components: sheetSignupComponents() });
          state.sheetSignup.messageId = msg.id;
          saveState();
          return i.reply({ content: `🟢 Signup started for tab "${tab}"${state.sheetSignup.label ? ` — ${state.sheetSignup.label}` : ''}.`, flags: MessageFlags.Ephemeral });
        } catch (e) {
          console.error('signup-start error:', e.message);
          return i.reply({ content: '❌ Could not read headers from Sheet. Check ID/tab and credentials.', flags: MessageFlags.Ephemeral });
        }
      }

      // Sheet signup: stop
      if (i.commandName === 'signup-stop') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return i.reply({ content: '❌ Need Manage Server.', flags: MessageFlags.Ephemeral });
        state.sheetSignup.active = false;
        saveState();
        await updateSheetSignupMessage(i.guild);
        return i.reply({ content: '🛑 Signup stopped. Controls disabled.', flags: MessageFlags.Ephemeral });
      }
      // Voting session controls
      if (i.commandName === 'votestart') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return i.reply({ content: '❌ Need Manage Server.', flags: MessageFlags.Ephemeral });
        const mv = i.options.getInteger('maxvotes');
        if (mv && mv > 0) state.maxVotes = mv;
        const label = i.options.getString('text');
        state.voteLabel = label && label.trim() ? label.trim() : null;
        // Reset votes for a fresh session
        state.votes = {};
        state.votingActive = true;
        saveState();
        // Remove any old instruction message
        if (state.voteInstructionMessageId && state.voteChannelId) {
          try {
            const ch = await i.guild.channels.fetch(state.voteChannelId);
            const m = await ch.messages.fetch(state.voteInstructionMessageId);
            await m.delete();
          } catch {}
          state.voteInstructionMessageId = null;
        }
        // Post fresh instruction
        const instrMsg = await i.channel.send({ embeds: [voteInstructionEmbed()] });
        state.voteInstructionMessageId = instrMsg.id;
        // Always post a brand-new results message for a new session
        const resMsg = await i.channel.send({ embeds: [voteResultsEmbed()] });
        state.voteMessageId = resMsg.id;
        state.voteChannelId = i.channel.id;
        saveState();
        return i.reply({ content: `🟢 Voting started. Max votes per user: ${state.maxVotes}.` + (state.voteLabel ? ` Label: "${state.voteLabel}".` : ''), flags: MessageFlags.Ephemeral });
      }
      if (i.commandName === 'votestop') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return i.reply({ content: '❌ Need Manage Server.', flags: MessageFlags.Ephemeral });
        state.votingActive = false;
        // Delete instructions
        if (state.voteInstructionMessageId && state.voteChannelId) {
          try {
            const ch = await i.guild.channels.fetch(state.voteChannelId);
            const m = await ch.messages.fetch(state.voteInstructionMessageId);
            await m.delete();
          } catch {}
          state.voteInstructionMessageId = null;
        }
        saveState();
        // Update results title to final
        await updateVoteMessage(i.guild);
        return i.reply({ content: '🛑 Voting stopped. Results finalized.', flags: MessageFlags.Ephemeral });
      }
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

      // Admin: export overview ephemerally (fallback to file if long)
      if (i.commandName === 'export') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
          return i.reply({ content: '❌ Need Manage Server.', flags: MessageFlags.Ephemeral });
        }
        const lines = [];
        const now = new Date();
        lines.push(`Overview — ${now.toLocaleString()}`);
        lines.push(`Seats: ${state.lan.length}/${state.capacity} • Maybe: ${state.maybe.length} • Remote: ${state.remote.length} • Waitlist: ${state.waitlist.length}`);

        const nameOf = async (guild, id) => {
          try {
            const cached = guild.members.cache.get(id);
            const m = cached || await guild.members.fetch(id);
            return m?.displayName || m?.user?.username || `Unknown (${id})`;
          } catch {
            return `Unknown (${id})`;
          }
        };

  const lanList = (await Promise.all(state.lan.map(async id => `- ${await nameOf(i.guild, id)}`))).join('\n') || '(none)';
  const waitList = (await Promise.all(state.waitlist.map(async (id, idx) => `${idx + 1}. ${await nameOf(i.guild, id)}`))).join('\n') || '(empty)';
  const maybeList = (await Promise.all(state.maybe.map(async id => `- ${await nameOf(i.guild, id)}`))).join('\n') || '(none)';
  const remoteList = (await Promise.all(state.remote.map(async id => `- ${await nameOf(i.guild, id)}`))).join('\n') || '(none)';

        lines.push('LAN:\n' + lanList);
        lines.push('Waitlist:\n' + waitList);
        lines.push('Maybe:\n' + maybeList);
        lines.push('Remote:\n' + remoteList);

        const text = lines.join('\n\n');
        const content = '```text\n' + text + '\n```';

        if (content.length <= 1900) {
          return i.reply({ content, flags: MessageFlags.Ephemeral });
        } else {
          const buf = Buffer.from(text, 'utf8');
          return i.reply({
            content: '📄 Overview attached.',
            files: [{ attachment: buf, name: `lan-overview-${Date.now()}.txt` }],
            flags: MessageFlags.Ephemeral
          });
        }
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
        if (!state.votingActive) return i.reply({ content: '⚠️ No voting in progress.', flags: MessageFlags.Ephemeral });
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
        if (!state.votingActive) return i.reply({ content: '⚠️ No voting in progress.', flags: MessageFlags.Ephemeral });
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
        return i.reply({ content: `Added ${title}.` });
      }
      if (i.commandName === 'setmaxvotes') {
        if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return i.reply({ content: '❌ Need Manage Server.', flags: MessageFlags.Ephemeral });
        state.maxVotes = i.options.getInteger('number');
        saveState();
        // Update both instruction and results messages if configured
        await updateVoteInstructionMessage(i.guild);
        await updateVoteMessage(i.guild);
        return i.reply({ content: `✅ Max votes set to ${state.maxVotes}. Updated vote messages.`, flags: MessageFlags.Ephemeral });
      }
      // removed legacy votemessage / postvotesnapshot / votereset
    }

    // Button handlers
    if (i.isButton()) {
      // Long/Short selection buttons
      if (i.customId.startsWith('long_select_') || i.customId.startsWith('short_select_')) {
        const which = i.customId.startsWith('long_') ? POLL.LONG : POLL.SHORT;
        const poll = getPollByName(which);
        if (!poll.active) return i.reply({ content: '⚠️ Poll is not active.', flags: MessageFlags.Ephemeral });
        const idx = parseInt(i.customId.split('_').pop(), 10);
        if (Number.isNaN(idx) || !poll.choices[idx]) return i.reply({ content: '❌ Invalid choice.', flags: MessageFlags.Ephemeral });
        // Ack quickly to prevent timeouts
        if (FEEDBACK_MODE === 'none') await i.deferUpdate(); else await i.deferReply({ ephemeral: true });
        const maxSelections = Math.max(1, poll.maxSelections || 1);
        const currentSelections = normalizeSelectionValue(poll.selections[i.user.id]);
        const alreadySelected = currentSelections.includes(idx);
        let feedback = '';
        if (alreadySelected) {
          const updated = currentSelections.filter((choiceIdx) => choiceIdx !== idx);
          if (updated.length) poll.selections[i.user.id] = updated;
          else delete poll.selections[i.user.id];
          feedback = `➖ Removed: ${poll.choices[idx]}`;
        } else if (currentSelections.length >= maxSelections) {
          if (maxSelections === 1) {
            poll.selections[i.user.id] = [idx];
            feedback = `✅ Selected: ${poll.choices[idx]}`;
          } else {
            if (FEEDBACK_MODE !== 'none') await i.editReply({ content: `⚠️ You already picked ${maxSelections} choice${maxSelections === 1 ? '' : 's'}. Clear one before adding another.` });
            return;
          }
        } else {
          poll.selections[i.user.id] = [...currentSelections, idx];
          feedback = `✅ Selected: ${poll.choices[idx]} (${poll.selections[i.user.id].length}/${maxSelections})`;
        }
        setPollByName(which, poll);
        saveState();
        // Update panel with latest selections (edit the source message directly)
        try {
          await i.message.edit({ embeds: [renderPollEmbed(poll, which, i.guild.name)], components: renderPollComponents(poll, which) });
        } catch {}
        if (FEEDBACK_MODE !== 'none') await i.editReply({ content: feedback });
        return; 
      }
      // Long/Short clear selection
      if (i.customId === 'long_clear' || i.customId === 'short_clear') {
        const which = i.customId.startsWith('long') ? POLL.LONG : POLL.SHORT;
        const poll = getPollByName(which);
        if (!poll.active) return i.reply({ content: '⚠️ Poll is not active.', flags: MessageFlags.Ephemeral });
        const currentSelections = normalizeSelectionValue(poll.selections[i.user.id]);
        if (!currentSelections.length) {
          return i.reply({ content: 'ℹ️ You don\'t have a selection to clear.', flags: MessageFlags.Ephemeral });
        }
        if (FEEDBACK_MODE === 'none') await i.deferUpdate(); else await i.deferReply({ ephemeral: true });
        delete poll.selections[i.user.id];
        setPollByName(which, poll);
        saveState();
        try {
          await i.message.edit({ embeds: [renderPollEmbed(poll, which, i.guild.name)], components: renderPollComponents(poll, which) });
        } catch {}
        if (FEEDBACK_MODE !== 'none') {
          const label = poll.maxSelections > 1 ? 'selections' : 'selection';
          await i.editReply({ content: `🧹 Cleared your ${label}.` });
        }
        return;
      }
      // Game signup leave
      if (i.customId === GAME_SIGNUP.LEAVE) {
        if (!state.gameSignup.active) return i.reply({ content: '⚠️ No active game signup.', flags: MessageFlags.Ephemeral });
        removeUserFromAllGames(i.user.id);
        saveState();
        await updateGameSignupMessage(i.guild);
        await syncGameSignupToSheet(i.guild);
        return i.reply({ content: '✅ You left your game.', flags: MessageFlags.Ephemeral });
      }
      // Sheet signup leave
      if (i.customId === SHEET_SIGNUP.LEAVE) {
        if (!state.sheetSignup.active) return i.reply({ content: '⚠️ No active signup.', flags: MessageFlags.Ephemeral });
        try {
          const member = await i.guild.members.fetch(i.user.id);
          const displayName = member.displayName || member.user.username;
          await removeUserFromAllSheetColumns(state.sheetSignup.sheetId, state.sheetSignup.tab, displayName);
          const { headers, counts } = await readSheetHeadersAndCounts(state.sheetSignup.sheetId, state.sheetSignup.tab);
          state.sheetSignup.choices = headers.map((h, idx) => ({ ...parseHeaderToChoice(h), count: counts[idx] }));
          saveState();
          await updateSheetSignupMessage(i.guild);
          return i.reply({ content: '✅ Your choice was cleared.', flags: MessageFlags.Ephemeral });
        } catch (e) {
          console.error('sheet leave error:', e.message);
          return i.reply({ content: '❌ Could not update the sheet.', flags: MessageFlags.Ephemeral });
        }
      }

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
    // Long/Short edit modals
    if (i.isModalSubmit() && (i.customId === 'long_edit_modal' || i.customId === 'short_edit_modal')) {
      if (!i.memberPermissions?.has?.(PermissionsBitField.Flags.Administrator)) {
        return i.reply({ content: '❌ Need Admin.', flags: MessageFlags.Ephemeral });
      }
      const which = i.customId.startsWith('long') ? 'long' : 'short';
      const inputId = which === 'long' ? 'long_choices_input' : 'short_choices_input';
      const raw = i.fields.getTextInputValue(inputId) || '';
      const newChoices = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 25);
      const poll = which === 'long' ? state.longPoll : state.shortPoll;
      const oldChoices = poll.choices || [];
      // Remap selections to still-present choices (case-insensitive)
      const nameToNewIndex = new Map(newChoices.map((name, idx) => [name.toLowerCase(), idx]));
      const remapped = {};
      for (const [userId, stored] of Object.entries(poll.selections || {})) {
        const translated = [];
        for (const oldIdx of normalizeSelectionValue(stored)) {
          const oldName = oldChoices[oldIdx];
          if (typeof oldName !== 'string') continue;
          const newIdx = nameToNewIndex.get(oldName.toLowerCase());
          if (typeof newIdx === 'number' && !translated.includes(newIdx)) {
            translated.push(newIdx);
            if (translated.length >= (poll.maxSelections || 1)) break;
          }
        }
        if (translated.length) remapped[userId] = translated;
      }
      poll.choices = newChoices;
      poll.selections = remapped;
      setPollByName(which, poll);
      saveState();
      // If active and message exists, refresh panel
      if (poll.active && poll.messageId && poll.channelId) {
        try {
          const ch = await i.guild.channels.fetch(poll.channelId);
          const msg = await ch.messages.fetch(poll.messageId);
          await msg.edit({ embeds: [renderPollEmbed(poll, which, i.guild.name)], components: renderPollComponents(poll, which) });
        } catch {}
      }
  return i.reply({ content: `✅ Updated ${which} choices (${newChoices.length} items).`, flags: MessageFlags.Ephemeral });
    }
    // Game signup selection
    if (i.isStringSelectMenu() && i.customId === GAME_SIGNUP.SELECT) {
      if (!state.gameSignup.active) return i.reply({ content: '⚠️ No active game signup.', flags: MessageFlags.Ephemeral });
      const selectedIndex = parseInt(i.values[0], 10);
      const game = state.gameSignup.games[selectedIndex];
      if (!game) return i.reply({ content: '❌ Invalid selection.', flags: MessageFlags.Ephemeral });
      if (game.members.includes(i.user.id)) return i.reply({ content: `✅ Already in ${game.name}.`, flags: MessageFlags.Ephemeral });
      if (game.members.length >= game.max) return i.reply({ content: `⛔ ${game.name} is full.`, flags: MessageFlags.Ephemeral });
      removeUserFromAllGames(i.user.id);
      game.members.push(i.user.id);
      saveState();
      await updateGameSignupMessage(i.guild);
      await syncGameSignupToSheet(i.guild);
      return i.reply({ content: `✅ Joined ${game.name}.`, flags: MessageFlags.Ephemeral });
    }
    // Sheet signup selection
    if (i.isStringSelectMenu() && i.customId === SHEET_SIGNUP.SELECT) {
      if (!state.sheetSignup.active) return i.reply({ content: '⚠️ No active signup.', flags: MessageFlags.Ephemeral });
      const idx = parseInt(i.values[0], 10);
      const choice = state.sheetSignup.choices[idx];
      if (!choice) return i.reply({ content: '❌ Invalid choice.', flags: MessageFlags.Ephemeral });
      try {
        const member = await i.guild.members.fetch(i.user.id);
        const displayName = member.displayName || member.user.username;
        await removeUserFromAllSheetColumns(state.sheetSignup.sheetId, state.sheetSignup.tab, displayName);
        const result = await appendUserToSheetColumnIfSpace(state.sheetSignup.sheetId, state.sheetSignup.tab, idx, displayName, choice.max ?? null);
        if (!result.ok && result.reason === 'full') {
          return i.reply({ content: '⛔ That option is full.', flags: MessageFlags.Ephemeral });
        }
        const { headers, counts } = await readSheetHeadersAndCounts(state.sheetSignup.sheetId, state.sheetSignup.tab);
        state.sheetSignup.choices = headers.map((h, j) => ({ ...parseHeaderToChoice(h), count: counts[j] }));
        saveState();
        await updateSheetSignupMessage(i.guild);
        return i.reply({ content: `✅ Signed up for ${choice.name}.`, flags: MessageFlags.Ephemeral });
      } catch (e) {
        console.error('sheet select error:', e.message);
        return i.reply({ content: '❌ Could not update the sheet.', flags: MessageFlags.Ephemeral });
      }
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
