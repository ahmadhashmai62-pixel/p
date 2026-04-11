import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, 'database.json');

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function readDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function ensureUser(db, userId) {
  if (!db.users[userId]) db.users[userId] = { gems: 500, wagered: 0, profit: 0, deposited: 0, withdrawn: 0 };
  return db.users[userId];
}

function getBalance(userId) {
  const db = readDB();
  const u  = ensureUser(db, userId);
  writeDB(db);
  return u.gems;
}

function setBalance(userId, amount) {
  const db = readDB();
  ensureUser(db, userId).gems = Math.max(0, Math.floor(amount));
  writeDB(db);
}

function adjustBalance(userId, delta) {
  const next = getBalance(userId) + delta;
  setBalance(userId, next);
  return Math.max(0, Math.floor(next));
}

function updateUserStats(userId, { wagered = 0, profit = 0, deposited = 0, withdrawn = 0 } = {}) {
  const db = readDB();
  const u  = ensureUser(db, userId);
  u.wagered   = (u.wagered   || 0) + wagered;
  u.profit    = (u.profit    || 0) + profit;
  u.deposited = (u.deposited || 0) + deposited;
  u.withdrawn = (u.withdrawn || 0) + withdrawn;
  writeDB(db);
}

function getUserData(userId) {
  const db = readDB();
  return ensureUser(db, userId);
}

function isAdmin(userId) {
  return (readDB().admins || []).includes(userId);
}

function addAdmin(userId) {
  const db = readDB();
  if (!db.admins) db.admins = [];
  if (db.admins.includes(userId)) return false;
  db.admins.push(userId);
  writeDB(db);
  return true;
}

function getStaffChannelId() { return readDB().staffChannelId || null; }

function setStaffChannelId(channelId) {
  const db = readDB();
  db.staffChannelId = channelId;
  writeDB(db);
}

function addPendingWithdrawal(userId, amount, requestId) {
  const db = readDB();
  if (!db.pendingWithdrawals) db.pendingWithdrawals = {};
  db.pendingWithdrawals[requestId] = { userId, amount, requestedAt: Date.now() };
  writeDB(db);
}

// Save/clear Roblox link
function setRobloxLink(userId, robloxId, robloxUsername) {
  const db = readDB();
  ensureUser(db, userId);
  db.users[userId].robloxId       = robloxId;
  db.users[userId].robloxUsername = robloxUsername;
  writeDB(db);
}

function clearRobloxLink(userId) {
  const db = readDB();
  ensureUser(db, userId);
  delete db.users[userId].robloxId;
  delete db.users[userId].robloxUsername;
  writeDB(db);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROBLOX API HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function lookupRobloxUser(username) {
  try {
    const res  = await fetch('https://users.roblox.com/v1/usernames/users', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
      signal:  AbortSignal.timeout(8000),
    });
    const json = await res.json();
    return json?.data?.[0] || null; // { id, name, displayName } or null
  } catch {
    return null;
  }
}

async function getRobloxAvatarUrl(robloxId) {
  try {
    const res  = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxId}&size=720x720&format=Png&isCircular=false`,
      { signal: AbortSignal.timeout(8000) }
    );
    const json = await res.json();
    return json?.data?.[0]?.imageUrl || null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAX HELPER  — 10% on the winner's profit
// ═══════════════════════════════════════════════════════════════════════════════

const TAX_RATE = 0.10;

// ═══════════════════════════════════════════════════════════════════════════════
// LOG CHANNELS  — hardcoded channel IDs for deposit/withdraw logs
// ═══════════════════════════════════════════════════════════════════════════════

const DEPOSIT_LOG_CHANNEL  = '1491361597543682069';
const WITHDRAW_LOG_CHANNEL = '1491361656402477056';

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT CONVERSION  — 1k=1,000 | 1m=1,000,000 | 1b=1,000,000,000 | 1t=1,000,000,000,000
// ═══════════════════════════════════════════════════════════════════════════════

function parseAmount(str) {
  if (typeof str === 'number') return Math.floor(str);
  const s = String(str).trim().toLowerCase().replace(/,/g, '');
  const units = { k: 1_000, m: 1_000_000, b: 1_000_000_000, t: 1_000_000_000_000 };
  const match = s.match(/^(\d+(?:\.\d+)?)([kmbt]?)$/);
  if (!match) return NaN;
  const num  = parseFloat(match[1]);
  const mult = units[match[2]] || 1;
  return Math.floor(num * mult);
}

function calcTax(bet) {
  const tax        = Math.max(1, Math.floor(bet * TAX_RATE));
  const winnerGain = bet - tax;
  const loserLoss  = bet;
  return { tax, winnerGain, loserLoss };
}

function settleGame(winnerId, loserId, bet) {
  const { tax, winnerGain, loserLoss } = calcTax(bet);
  const winnerNewBal = adjustBalance(winnerId,  winnerGain);
  const loserNewBal  = adjustBalance(loserId,  -loserLoss);
  updateUserStats(winnerId, { wagered: bet, profit:  winnerGain });
  updateUserStats(loserId,  { wagered: bet, profit: -loserLoss });
  return { tax, winnerGain, loserLoss, winnerNewBal, loserNewBal };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CARD HELPERS (Blackjack)
// ═══════════════════════════════════════════════════════════════════════════════

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ suit, rank });
  return deck.sort(() => Math.random() - 0.5);
}

function cardValue(rank) {
  if (['J', 'Q', 'K'].includes(rank)) return 10;
  if (rank === 'A') return 11;
  return parseInt(rank);
}

function handTotal(hand) {
  let total = hand.reduce((sum, c) => sum + cardValue(c.rank), 0);
  let aces  = hand.filter(c => c.rank === 'A').length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function formatHand(hand) {
  return hand.map(c => `\`${c.rank}${c.suit}\``).join(' ');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVE GAMES & SECURITY
// ═══════════════════════════════════════════════════════════════════════════════

const activeGames   = new Map();
const pendingProofs = new Map(); // userId → { amount, requestId, channelId, timeoutId }
const pendingDenials    = new Map(); // shortId → denial context (avoids Discord 100-char customId limit)
const processedDeposits = new Set(); // requestIds already handled — prevents double-processing

function genId() { return Math.random().toString(36).slice(2, 10); }

// Returns true if the user already has a pending challenge or live game
function isUserInGame(userId) {
  for (const [, g] of activeGames) {
    if (g.challenger === userId || g.opponent === userId) return true;
  }
  return false;
}

// Track challenges per pair so one person can't spam-challenge the same target
function hasActiveChallengeAgainst(challengerId, opponentId) {
  for (const [, g] of activeGames) {
    if (g.game && !g.game.startsWith('cf-live') && !g.game.startsWith('mines-live') && !g.game.startsWith('bj-live')) {
      if (g.challenger === challengerId && g.opponent === opponentId) return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOT SETUP
// ═══════════════════════════════════════════════════════════════════════════════

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
client.once('clientReady', () => console.log(`Logged in as ${client.user.tag}`));
client.on('error', err => console.error('Discord client error:', err));

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN CHANNEL LOG HELPER
// ═══════════════════════════════════════════════════════════════════════════════

async function logToStaff(content, embeds = []) {
  const id = getStaffChannelId();
  if (!id) return;
  const ch = await client.channels.fetch(id).catch(() => null);
  if (ch) await ch.send({ content, embeds }).catch(() => {});
}

async function logToDepositChannel(embeds = []) {
  const ch = await client.channels.fetch(DEPOSIT_LOG_CHANNEL).catch(() => null);
  if (ch) await ch.send({ embeds }).catch(() => {});
}

async function logToWithdrawChannel(embeds = []) {
  const ch = await client.channels.fetch(WITHDRAW_LOG_CHANNEL).catch(() => null);
  if (ch) await ch.send({ embeds }).catch(() => {});
}

async function dmUser(userId, embeds = []) {
  try {
    const user = await client.users.fetch(userId);
    const dm   = await user.createDM();
    await dm.send({ embeds });
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERACTION ROUTER
// ═══════════════════════════════════════════════════════════════════════════════

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      if (commandName === 'balance')           return handleBalance(interaction);
      if (commandName === 'link')              return handleLink(interaction);
      if (commandName === 'unlink')            return handleUnlink(interaction);
      if (commandName === 'withdraw')          return handleWithdraw(interaction);
      if (commandName === 'request-deposit')   return handleRequestDeposit(interaction);
      if (commandName === 'pvp-coinflip')      return handleCoinflipChallenge(interaction);
      if (commandName === 'pvp-mines')         return handleMinesChallenge(interaction);
      if (commandName === 'pvp-blackjack')     return handleBlackjackChallenge(interaction);
      if (commandName === 'deposit')           return handleAdminDeposit(interaction);
      if (commandName === 'confirm-withdraw')  return handleConfirmWithdraw(interaction);
      if (commandName === 'add-admin')         return handleAddAdmin(interaction);
      if (commandName === 'set-staff-channel') return handleSetStaffChannel(interaction);
      if (commandName === 'leaderboard')       return handleLeaderboard(interaction);
      if (commandName === 'tip')               return handleTip(interaction);
      if (commandName === 'pvp-rps')           return handleRpsChallenge(interaction);
      if (commandName === 'bounty')            return handleBounty(interaction);
      if (commandName === 'inventory')         return handleInventory(interaction);
      if (commandName === 'give-item')         return handleGiveItem(interaction);
      if (commandName === 'remove-item')       return handleRemoveItem(interaction);
    }

    if (interaction.isButton()) {
      const colonIdx = interaction.customId.indexOf(':');
      if (colonIdx === -1) return;
      const action = interaction.customId.slice(0, colonIdx);
      const rest   = interaction.customId.slice(colonIdx + 1);

      if (action === 'accept' || action === 'decline')
        return handleChallengeResponse(interaction, action, rest);
      if (action === 'cf_pick') {
        const lc = rest.lastIndexOf(':');
        return handleCoinflipPick(interaction, rest.slice(0, lc), rest.slice(lc + 1));
      }
      if (action === 'mine') {
        const lc = rest.lastIndexOf(':');
        return handleMineClick(interaction, rest.slice(0, lc), rest.slice(lc + 1));
      }
      if (action === 'bj_hit' || action === 'bj_stand')
        return handleBlackjackAction(interaction, action, rest);
      if (action === 'wd_confirm' || action === 'wd_deny')
        return handleWithdrawButton(interaction, action, rest);
      if (action === 'dep_confirm' || action === 'dep_deny')
        return handleDepositButton(interaction, action, rest);
      if (action === 'rps_move') {
        const lc = rest.lastIndexOf(':');
        return handleRpsMove(interaction, rest.slice(0, lc), rest.slice(lc + 1));
      }
    }

    if (interaction.isModalSubmit()) {
      const colonIdx = interaction.customId.indexOf(':');
      if (colonIdx === -1) return;
      const action = interaction.customId.slice(0, colonIdx);
      const rest   = interaction.customId.slice(colonIdx + 1);
      if (action === 'wd_reason')  return handleWithdrawDenyModal(interaction, rest);
      if (action === 'dep_reason') return handleDepositDenyModal(interaction, rest);
    }
  } catch (err) {
    console.error(err);
    const msg = { content: '❌ Something went wrong. Please try again.', flags: 64 };
    if (interaction.replied || interaction.deferred) interaction.followUp(msg).catch(() => {});
    else interaction.reply(msg).catch(() => {});
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN GUARD
// ═══════════════════════════════════════════════════════════════════════════════

function guardAdmin(interaction) {
  if (!isAdmin(interaction.user.id)) {
    interaction.reply({ content: '🔒 **Access Denied.** Admin only.', flags: 64 });
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// /balance  — rich stats card with Roblox or Discord avatar
// ═══════════════════════════════════════════════════════════════════════════════

async function handleBalance(interaction) {
  const target    = interaction.options.getUser('user') || interaction.user;
  const data      = getUserData(target.id);
  const badge     = isAdmin(target.id) ? ' 🔑' : '';
  const gems      = data.gems      || 0;
  const wagered   = data.wagered   || 0;
  const profit    = data.profit    || 0;
  const deposited = data.deposited || 0;
  const withdrawn = data.withdrawn || 0;

  // Avatar: Roblox if linked, Discord otherwise
  let avatarUrl    = target.displayAvatarURL({ size: 256 });
  let linkedLabel  = 'Not Linked';
  if (data.robloxId) {
    const rbxAvatar = await getRobloxAvatarUrl(data.robloxId);
    if (rbxAvatar) avatarUrl = rbxAvatar;
    linkedLabel = data.robloxUsername;
  }

  const profitSign  = profit >= 0 ? '+' : '';
  const profitColor = profit >= 0 ? 0x2ECC40 : 0xE74C3C;

  const embed = new EmbedBuilder()
    .setColor(profitColor)
    .setTitle(`💎 ${target.username}'s Stats${badge}`)
    .setThumbnail(avatarUrl)
    .addFields(
      { name: '💎 Balance',      value: `**${gems.toLocaleString()} 💎**`,               inline: false },
      { name: '📥 Deposited',    value: `${deposited.toLocaleString()} 💎`,               inline: true  },
      { name: '📤 Withdrawn',    value: `${withdrawn.toLocaleString()} 💎`,               inline: true  },
      { name: '\u200b',          value: '\u200b',                                          inline: true  },
      { name: '🎲 Wagered',      value: `${wagered.toLocaleString()} 💎`,                 inline: true  },
      { name: `📈 Profit`,       value: `${profitSign}${profit.toLocaleString()} 💎`,     inline: true  },
      { name: '\u200b',          value: '\u200b',                                          inline: true  },
      { name: '🎮 Linked Account', value: data.robloxId ? `**${linkedLabel}**` : '*Not linked — use /link*', inline: false },
    )
    .setFooter({ text: 'New players start with 500 Gems  •  10% tax on all winnings' })
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// /leaderboard  — top 10 by chosen category
// ═══════════════════════════════════════════════════════════════════════════════

const LB_META = {
  gems:      { label: '💰 Top Cash',      emoji: '💎', color: 0xF1C40F },
  wagered:   { label: '🎲 Top Wagered',   emoji: '💎', color: 0x9B59B6 },
  deposited: { label: '📥 Top Deposited', emoji: '💎', color: 0x3498DB },
  withdrawn: { label: '📤 Top Withdrawn', emoji: '💎', color: 0xE67E22 },
};

const MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

async function handleLeaderboard(interaction) {
  await interaction.deferReply();

  const category = interaction.options.getString('category');
  const meta     = LB_META[category];
  const { users = {} } = readDB();

  // Sort all users by the chosen field, descending — admins excluded
  const ranked = Object.entries(users)
    .filter(([id]) => !isAdmin(id))
    .map(([id, data]) => ({ id, value: data[category] || 0 }))
    .filter(u => u.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  if (ranked.length === 0)
    return interaction.editReply({ content: '📭 No data yet for this category.' });

  // Resolve Discord usernames — fetch members from cache or via API
  const guild = interaction.guild;
  const lines = await Promise.all(ranked.map(async (entry, i) => {
    let name = `<@${entry.id}>`;
    try {
      const member = guild
        ? (guild.members.cache.get(entry.id) || await guild.members.fetch(entry.id).catch(() => null))
        : null;
      if (member) name = member.displayName;
    } catch { /* keep mention fallback */ }

    return `${MEDALS[i]} **${name}** — ${entry.value.toLocaleString()} ${meta.emoji}`;
  }));

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.label} Leaderboard`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Top ${ranked.length} players  •  HappyVault` })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// /tip  — send gems to another player
// ═══════════════════════════════════════════════════════════════════════════════

const TIP_LOG_CHANNEL = '1491714398979493928';

async function handleTip(interaction) {
  const sender    = interaction.user;
  const recipient = interaction.options.getUser('user');
  const amountStr = interaction.options.getString('amount');

  // ── Anti-exploit checks ────────────────────────────────────────────────────
  if (recipient.id === sender.id)
    return interaction.reply({ content: '❌ You cannot tip yourself.', flags: 64 });

  if (recipient.bot)
    return interaction.reply({ content: '❌ You cannot tip a bot.', flags: 64 });

  const amount = parseAmount(amountStr);
  if (!amount || amount <= 0)
    return interaction.reply({ content: '❌ Enter a valid positive amount (e.g. `500`, `1k`, `2.5m`).', flags: 64 });

  const senderData = getUserData(sender.id);
  if (senderData.gems < amount)
    return interaction.reply({
      content: `❌ You only have **${senderData.gems.toLocaleString()} 💎** — not enough to tip that amount.`,
      flags: 64,
    });

  // ── Transfer ───────────────────────────────────────────────────────────────
  adjustBalance(sender.id,    -amount);
  adjustBalance(recipient.id,  amount);

  const newSenderBal    = getBalance(sender.id);
  const newRecipientBal = getBalance(recipient.id);

  // ── Success reply ──────────────────────────────────────────────────────────
  const successEmbed = new EmbedBuilder()
    .setColor(0x2ECC71)
    .setTitle('💸 Tip Sent!')
    .setDescription(`**${sender.username}** tipped **${amount.toLocaleString()} 💎** to **${recipient.username}**`)
    .addFields(
      { name: `${sender.username}'s new balance`,    value: `${newSenderBal.toLocaleString()} 💎`,    inline: true },
      { name: `${recipient.username}'s new balance`, value: `${newRecipientBal.toLocaleString()} 💎`, inline: true },
    )
    .setTimestamp();

  await interaction.reply({ embeds: [successEmbed] });

  // ── Log to tip channel ─────────────────────────────────────────────────────
  try {
    const logChannel = await client.channels.fetch(TIP_LOG_CHANNEL);
    const logEmbed = new EmbedBuilder()
      .setColor(0x3498DB)
      .setTitle('💸 Tip Log')
      .addFields(
        { name: 'From',   value: `${sender.username} (<@${sender.id}>)`,       inline: true },
        { name: 'To',     value: `${recipient.username} (<@${recipient.id}>)`, inline: true },
        { name: 'Amount', value: `${amount.toLocaleString()} 💎`,              inline: true },
        { name: `${sender.username} Balance`,    value: `${newSenderBal.toLocaleString()} 💎`,    inline: true },
        { name: `${recipient.username} Balance`, value: `${newRecipientBal.toLocaleString()} 💎`, inline: true },
      )
      .setFooter({ text: `Server: ${interaction.guild?.name || 'DM'}` })
      .setTimestamp();
    await logChannel.send({ embeds: [logEmbed] });
  } catch (err) {
    console.error('[tip] Failed to send log:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// /link  — link Roblox account
// ═══════════════════════════════════════════════════════════════════════════════

async function handleLink(interaction) {
  await interaction.deferReply({ flags: 64 });

  const username  = interaction.options.getString('username').trim();
  const rbxUser   = await lookupRobloxUser(username);

  if (!rbxUser) {
    return interaction.editReply({
      content: `❌ Couldn't find a Roblox user called **${username}**. Double-check the username and try again.`,
    });
  }

  const avatarUrl = await getRobloxAvatarUrl(rbxUser.id);
  setRobloxLink(interaction.user.id, rbxUser.id, rbxUser.name);

  const embed = new EmbedBuilder()
    .setColor(0x2ECC40)
    .setTitle('✅ Roblox Account Linked!')
    .setDescription(`Your balance card will now show your Roblox avatar.`)
    .setThumbnail(avatarUrl || null)
    .addFields(
      { name: 'Roblox Username', value: `**${rbxUser.name}**`,         inline: true },
      { name: 'Display Name',    value: `${rbxUser.displayName}`,       inline: true },
      { name: 'Roblox ID',       value: `\`${rbxUser.id}\``,            inline: true },
    )
    .setFooter({ text: 'Use /unlink to remove your Roblox account at any time.' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// /unlink  — remove Roblox link
// ═══════════════════════════════════════════════════════════════════════════════

function handleUnlink(interaction) {
  const data = getUserData(interaction.user.id);
  if (!data.robloxId) {
    return interaction.reply({ content: '❌ You don\'t have a Roblox account linked.', flags: 64 });
  }
  const name = data.robloxUsername;
  clearRobloxLink(interaction.user.id);
  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x95A5A6)
      .setTitle('🔗 Roblox Account Unlinked')
      .setDescription(`**${name}** has been unlinked. Your balance card will now show your Discord avatar.`)
      .setTimestamp()],
    flags: 64,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// /set-staff-channel  (admin)
// ═══════════════════════════════════════════════════════════════════════════════

function handleSetStaffChannel(interaction) {
  if (!guardAdmin(interaction)) return;
  const channel = interaction.options.getChannel('channel');
  setStaffChannelId(channel.id);
  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x3498DB).setTitle('✅ Staff Channel Set')
      .setDescription(`Withdrawal requests, deposit tickets, and mine logs will appear in <#${channel.id}>.`)
      .setTimestamp()],
    flags: 64,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// /add-admin  (admin)
// ═══════════════════════════════════════════════════════════════════════════════

function handleAddAdmin(interaction) {
  if (!guardAdmin(interaction)) return;
  const target = interaction.options.getUser('user');
  if (target.bot) return interaction.reply({ content: '❌ Cannot make a bot an admin.', flags: 64 });
  const added = addAdmin(target.id);
  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(added ? 0x2ECC40 : 0x95A5A6)
      .setTitle(added ? '✅ Admin Added' : 'ℹ️ Already an Admin')
      .setDescription(added ? `<@${target.id}> granted admin access.` : `<@${target.id}> is already an admin.`)
      .setTimestamp()],
    flags: 64,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// /deposit  (admin)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleAdminDeposit(interaction) {
  if (!guardAdmin(interaction)) return;
  const target = interaction.options.getUser('user');
  const raw    = interaction.options.getString('amount');
  const amount = parseAmount(raw);

  if (isNaN(amount) || amount <= 0)
    return interaction.reply({ content: '❌ Invalid amount.', flags: 64 });

  const newBal = adjustBalance(target.id, amount);
  updateUserStats(target.id, { deposited: amount });

  const logEmbed = new EmbedBuilder()
    .setColor(0x2ECC40).setTitle('📥 Deposit Log')
    .addFields(
      { name: 'Player',      value: `<@${target.id}>`,                   inline: true },
      { name: 'Amount',      value: `**+${amount.toLocaleString()} 💎**`, inline: true },
      { name: 'New Balance', value: `**${newBal.toLocaleString()} 💎**`,  inline: true },
      { name: 'Approved by', value: `<@${interaction.user.id}>`,          inline: true },
    ).setTimestamp();

  await logToDepositChannel([logEmbed]);
  return interaction.reply({ embeds: [logEmbed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// /withdraw  (user)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleWithdraw(interaction) {
  const raw     = interaction.options.getString('amount');
  const amount  = parseAmount(raw);

  if (isNaN(amount) || amount <= 0)
    return interaction.reply({ content: '❌ Invalid amount. Use a positive number, e.g. `500`, `1k`, `2.5m`.', flags: 64 });

  // Prevent duplicate pending withdrawals from the same user
  const db = readDB();
  const hasPending = Object.values(db.pendingWithdrawals || {}).some(w => w.userId === interaction.user.id);
  if (hasPending)
    return interaction.reply({ content: '❌ You already have a pending withdrawal. Please wait for it to be processed.', flags: 64 });

  const balance = getBalance(interaction.user.id);

  if (balance < amount)
    return interaction.reply({
      content: `❌ You only have **${balance.toLocaleString()} 💎** — not enough to withdraw **${amount.toLocaleString()} 💎**.`,
      flags: 64,
    });

  const requestId   = `wd-${interaction.user.id}-${Date.now()}`;
  addPendingWithdrawal(interaction.user.id, amount, requestId);

  const { admins = [] } = readDB();
  const adminMentions   = admins.map(id => `<@${id}>`).join(' ');

  const staffEmbed = new EmbedBuilder()
    .setColor(0xE74C3C).setTitle('📤 Withdrawal Request')
    .setThumbnail(interaction.user.displayAvatarURL())
    .addFields(
      { name: 'User',            value: `<@${interaction.user.id}>`,         inline: true },
      { name: 'Amount',          value: `**${amount.toLocaleString()} 💎**`,  inline: true },
      { name: 'Current Balance', value: `**${balance.toLocaleString()} 💎**`, inline: true },
      { name: 'Request ID',      value: `\`${requestId}\``,                  inline: false },
    )
    .setFooter({ text: 'Use the buttons below or /confirm-withdraw to process this.' })
    .setTimestamp();

  const wdRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wd_confirm:${requestId}`).setLabel('✅ Confirm & Deduct').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`wd_deny:${requestId}`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger),
  );

  const staffId = getStaffChannelId();
  if (staffId) {
    const ch = await client.channels.fetch(staffId).catch(() => null);
    if (ch) await ch.send({ content: `📢 ${adminMentions} — new withdrawal request!`, embeds: [staffEmbed], components: [wdRow] }).catch(() => {});
  }

  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xF39C12).setTitle('⏳ Withdrawal Request Submitted')
      .setDescription(`Your request to withdraw **${amount.toLocaleString()} 💎** has been sent to staff.\nGems are only deducted after an admin confirms.`)
      .addFields({ name: 'Request ID', value: `\`${requestId}\`` })
      .setTimestamp()],
    flags: 64,
  });
}

async function handleWithdrawButton(interaction, action, requestId) {
  if (!isAdmin(interaction.user.id))
    return interaction.reply({ content: '🔒 Only admins can process withdrawals.', flags: 64 });

  const db      = readDB();
  const pending = db.pendingWithdrawals?.[requestId];
  if (!pending)
    return interaction.reply({ content: '❌ Already processed or expired.', flags: 64 });

  const { userId, amount } = pending;

  if (action === 'wd_deny') {
    // Show modal FIRST (no defer needed — modal is the response)
    const denialId = genId();
    pendingDenials.set(denialId, {
      type: 'wd', requestId, userId, amount,
      channelId: interaction.channelId,
      messageId: interaction.message.id,
    });
    const modal = new ModalBuilder()
      .setCustomId(`wd_reason:${denialId}`)
      .setTitle('Withdrawal Rejection Reason');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Reason for rejection (sent to user via DM)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500)
    ));
    return interaction.showModal(modal);
  }

  // wd_confirm — defer the update first to avoid 3-second timeout
  await interaction.deferUpdate();

  delete db.pendingWithdrawals[requestId];
  writeDB(db);

  const balance = getBalance(userId);
  if (balance < amount) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('❌ Withdrawal Failed — Insufficient Balance')
        .setDescription(`<@${userId}> only has **${balance.toLocaleString()} 💎** but requested **${amount.toLocaleString()} 💎**. Cancelled.`).setTimestamp()],
      components: [],
    });
  }

  const newBal = adjustBalance(userId, -amount);
  updateUserStats(userId, { withdrawn: amount });

  const logEmbed = new EmbedBuilder()
    .setColor(0xE74C3C).setTitle('📤 Withdraw Log')
    .addFields(
      { name: 'Player',      value: `<@${userId}>`,                      inline: true },
      { name: 'Amount',      value: `**${amount.toLocaleString()} 💎**`,  inline: true },
      { name: 'New Balance', value: `**${newBal.toLocaleString()} 💎**`,  inline: true },
      { name: 'Approved by', value: `<@${interaction.user.id}>`,          inline: true },
    ).setTimestamp();

  await logToWithdrawChannel([logEmbed]);
  await dmUser(userId, [new EmbedBuilder()
    .setColor(0x2ECC40).setTitle('✅ Withdrawal Approved')
    .setDescription(`Your withdrawal of **${amount.toLocaleString()} 💎** has been approved by <@${interaction.user.id}>.`)
    .setTimestamp()]);

  return interaction.editReply({ embeds: [logEmbed], components: [] });
}

async function handleWithdrawDenyModal(interaction, denialId) {
  await interaction.deferReply({ flags: 64 });

  const data = pendingDenials.get(denialId);
  if (!data) return interaction.editReply({ content: '❌ Denial session expired. Please try again.' });
  pendingDenials.delete(denialId);

  const { requestId, userId, amount, channelId, messageId } = data;
  const reason = interaction.fields.getTextInputValue('reason');

  const db = readDB();
  delete db.pendingWithdrawals?.[requestId];
  writeDB(db);

  const denyEmbed = new EmbedBuilder()
    .setColor(0x95A5A6).setTitle('❌ Withdrawal Denied')
    .setDescription(`<@${userId}>'s withdrawal of **${amount.toLocaleString()} 💎** was denied by <@${interaction.user.id}>.`)
    .addFields({ name: 'Reason', value: reason })
    .setTimestamp();

  try {
    const ch  = await client.channels.fetch(channelId);
    const msg = await ch.messages.fetch(messageId);
    await msg.edit({ embeds: [denyEmbed], components: [] });
  } catch {}

  await dmUser(userId, [new EmbedBuilder()
    .setColor(0xE74C3C).setTitle('❌ Withdrawal Rejected')
    .setDescription(`Your withdrawal request of **${amount.toLocaleString()} 💎** was rejected.`)
    .addFields({ name: 'Reason', value: reason })
    .setFooter({ text: 'Rejected by an admin' })
    .setTimestamp()]);

  return interaction.editReply({ content: '✅ Rejection sent and user has been DM\'d.' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// /confirm-withdraw  (admin slash command)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleConfirmWithdraw(interaction) {
  if (!guardAdmin(interaction)) return;
  const target  = interaction.options.getUser('user');
  const raw     = interaction.options.getString('amount');
  const amount  = parseAmount(raw);

  if (isNaN(amount) || amount <= 0)
    return interaction.reply({ content: '❌ Invalid amount.', flags: 64 });

  const balance = getBalance(target.id);

  if (balance < amount)
    return interaction.reply({
      content: `❌ <@${target.id}> only has **${balance.toLocaleString()} 💎** — cannot deduct **${amount.toLocaleString()} 💎**.`,
      flags: 64,
    });

  const newBal = adjustBalance(target.id, -amount);
  updateUserStats(target.id, { withdrawn: amount });

  const logEmbed = new EmbedBuilder().setColor(0xE74C3C).setTitle('📤 Withdraw Log')
    .addFields(
      { name: 'Player',       value: `<@${target.id}>`,                   inline: true },
      { name: 'Amount',       value: `**${amount.toLocaleString()} 💎**`,  inline: true },
      { name: 'New Balance',  value: `**${newBal.toLocaleString()} 💎**`,  inline: true },
      { name: 'Approved by',  value: `<@${interaction.user.id}>`,          inline: true },
    ).setTimestamp();

  await logToWithdrawChannel([logEmbed]);
  await dmUser(target.id, [new EmbedBuilder()
    .setColor(0x2ECC40).setTitle('✅ Withdrawal Approved')
    .setDescription(`Your withdrawal of **${amount.toLocaleString()} 💎** has been approved by <@${interaction.user.id}>.`)
    .setTimestamp()]);

  return interaction.reply({ embeds: [logEmbed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// /request-deposit  (user)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleRequestDeposit(interaction) {
  const raw    = interaction.options.getString('amount');
  const amount = parseAmount(raw);

  if (isNaN(amount) || amount <= 0)
    return interaction.reply({ content: '❌ Invalid amount. Use a positive number, e.g. `500`, `1k`, `2.5m`.', flags: 64 });

  if (pendingProofs.has(interaction.user.id))
    return interaction.reply({ content: '❌ You already have a pending deposit request. Please send your proof first or wait for it to expire.', flags: 64 });

  const requestId = `dep-${interaction.user.id}-${Date.now()}`;

  // Auto-expire after 10 minutes if no proof is sent
  const timeoutId = setTimeout(() => {
    pendingProofs.delete(interaction.user.id);
  }, 10 * 60 * 1000);

  pendingProofs.set(interaction.user.id, {
    amount,
    requestId,
    channelId: interaction.channelId,
    timeoutId,
  });

  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x3498DB).setTitle('📥 Deposit Request — Send Your Proof')
      .setDescription(
        `Your request for **${amount.toLocaleString()} 💎** has been received!\n\n` +
        `***Send gems to Promanbeastboy2 then send screenshot of mail in this channel***\n\n` +
        `The bot will automatically forward your screenshot to the admin team for review.`
      )
      .addFields({ name: 'Request ID', value: `\`${requestId}\`` })
      .setFooter({ text: 'You have 10 minutes to send your proof.' })
      .setTimestamp()],
    flags: 64,
  });
}

async function handleDepositButton(interaction, action, rest) {
  if (!isAdmin(interaction.user.id))
    return interaction.reply({ content: '🔒 Only admins can process deposit requests.', flags: 64 });

  // rest format: requestId:userId:amount
  const parts     = rest.split(':');
  const requestId = parts[0];
  const userId    = parts[1];
  const amount    = parseInt(parts[2]);

  if (action === 'dep_deny') {
    // Show modal FIRST (no defer needed — modal is the response)
    const denialId = genId();
    pendingDenials.set(denialId, {
      type: 'dep', requestId, userId, amount,
      channelId: interaction.channelId,
      messageId: interaction.message.id,
    });
    const modal = new ModalBuilder()
      .setCustomId(`dep_reason:${denialId}`)
      .setTitle('Deposit Rejection Reason');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Reason for rejection (sent to user via DM)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500)
    ));
    return interaction.showModal(modal);
  }

  // dep_confirm — block double-processing then defer
  if (processedDeposits.has(requestId))
    return interaction.reply({ content: '❌ This deposit has already been processed by another admin.', flags: 64 });
  processedDeposits.add(requestId);
  setTimeout(() => processedDeposits.delete(requestId), 60 * 60 * 1000);

  await interaction.deferUpdate();

  await interaction.message.unpin().catch(() => {});

  const newBal = adjustBalance(userId, amount);
  updateUserStats(userId, { deposited: amount });

  const logEmbed = new EmbedBuilder().setColor(0x2ECC40).setTitle('📥 Deposit Log')
    .addFields(
      { name: 'Player',      value: `<@${userId}>`,                      inline: true },
      { name: 'Amount',      value: `**+${amount.toLocaleString()} 💎**`, inline: true },
      { name: 'New Balance', value: `**${newBal.toLocaleString()} 💎**`,  inline: true },
      { name: 'Approved by', value: `<@${interaction.user.id}>`,          inline: true },
    ).setTimestamp();

  await logToDepositChannel([logEmbed]);
  await dmUser(userId, [new EmbedBuilder()
    .setColor(0x2ECC40).setTitle('✅ Deposit Approved')
    .setDescription(`Your deposit of **${amount.toLocaleString()} 💎** has been approved by <@${interaction.user.id}>.`)
    .setTimestamp()]);

  return interaction.editReply({ embeds: [logEmbed], components: [] });
}

async function handleDepositDenyModal(interaction, denialId) {
  await interaction.deferReply({ flags: 64 });

  const data = pendingDenials.get(denialId);
  if (!data) return interaction.editReply({ content: '❌ Denial session expired. Please try again.' });
  pendingDenials.delete(denialId);

  const { requestId, userId, amount, channelId, messageId } = data;

  // Block double-processing — another admin may have confirmed while this modal was open
  if (processedDeposits.has(requestId))
    return interaction.editReply({ content: '❌ This deposit has already been processed by another admin.' });
  processedDeposits.add(requestId);
  setTimeout(() => processedDeposits.delete(requestId), 60 * 60 * 1000);
  const reason = interaction.fields.getTextInputValue('reason');

  const denyEmbed = new EmbedBuilder()
    .setColor(0x95A5A6).setTitle('❌ Deposit Denied')
    .setDescription(`<@${userId}>'s deposit for **${amount.toLocaleString()} 💎** was denied by <@${interaction.user.id}>.`)
    .addFields({ name: 'Reason', value: reason })
    .setTimestamp();

  try {
    const ch  = await client.channels.fetch(channelId);
    const msg = await ch.messages.fetch(messageId);
    await msg.unpin().catch(() => {});
    await msg.edit({ embeds: [denyEmbed], components: [] });
  } catch {}

  await dmUser(userId, [new EmbedBuilder()
    .setColor(0xE74C3C).setTitle('❌ Deposit Request Rejected')
    .setDescription(`Your deposit request of **${amount.toLocaleString()} 💎** was rejected.`)
    .addFields({ name: 'Reason', value: reason })
    .setFooter({ text: 'Rejected by an admin' })
    .setTimestamp()]);

  return interaction.editReply({ content: '✅ Rejection sent and user has been DM\'d.' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHALLENGE SYSTEM  (shared accept/decline + security checks)
// ═══════════════════════════════════════════════════════════════════════════════

const GAME_COLORS = { coinflip: 0xF4C430, mines: 0xFF4136, blackjack: 0x2ECC40, rps: 0xE91E63 };
const GAME_EMOJIS = { coinflip: '🪙', mines: '💣', blackjack: '🃏', rps: '✊' };
const GAME_NAMES  = { coinflip: 'Coin Flip', mines: 'Mines', blackjack: 'Blackjack', rps: 'Rock Paper Scissors' };

const BOUNTY_LOG_CHANNEL = '1491727743665180713';

// ── Bonus item helpers (optional extra item wagered by challenger only) ────────

async function readBonusItem(interaction) {
  const raw = interaction.options.getString('item');
  if (!raw) return {};
  const itemId = raw.toLowerCase().trim().replace(/ /g, '_');
  const qty    = interaction.options.getInteger('quantity') || 1;
  const meta   = await resolveItemMeta(itemId).catch(() => null);
  const value  = Math.floor((meta?.value || 0) * qty);
  return { bonusItem: itemId, bonusItemName: meta?.name || itemId, bonusQty: qty, bonusIcon: meta?.icon || null, bonusValue: value };
}

function settleBonusItem(game, winnerId) {
  if (!game.bonusItem) return;
  addInventoryItem(winnerId, game.bonusItem, game.bonusQty);
}

function returnBonusItem(game) {
  if (!game.bonusItem) return;
  addInventoryItem(game.challenger, game.bonusItem, game.bonusQty);
}

// ─────────────────────────────────────────────────────────────────────────────

async function sendChallenge(interaction, game, challenger, opponent, bet, extraData = {}) {
  // ── Security checks ─────────────────────────────────────────────────────────
  if (challenger.id === opponent.id)
    return interaction.reply({ content: '❌ You cannot challenge yourself.', flags: 64 });
  if (opponent.bot)
    return interaction.reply({ content: '❌ You cannot challenge a bot.', flags: 64 });

  if (isUserInGame(challenger.id))
    return interaction.reply({ content: '❌ You are already in an active game or have a pending challenge. Finish it first!', flags: 64 });
  if (isUserInGame(opponent.id))
    return interaction.reply({ content: `❌ <@${opponent.id}> is already in an active game or has a pending challenge.`, flags: 64 });

  const challengerBal = getBalance(challenger.id);
  const opponentBal   = getBalance(opponent.id);

  if (challengerBal < bet)
    return interaction.reply({ content: `❌ You only have **${challengerBal.toLocaleString()} 💎** — not enough for a **${bet.toLocaleString()} 💎** bet.`, flags: 64 });
  if (opponentBal < bet)
    return interaction.reply({ content: `❌ <@${opponent.id}> only has **${opponentBal.toLocaleString()} 💎** — they can't cover the **${bet.toLocaleString()} 💎** bet.`, flags: 64 });

  // ── Bonus item validation ─────────────────────────────────────────────────
  const { bonusItem, bonusItemName, bonusQty, bonusIcon } = extraData;
  if (bonusItem) {
    const inv = getInventory(challenger.id);
    if ((inv[bonusItem] || 0) < bonusQty)
      return interaction.reply({
        content: `❌ You only have **x${inv[bonusItem] || 0}** of \`${bonusItem}\` in your inventory — not enough to wager x${bonusQty}.`,
        flags: 64,
      });
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const { tax } = calcTax(bet);
  const gameId  = `${game}-${challenger.id}-${Date.now()}`;

  const extraFields = [];
  if (extraData.mineCount !== undefined)
    extraFields.push({ name: 'Mines', value: `**${extraData.mineCount}** 💣`, inline: true });
  if (bonusItem) {
    const totalValue = bet + (extraData.bonusValue || 0);
    extraFields.push(
      { name: '🎁 Bonus Pet', value: `**${bonusItemName}** x${bonusQty}`, inline: true },
      { name: '💰 Pet Value',  value: extraData.bonusValue ? `~**${extraData.bonusValue.toLocaleString()} 💎**` : '*Unknown*', inline: true },
      { name: '💎 Total Stakes', value: `~**${totalValue.toLocaleString()} 💎** per side`, inline: true },
    );
  }

  const embed = new EmbedBuilder()
    .setColor(GAME_COLORS[game])
    .setTitle(`${GAME_EMOJIS[game]} PvP ${GAME_NAMES[game]} Challenge!`)
    .setDescription(`<@${challenger.id}> has challenged <@${opponent.id}> to **${GAME_NAMES[game]}**!\n${bonusItem ? '🎁 *Challenger adds a bonus pet — winner takes gems + pet!*' : ''}`)
    .addFields(
      { name: '💎 Gem Bet',    value: `**${bet.toLocaleString()} 💎**`,              inline: true },
      { name: '🏆 Gem Payout', value: `**~${(bet * 2 - tax).toLocaleString()} 💎**`, inline: true },
      { name: '🏦 10% Tax',    value: `**${tax.toLocaleString()} 💎** burned`,        inline: true },
      ...extraFields,
    )
    .setFooter({ text: `${opponent.username}, you have 60 seconds to respond.` })
    .setTimestamp();

  if (bonusIcon) embed.setThumbnail(bonusIcon);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`accept:${gameId}`).setLabel('✅ Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`decline:${gameId}`).setLabel('❌ Decline').setStyle(ButtonStyle.Danger),
  );

  const { resource } = await interaction.reply({ embeds: [embed], components: [row], withResponse: true });
  const reply = resource.message;

  activeGames.set(gameId, {
    game, challenger: challenger.id, opponent: opponent.id, bet,
    messageId: reply.id, channelId: reply.channelId,
    ...extraData,
  });

  setTimeout(async () => {
    if (!activeGames.has(gameId)) return;
    activeGames.delete(gameId);
    await reply.edit({
      embeds: [new EmbedBuilder().setColor(0x95A5A6).setTitle('⏰ Challenge Expired')
        .setDescription(`<@${challenger.id}>'s challenge to <@${opponent.id}> timed out.`).setTimestamp()],
      components: [],
    }).catch(() => {});
  }, 60_000);
}

async function handleChallengeResponse(interaction, action, gameId) {
  const data = activeGames.get(gameId);
  if (!data)
    return interaction.reply({ content: '❌ This challenge has expired or already started.', flags: 64 });
  if (interaction.user.id !== data.opponent)
    return interaction.reply({ content: '❌ Only the challenged player can respond.', flags: 64 });

  if (action === 'decline') {
    activeGames.delete(gameId);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0x95A5A6).setTitle('Challenge Declined')
        .setDescription(`<@${data.opponent}> declined the challenge from <@${data.challenger}>.`)],
      components: [],
    });
  }

  // ── Re-validate both balances before starting ─────────────────────────────
  const challengerBal = getBalance(data.challenger);
  const opponentBal   = getBalance(data.opponent);

  if (challengerBal < data.bet) {
    activeGames.delete(gameId);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('❌ Game Cancelled — Insufficient Balance')
        .setDescription(`<@${data.challenger}> no longer has enough gems to cover the bet of **${data.bet} 💎** (they now have **${challengerBal} 💎**).`)
        .setTimestamp()],
      components: [],
    });
  }
  if (opponentBal < data.bet) {
    activeGames.delete(gameId);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('❌ Game Cancelled — Insufficient Balance')
        .setDescription(`<@${data.opponent}> no longer has enough gems to cover the bet of **${data.bet} 💎** (they now have **${opponentBal} 💎**).`)
        .setTimestamp()],
      components: [],
    });
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Escrow bonus item now so challenger can't spend it mid-game ─────────────
  if (data.bonusItem) {
    const inv = getInventory(data.challenger);
    if ((inv[data.bonusItem] || 0) < data.bonusQty) {
      activeGames.delete(gameId);
      return interaction.update({
        embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('❌ Game Cancelled — Bonus Item Gone')
          .setDescription(`<@${data.challenger}> no longer has enough **${data.bonusItemName}** to wager. Game cancelled.`)
          .setTimestamp()],
        components: [],
      });
    }
    removeInventoryItem(data.challenger, data.bonusItem, data.bonusQty);
  }
  // ─────────────────────────────────────────────────────────────────────────────

  activeGames.delete(gameId);

  if (data.game === 'coinflip')  return startCoinflip(interaction, data);
  if (data.game === 'mines')     return startMines(interaction, data);
  if (data.game === 'blackjack') return startBlackjack(interaction, data);
  if (data.game === 'rps')       return startRps(interaction, data);
}

// ═══════════════════════════════════════════════════════════════════════════════
// COIN FLIP  — challenger picks Heads / Tails after opponent accepts
// ═══════════════════════════════════════════════════════════════════════════════

async function handleCoinflipChallenge(interaction) {
  const bet = parseAmount(interaction.options.getString('bet'));
  if (isNaN(bet) || bet <= 0)
    return interaction.reply({ content: '❌ Invalid bet. Use a positive number, e.g. `500`, `1k`, `2.5m`.', flags: 64 });
  const { bonusItem, bonusItemName, bonusQty, bonusValue } = await readBonusItem(interaction);
  return sendChallenge(interaction, 'coinflip', interaction.user,
    interaction.options.getUser('opponent'), bet, { bonusItem, bonusItemName, bonusQty, bonusValue });
}

async function startCoinflip(interaction, data) {
  const liveId = `cf-live-${data.challenger}-${Date.now()}`;
  activeGames.set(liveId, { ...data, phase: 'picking' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cf_pick:${liveId}:heads`).setLabel('🦅 Heads').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`cf_pick:${liveId}:tails`).setLabel('🌕 Tails').setStyle(ButtonStyle.Success),
  );

  const pickEmbed = new EmbedBuilder()
    .setColor(0xF4C430)
    .setTitle('🪙 Coin Flip — Pick Your Side!')
    .setDescription(`<@${data.challenger}>, you sent the challenge — pick your side!\n<@${data.opponent}> automatically gets the other side.`)
    .addFields({ name: 'Bet', value: `${data.bet.toLocaleString()} 💎`, inline: true });
  if (data.bonusItem) {
    const totalValue = data.bet + (data.bonusValue || 0);
    pickEmbed.addFields(
      { name: '🎁 Bonus Pet',    value: `**${data.bonusItemName}** x${data.bonusQty} — winner takes it!`, inline: true },
      { name: '💰 Pet Value',    value: data.bonusValue ? `~${data.bonusValue.toLocaleString()} 💎` : '*Unknown*', inline: true },
      { name: '💎 Total Stakes', value: `~${totalValue.toLocaleString()} 💎`, inline: true },
    );
    if (data.bonusIcon) pickEmbed.setThumbnail(data.bonusIcon);
  }
  pickEmbed.setFooter({ text: 'You have 30 seconds to choose.' }).setTimestamp();

  await interaction.update({ embeds: [pickEmbed], components: [row] });

  setTimeout(async () => {
    const g = activeGames.get(liveId);
    if (!g || g.phase !== 'picking') return;
    activeGames.delete(liveId);
    returnBonusItem(g);
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x95A5A6).setTitle('⏰ Coin Flip Expired')
        .setDescription(`<@${data.challenger}> didn't pick a side in time. Game cancelled.${g.bonusItem ? ' Bonus item returned.' : ''}`)
        .setTimestamp()],
      components: [],
    }).catch(() => {});
  }, 30_000);
}

async function handleCoinflipPick(interaction, liveId, challengerSide) {
  const game = activeGames.get(liveId);
  if (!game)
    return interaction.reply({ content: '❌ Game session expired.', flags: 64 });
  if (interaction.user.id !== game.challenger)
    return interaction.reply({ content: '❌ Only the challenger picks the side!', flags: 64 });
  if (game.phase !== 'picking')
    return interaction.reply({ content: '❌ Side already chosen.', flags: 64 });

  game.phase = 'flipping';

  const opponentSide = challengerSide === 'heads' ? 'tails' : 'heads';
  const sideEmoji    = { heads: '🦅', tails: '🌕' };

  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(0xF4C430)
      .setTitle('🪙 Sides Chosen!')
      .setDescription(
        `<@${game.challenger}> → **${challengerSide.toUpperCase()} ${sideEmoji[challengerSide]}**\n` +
        `<@${game.opponent}> → **${opponentSide.toUpperCase()} ${sideEmoji[opponentSide]}**`
      )],
    components: [],
  });

  for (const frame of ['🌀 Flipping...', '🌀 Spinning...', '🌀 Almost...']) {
    await new Promise(r => setTimeout(r, 800));
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0xF4C430).setTitle('🪙 Coin Flip').setDescription(frame)],
    });
  }
  await new Promise(r => setTimeout(r, 900));

  const landedSide = Math.random() < 0.5 ? 'heads' : 'tails';
  const winnerId   = landedSide === challengerSide ? game.challenger : game.opponent;
  const loserId    = winnerId === game.challenger  ? game.opponent   : game.challenger;

  activeGames.delete(liveId);
  const { tax, winnerGain, winnerNewBal, loserNewBal } = settleGame(winnerId, loserId, game.bet);
  settleBonusItem(game, winnerId);
  checkBounty(winnerId, loserId, interaction.channelId).catch(() => {});

  const resultEmbed = new EmbedBuilder()
    .setColor(0xF4C430)
    .setTitle(`🪙 Coin Flip — ${landedSide.toUpperCase()} ${sideEmoji[landedSide]}!`)
    .setDescription(`The coin lands on **${landedSide.toUpperCase()} ${sideEmoji[landedSide]}**!`)
    .addFields(
      { name: `<@${game.challenger}>'s side`, value: `${challengerSide.toUpperCase()} ${sideEmoji[challengerSide]}`, inline: true },
      { name: `<@${game.opponent}>'s side`,   value: `${opponentSide.toUpperCase()} ${sideEmoji[opponentSide]}`,     inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: '🏆 Winner',    value: `<@${winnerId}> **+${winnerGain.toLocaleString()} 💎** → Balance: ${winnerNewBal.toLocaleString()} 💎` },
      { name: '💀 Loser',     value: `<@${loserId}> **-${game.bet.toLocaleString()} 💎** → Balance: ${loserNewBal.toLocaleString()} 💎` },
      { name: '🏦 Tax (10%)', value: `**${tax} 💎** burned`, inline: true },
    )
    .setTimestamp();
  if (game.bonusItem) {
    resultEmbed.addFields({ name: '🎁 Bonus Pet Won', value: `<@${winnerId}> also wins **${game.bonusItemName}** x${game.bonusQty}${game.bonusValue ? ` (~${game.bonusValue.toLocaleString()} 💎)` : ''}!`, inline: false });
    if (game.bonusIcon) resultEmbed.setThumbnail(game.bonusIcon);
  }

  await interaction.editReply({ embeds: [resultEmbed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MINES
// ═══════════════════════════════════════════════════════════════════════════════

async function handleMinesChallenge(interaction) {
  const bet = parseAmount(interaction.options.getString('bet'));
  if (isNaN(bet) || bet <= 0)
    return interaction.reply({ content: '❌ Invalid bet. Use a positive number, e.g. `500`, `1k`, `2.5m`.', flags: 64 });
  const mineCount = interaction.options.getInteger('mines') ?? 5;
  const { bonusItem, bonusItemName, bonusQty, bonusValue } = await readBonusItem(interaction);
  return sendChallenge(interaction, 'mines', interaction.user,
    interaction.options.getUser('opponent'), bet, { mineCount, bonusItem, bonusItemName, bonusQty, bonusValue });
}

function buildMineMapText(mineCells) {
  let grid = '';
  for (let r = 0; r < 5; r++) {
    const row = [];
    for (let c = 0; c < 5; c++) row.push(mineCells.includes(r * 5 + c) ? '💣' : '⬜');
    grid += row.join('') + '\n';
  }
  return { grid: grid.trim(), positions: mineCells.map(i => `#${i + 1}`).join(', ') };
}

function buildMinesGrid(gameId, revealedCells, mineCells, revealAll = false) {
  const rows = [];
  for (let r = 0; r < 5; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < 5; c++) {
      const idx      = r * 5 + c;
      const revealed = revealedCells[idx] !== undefined;
      const isMine   = mineCells.includes(idx);
      let label, style, disabled;
      if (revealed && isMine)     { label = '💣'; style = ButtonStyle.Danger;    disabled = true; }
      else if (revealed)          { label = '✅'; style = ButtonStyle.Success;   disabled = true; }
      else if (revealAll && isMine){ label = '💣'; style = ButtonStyle.Danger;   disabled = true; }
      else                        { label = '⬜'; style = ButtonStyle.Secondary; disabled = revealAll; }
      row.addComponents(
        new ButtonBuilder().setCustomId(`mine:${gameId}:${idx}`).setLabel(label).setStyle(style).setDisabled(disabled)
      );
    }
    rows.push(row);
  }
  return rows;
}

function minesEmbed(game, safeCount, currentTurnId) {
  const safeCells = 25 - game.mineCount;
  const embed = new EmbedBuilder()
    .setColor(0xFF4136).setTitle('💣 PvP Mines')
    .setDescription(
      `Players take turns clicking cells. Hit a mine and your opponent wins!\n\n` +
      `💣 **Mines:** ${game.mineCount}  |  ✅ **Safe revealed:** ${safeCount}/${safeCells}\n` +
      `**Current turn:** <@${currentTurnId}>`
    )
    .addFields(
      { name: 'Challenger', value: `<@${game.challenger}>`, inline: true },
      { name: 'Opponent',   value: `<@${game.opponent}>`,   inline: true },
      { name: '💎 Bet',     value: `${game.bet.toLocaleString()} 💎`, inline: true },
    )
    .setFooter({ text: 'Click any ⬜ cell on your turn!' });
  if (game.bonusItem) {
    const totalValue = game.bet + (game.bonusValue || 0);
    embed.addFields(
      { name: '🎁 Bonus Pet', value: `**${game.bonusItemName}** x${game.bonusQty}`, inline: true },
      { name: '💰 Pet Value',  value: game.bonusValue ? `~${game.bonusValue.toLocaleString()} 💎` : '*Unknown*', inline: true },
      { name: '💎 Total Stakes', value: `~${totalValue.toLocaleString()} 💎`, inline: true },
    );
    if (game.bonusIcon) embed.setThumbnail(game.bonusIcon);
  }
  return embed;
}

async function startMines(interaction, data) {
  const mineCount = data.mineCount ?? 5;
  const mineSet   = new Set();
  while (mineSet.size < mineCount) mineSet.add(Math.floor(Math.random() * 25));
  const mineCells = [...mineSet];

  const gameId    = `mines-live-${data.challenger}-${Date.now()}`;
  const gameState = { ...data, mineCount, mineCells, revealedCells: {}, currentTurn: data.challenger, safeCount: 0 };
  activeGames.set(gameId, gameState);

  // Admin mine log
  const { grid, positions } = buildMineMapText(mineCells);
  const { tax } = calcTax(data.bet);
  await logToStaff('🔐 **Admin Mine Log** — game started:', [
    new EmbedBuilder()
      .setColor(0xFF6B6B).setTitle('💣 Mine Map (Staff Only)')
      .setDescription(`\`\`\`\n${grid}\n\`\`\``)
      .addFields(
        { name: 'Challenger',     value: `<@${data.challenger}>`, inline: true },
        { name: 'Opponent',       value: `<@${data.opponent}>`,   inline: true },
        { name: 'Bet',            value: `${data.bet} 💎`,         inline: true },
        { name: 'Mines',          value: `${mineCount}`,           inline: true },
        { name: '10% Tax',        value: `${tax} 💎`,              inline: true },
        { name: 'Game ID',        value: `\`${gameId}\``,          inline: false },
        { name: 'Mine Positions', value: positions,                inline: false },
      )
      .setFooter({ text: 'This is visible to staff only.' })
      .setTimestamp(),
  ]);

  return interaction.update({
    embeds:     [minesEmbed(gameState, 0, gameState.currentTurn)],
    components: buildMinesGrid(gameId, {}, mineCells),
  });
}

async function handleMineClick(interaction, gameId, idxStr) {
  const game = activeGames.get(gameId);
  if (!game)
    return interaction.reply({ content: '❌ Game session not found. The bot may have restarted — start a new game.', flags: 64 });
  if (interaction.user.id !== game.currentTurn)
    return interaction.reply({ content: `❌ It's not your turn! Waiting for <@${game.currentTurn}>.`, flags: 64 });

  const idx = parseInt(idxStr);
  if (game.revealedCells[idx] !== undefined)
    return interaction.reply({ content: '❌ That cell is already revealed.', flags: 64 });

  game.revealedCells[idx] = true;

  if (game.mineCells.includes(idx)) {
    activeGames.delete(gameId);
    const winnerId = interaction.user.id === game.challenger ? game.opponent : game.challenger;
    const loserId  = interaction.user.id;
    const rows     = buildMinesGrid(gameId, game.revealedCells, game.mineCells, true);

    const { tax, winnerGain, winnerNewBal, loserNewBal } = settleGame(winnerId, loserId, game.bet);
    settleBonusItem(game, winnerId);
    checkBounty(winnerId, loserId, interaction.channelId).catch(() => {});
    const mineHitEmbed = new EmbedBuilder()
      .setColor(0xFF4136).setTitle('💣 BOOM! Mine Hit!')
      .setDescription(`<@${loserId}> hit a mine on cell **#${idx + 1}**!\n<@${winnerId}> wins the pot!`)
      .addFields(
        { name: '🏆 Winner',    value: `<@${winnerId}> **+${winnerGain.toLocaleString()} 💎** → Balance: ${winnerNewBal.toLocaleString()} 💎` },
        { name: '💀 Loser',     value: `<@${loserId}> **-${game.bet.toLocaleString()} 💎** → Balance: ${loserNewBal.toLocaleString()} 💎` },
        { name: '🏦 Tax (10%)', value: `**${tax} 💎** burned`, inline: true },
        { name: 'Mines',        value: `${game.mineCount} mines on this board`, inline: true },
      ).setTimestamp();
    if (game.bonusItem) {
      mineHitEmbed.addFields({ name: '🎁 Bonus Pet Won', value: `<@${winnerId}> also wins **${game.bonusItemName}** x${game.bonusQty}${game.bonusValue ? ` (~${game.bonusValue.toLocaleString()} 💎)` : ''}!`, inline: false });
      if (game.bonusIcon) mineHitEmbed.setThumbnail(game.bonusIcon);
    }
    return interaction.update({ embeds: [mineHitEmbed], components: rows });
  }

  game.safeCount++;
  game.currentTurn = interaction.user.id === game.challenger ? game.opponent : game.challenger;

  if (game.safeCount >= 25 - game.mineCount) {
    activeGames.delete(gameId);
    returnBonusItem(game);
    return interaction.update({
      embeds: [new EmbedBuilder()
        .setColor(0xF39C12).setTitle('🤯 All Safe Cells Cleared!')
        .setDescription(`Both players avoided every mine — it's a **draw**! Bets returned, no tax.${game.bonusItem ? ` Bonus pet returned to <@${game.challenger}>.` : ''}`)
        .addFields(
          { name: `<@${game.challenger}>`, value: 'Bet returned', inline: true },
          { name: `<@${game.opponent}>`,   value: 'Bet returned', inline: true },
        ).setTimestamp()],
      components: buildMinesGrid(gameId, game.revealedCells, game.mineCells, true),
    });
  }

  return interaction.update({
    embeds:     [minesEmbed(game, game.safeCount, game.currentTurn)],
    components: buildMinesGrid(gameId, game.revealedCells, game.mineCells),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLACKJACK
// ═══════════════════════════════════════════════════════════════════════════════

async function handleBlackjackChallenge(interaction) {
  const bet = parseAmount(interaction.options.getString('bet'));
  if (isNaN(bet) || bet <= 0)
    return interaction.reply({ content: '❌ Invalid bet. Use a positive number, e.g. `500`, `1k`, `2.5m`.', flags: 64 });
  const { bonusItem, bonusItemName, bonusQty, bonusValue } = await readBonusItem(interaction);
  return sendChallenge(interaction, 'blackjack', interaction.user,
    interaction.options.getUser('opponent'), bet, { bonusItem, bonusItemName, bonusQty, bonusValue });
}

function bjEmbed(game, phase) {
  const chalTotal = handTotal(game.challengerHand);
  const oppTotal  = handTotal(game.opponentHand);
  const { tax }   = calcTax(game.bet);
  const betFields = [
    { name: '💎 Bet', value: `${game.bet.toLocaleString()} 💎`, inline: true },
    { name: '🏦 Tax', value: `${tax} 💎`, inline: true },
  ];
  if (game.bonusItem) {
    const totalValue = game.bet + (game.bonusValue || 0);
    betFields.push(
      { name: '🎁 Bonus Pet',    value: `**${game.bonusItemName}** x${game.bonusQty}`, inline: true },
      { name: '💰 Pet Value',    value: game.bonusValue ? `~${game.bonusValue.toLocaleString()} 💎` : '*Unknown*', inline: true },
      { name: '💎 Total Stakes', value: `~${totalValue.toLocaleString()} 💎`, inline: true },
    );
  }
  const embed = new EmbedBuilder().setColor(0x2ECC40).setTitle('🃏 PvP Blackjack').setTimestamp();
  if (game.bonusIcon) embed.setThumbnail(game.bonusIcon);
  if (phase === 'challenger_turn') {
    embed.setDescription(`**<@${game.challenger}>'s turn** — Hit or Stand.\n<@${game.opponent}> is waiting.`)
      .addFields(
        { name: `Your Hand (${chalTotal})`, value: formatHand(game.challengerHand) },
        { name: `Opponent's Hand`,          value: `🂠 Hidden (${game.opponentHand.length} cards)` },
        ...betFields,
      );
  } else {
    embed.setDescription(`**<@${game.opponent}>'s turn** — Hit or Stand.\n<@${game.challenger}> has stood.`)
      .addFields(
        { name: `<@${game.challenger}>'s Hand (${chalTotal})`, value: formatHand(game.challengerHand) },
        { name: `Your Hand (${oppTotal})`,                     value: formatHand(game.opponentHand) },
        ...betFields,
      );
  }
  return embed;
}

function bjButtons(gameId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bj_hit:${gameId}`).setLabel('👊 Hit').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`bj_stand:${gameId}`).setLabel('🛑 Stand').setStyle(ButtonStyle.Secondary),
  );
}

async function startBlackjack(interaction, data) {
  const deck = buildDeck();
  const gameState = {
    ...data, deck,
    challengerHand: [deck.pop(), deck.pop()],
    opponentHand:   [deck.pop(), deck.pop()],
    phase: 'challenger_turn',
  };
  const gameId = `bj-live-${data.challenger}-${Date.now()}`;
  activeGames.set(gameId, gameState);
  if (handTotal(gameState.challengerHand) === 21) gameState.phase = 'opponent_turn';
  return interaction.update({ embeds: [bjEmbed(gameState, gameState.phase)], components: [bjButtons(gameId)] });
}

async function handleBlackjackAction(interaction, action, gameId) {
  const game = activeGames.get(gameId);
  if (!game)
    return interaction.reply({ content: '❌ Game session not found. Please start a new game.', flags: 64 });

  const isChallenger = interaction.user.id === game.challenger;
  const isOpponent   = interaction.user.id === game.opponent;

  if (game.phase === 'challenger_turn' && !isChallenger)
    return interaction.reply({ content: `❌ It's <@${game.challenger}>'s turn!`, flags: 64 });
  if (game.phase === 'opponent_turn' && !isOpponent)
    return interaction.reply({ content: `❌ It's <@${game.opponent}>'s turn!`, flags: 64 });

  if (action === 'bj_hit') {
    const card = game.deck.pop();
    if (game.phase === 'challenger_turn') {
      game.challengerHand.push(card);
      const total = handTotal(game.challengerHand);
      if (total > 21)   return finishBlackjack(interaction, game, gameId, game.opponent, game.challenger, 'bust');
      if (total === 21)  game.phase = 'opponent_turn';
    } else {
      game.opponentHand.push(card);
      const total = handTotal(game.opponentHand);
      if (total > 21)   return finishBlackjack(interaction, game, gameId, game.challenger, game.opponent, 'bust');
      if (total === 21)  return finishBlackjack(interaction, game, gameId, null, null, 'compare');
    }
  } else {
    if (game.phase === 'challenger_turn') game.phase = 'opponent_turn';
    else return finishBlackjack(interaction, game, gameId, null, null, 'compare');
  }

  return interaction.update({ embeds: [bjEmbed(game, game.phase)], components: [bjButtons(gameId)] });
}

async function finishBlackjack(interaction, game, gameId, winnerId, loserId, reason) {
  activeGames.delete(gameId);
  const chalTotal = handTotal(game.challengerHand);
  const oppTotal  = handTotal(game.opponentHand);

  if (reason === 'compare') {
    if (chalTotal > oppTotal)      { winnerId = game.challenger; loserId = game.opponent; }
    else if (oppTotal > chalTotal) { winnerId = game.opponent;   loserId = game.challenger; }
    else                             winnerId = null;
  }

  const embed = new EmbedBuilder()
    .setColor(winnerId ? 0x2ECC40 : 0xF39C12)
    .setTitle('🃏 Blackjack — Game Over')
    .setDescription(winnerId ? `**Game Over!**${reason === 'bust' ? ' (BUST!)' : ''}` : `**It's a tie!** Bets returned, no tax.`)
    .addFields(
      { name: `<@${game.challenger}>'s Final Hand (${chalTotal})`, value: formatHand(game.challengerHand) },
      { name: `<@${game.opponent}>'s Final Hand (${oppTotal})`,    value: formatHand(game.opponentHand) },
    )
    .setTimestamp();

  if (winnerId) {
    const { tax, winnerGain, winnerNewBal, loserNewBal } = settleGame(winnerId, loserId, game.bet);
    settleBonusItem(game, winnerId);
    checkBounty(winnerId, loserId, interaction.channelId).catch(() => {});
    embed.addFields(
      { name: '🏆 Winner',    value: `<@${winnerId}> **+${winnerGain.toLocaleString()} 💎** → Balance: ${winnerNewBal.toLocaleString()} 💎` },
      { name: '💀 Loser',     value: `<@${loserId}> **-${game.bet.toLocaleString()} 💎** → Balance: ${loserNewBal.toLocaleString()} 💎` },
      { name: '🏦 Tax (10%)', value: `**${tax} 💎** burned`, inline: true },
    );
    if (game.bonusItem) {
      embed.addFields({ name: '🎁 Bonus Pet Won', value: `<@${winnerId}> also wins **${game.bonusItemName}** x${game.bonusQty}${game.bonusValue ? ` (~${game.bonusValue.toLocaleString()} 💎)` : ''}!`, inline: false });
      if (game.bonusIcon) embed.setThumbnail(game.bonusIcon);
    }
  } else {
    returnBonusItem(game);
    embed.addFields({ name: '🤝 Result', value: `No gems transferred. Both players keep their bets.${game.bonusItem ? ` Bonus pet returned to <@${game.challenger}>.` : ''}` });
  }

  return interaction.update({ embeds: [embed], components: [] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROCK PAPER SCISSORS  — both players DM their move, result posted in channel
// ═══════════════════════════════════════════════════════════════════════════════

const RPS_BEATS = { punch: 'scissors', scissors: 'paper', paper: 'punch' };
const RPS_LABEL = { punch: '🥊 Punch (Rock)', paper: '📄 Paper', scissors: '✂️ Scissors' };

async function handleRpsChallenge(interaction) {
  const bet = parseAmount(interaction.options.getString('bet'));
  if (isNaN(bet) || bet <= 0)
    return interaction.reply({ content: '❌ Invalid bet. Use a positive number, e.g. `500`, `1k`, `2.5m`.', flags: 64 });
  const { bonusItem, bonusItemName, bonusQty, bonusValue } = await readBonusItem(interaction);
  return sendChallenge(interaction, 'rps', interaction.user,
    interaction.options.getUser('opponent'), bet, { bonusItem, bonusItemName, bonusQty, bonusValue });
}

async function startRps(interaction, data) {
  const gameId = `rps-live-${data.challenger}-${Date.now()}`;

  activeGames.set(gameId, {
    ...data,
    phase: 'waiting',
    moves: {},
    channelId: interaction.channelId,
  });

  // Update the channel message
  const rpsChannelEmbed = new EmbedBuilder()
    .setColor(0xE91E63)
    .setTitle('✊ Rock Paper Scissors — Game On!')
    .setDescription(
      `Both players have been **DM'd** to pick their move!\n\n` +
      `<@${data.challenger}> vs <@${data.opponent}>`
    )
    .addFields(
      { name: '💎 Bet',          value: `${data.bet.toLocaleString()} 💎`, inline: true },
      { name: '🏆 Winner Gets',  value: `~${(data.bet * 2 - Math.floor(data.bet * 0.1)).toLocaleString()} 💎`, inline: true },
    )
    .setFooter({ text: 'You have 60 seconds to DM your move.' })
    .setTimestamp();
  if (data.bonusItem) {
    const totalValue = data.bet + (data.bonusValue || 0);
    rpsChannelEmbed.addFields(
      { name: '🎁 Bonus Pet',    value: `**${data.bonusItemName}** x${data.bonusQty} — winner takes it!`, inline: true },
      { name: '💰 Pet Value',    value: data.bonusValue ? `~${data.bonusValue.toLocaleString()} 💎` : '*Unknown*', inline: true },
      { name: '💎 Total Stakes', value: `~${totalValue.toLocaleString()} 💎`, inline: true },
    );
    if (data.bonusIcon) rpsChannelEmbed.setThumbnail(data.bonusIcon);
  }

  await interaction.update({ embeds: [rpsChannelEmbed], components: [] });

  // DM both players
  const moveRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rps_move:${gameId}:punch`)   .setLabel('🥊 Punch').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`rps_move:${gameId}:paper`)   .setLabel('📄 Paper').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rps_move:${gameId}:scissors`).setLabel('✂️ Scissors').setStyle(ButtonStyle.Secondary),
  );

  const dmEmbed = new EmbedBuilder()
    .setColor(0xE91E63)
    .setTitle('✊ Pick Your Move!')
    .setDescription(`Choose your move. Your opponent won't see it until both of you have picked.${data.bonusItem ? `\n\n🎁 **Bonus Item:** **${data.bonusItemName}** x${data.bonusQty} is on the line!` : ''}`)
    .setFooter({ text: 'Pick within 60 seconds or you forfeit.' });
  if (data.bonusIcon) dmEmbed.setThumbnail(data.bonusIcon);

  const game = activeGames.get(gameId);

  for (const userId of [data.challenger, data.opponent]) {
    try {
      const user = await client.users.fetch(userId);
      const dm   = await user.send({ embeds: [dmEmbed], components: [moveRow] });
      if (!game.dmMessages) game.dmMessages = {};
      game.dmMessages[userId] = dm;
    } catch {
      // If we can't DM a player, cancel the game
      activeGames.delete(gameId);
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(0xE74C3C).setTitle('❌ RPS Cancelled')
          .setDescription(`Couldn't DM <@${userId}>. Make sure DMs are open.`)
          .setTimestamp()],
        components: [],
      }).catch(() => {});
      return;
    }
  }

  // 60-second timeout
  setTimeout(async () => {
    const g = activeGames.get(gameId);
    if (!g) return;
    activeGames.delete(gameId);
    const missing = [data.challenger, data.opponent].filter(id => !g.moves[id]);
    const ch = await client.channels.fetch(g.channelId).catch(() => null);
    if (ch) {
      await ch.send({
        embeds: [new EmbedBuilder()
          .setColor(0x95A5A6).setTitle('⏰ RPS Expired')
          .setDescription(`${missing.map(id => `<@${id}>`).join(' and ')} didn't pick in time. Game cancelled.`)
          .setTimestamp()],
      }).catch(() => {});
    }
  }, 60_000);
}

async function handleRpsMove(interaction, gameId, move) {
  const game = activeGames.get(gameId);
  if (!game)
    return interaction.reply({ content: '❌ Game session expired.', flags: 64 });

  const userId = interaction.user.id;
  if (userId !== game.challenger && userId !== game.opponent)
    return interaction.reply({ content: '❌ You are not part of this game.', flags: 64 });
  if (game.moves[userId])
    return interaction.reply({ content: '✅ You already locked in your move!', flags: 64 });

  game.moves[userId] = move;

  // Acknowledge the move (update the DM button message)
  await interaction.update({
    embeds: [new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle('✅ Move Locked In!')
      .setDescription(`You chose **${RPS_LABEL[move]}**. Waiting for your opponent...`)],
    components: [],
  });

  // If both have picked, resolve
  if (Object.keys(game.moves).length === 2) {
    activeGames.delete(gameId);

    const chalMove = game.moves[game.challenger];
    const oppMove  = game.moves[game.opponent];

    let winnerId = null, loserId = null;
    if (chalMove === oppMove) {
      // Tie — return bets
    } else if (RPS_BEATS[chalMove] === oppMove) {
      winnerId = game.challenger; loserId = game.opponent;
    } else {
      winnerId = game.opponent;   loserId = game.challenger;
    }

    const ch = await client.channels.fetch(game.channelId).catch(() => null);
    if (!ch) return;

    const embed = new EmbedBuilder()
      .setColor(winnerId ? 0xE91E63 : 0xF39C12)
      .setTitle('✊ Rock Paper Scissors — Result!')
      .addFields(
        { name: `<@${game.challenger}>'s move`, value: RPS_LABEL[chalMove], inline: true },
        { name: `<@${game.opponent}>'s move`,   value: RPS_LABEL[oppMove],  inline: true },
        { name: '\u200b', value: '\u200b', inline: true },
      )
      .setTimestamp();

    if (winnerId) {
      const { tax, winnerGain, winnerNewBal, loserNewBal } = settleGame(winnerId, loserId, game.bet);
      settleBonusItem(game, winnerId);
      checkBounty(winnerId, loserId, game.channelId).catch(() => {});
      embed.addFields(
        { name: '🏆 Winner',    value: `<@${winnerId}> **+${winnerGain.toLocaleString()} 💎** → Balance: ${winnerNewBal.toLocaleString()} 💎` },
        { name: '💀 Loser',     value: `<@${loserId}> **-${game.bet.toLocaleString()} 💎** → Balance: ${loserNewBal.toLocaleString()} 💎` },
        { name: '🏦 Tax (10%)', value: `**${tax} 💎** burned`, inline: true },
      );
      if (game.bonusItem) {
        embed.addFields({ name: '🎁 Bonus Pet Won', value: `<@${winnerId}> also wins **${game.bonusItemName}** x${game.bonusQty}${game.bonusValue ? ` (~${game.bonusValue.toLocaleString()} 💎)` : ''}!`, inline: false });
        if (game.bonusIcon) embed.setThumbnail(game.bonusIcon);
      }
    } else {
      returnBonusItem(game);
      embed.setDescription(`**It's a tie!** Both chose the same move — bets returned, no tax.`);
      embed.addFields({ name: '🤝 Result', value: `No gems transferred.${game.bonusItem ? ` Bonus pet returned to <@${game.challenger}>.` : ''}` });
    }

    await ch.send({ content: `<@${game.challenger}> <@${game.opponent}>`, embeds: [embed] });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOUNTY SYSTEM  — place a price on someone's head; claimed by defeating them
// ═══════════════════════════════════════════════════════════════════════════════

async function handleBounty(interaction) {
  const placer = interaction.user;
  const target = interaction.options.getUser('user');
  const amountStr = interaction.options.getString('amount');

  if (target.id === placer.id)
    return interaction.reply({ content: '❌ You cannot place a bounty on yourself.', flags: 64 });
  if (target.bot)
    return interaction.reply({ content: '❌ You cannot place a bounty on a bot.', flags: 64 });

  const amount = parseAmount(amountStr);
  if (!amount || amount <= 0)
    return interaction.reply({ content: '❌ Enter a valid positive amount (e.g. `500`, `1k`, `2.5m`).', flags: 64 });

  // ── Single atomic read → modify → write (prevents dupe via stale snapshot) ──
  const db = readDB();
  if (!db.users)    db.users    = {};
  if (!db.bounties) db.bounties = {};

  const placerEntry = db.users[placer.id] ?? { gems: 500, wagered: 0, profit: 0, deposited: 0, withdrawn: 0 };
  db.users[placer.id] = placerEntry;

  if (placerEntry.gems < amount)
    return interaction.reply({
      content: `❌ You only have **${placerEntry.gems.toLocaleString()} 💎** — not enough.`,
      flags: 64,
    });

  // Deduct gems and write bounty in the same snapshot — no race window
  placerEntry.gems -= amount;

  const existing = db.bounties[target.id];
  const newTotal  = (existing?.amount || 0) + amount;
  db.bounties[target.id] = { amount: newTotal, placedBy: existing?.placedBy || placer.id, placedAt: Date.now() };

  writeDB(db);

  const embed = new EmbedBuilder()
    .setColor(0xFF6B00)
    .setTitle('🎯 Bounty Placed!')
    .setDescription(`<@${placer.id}> has placed a bounty on **<@${target.id}>**!`)
    .addFields(
      { name: '💰 Bounty Amount', value: `**${newTotal.toLocaleString()} 💎**`, inline: true },
      { name: '🎯 Target',        value: `<@${target.id}>`,                     inline: true },
      { name: '📋 How to Claim',  value: 'Beat this player in any PvP game (Coinflip, RPS, Mines, Blackjack) to claim the bounty!', inline: false },
    )
    .setFooter({ text: 'First to beat them claims the prize!' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });

  // DM the target to let them know
  try {
    const dmEmbed = new EmbedBuilder()
      .setColor(0xFF4500)
      .setTitle('⚠️ There is a Bounty on Your Head!')
      .setDescription(`**${placer.username}** has placed a bounty on you in **${interaction.guild?.name ?? 'a server'}**!`)
      .addFields(
        { name: '💰 Bounty Amount', value: `**${newTotal.toLocaleString()} 💎**`,                     inline: true },
        { name: '⚠️ Warning',       value: 'The first player to beat you in any PvP game claims it!', inline: false },
      )
      .setFooter({ text: 'Stay sharp — watch your back!' })
      .setTimestamp();
    await target.send({ embeds: [dmEmbed] });
  } catch {
    // Target has DMs disabled — silently ignore
  }

  // Log to bounty channel
  try {
    const logCh = await client.channels.fetch(BOUNTY_LOG_CHANNEL);
    const logEmbed = new EmbedBuilder()
      .setColor(0xFF6B00)
      .setTitle('🎯 New Bounty Posted')
      .addFields(
        { name: 'Placed By', value: `${placer.username} (<@${placer.id}>)`,   inline: true },
        { name: 'Target',    value: `${target.username} (<@${target.id}>)`,   inline: true },
        { name: 'Amount',    value: `${newTotal.toLocaleString()} 💎`,         inline: true },
      )
      .setTimestamp();
    await logCh.send({ embeds: [logEmbed] });
  } catch (err) {
    console.error('[bounty] Failed to send placement log:', err.message);
  }
}

async function checkBounty(winnerId, loserId, channelId) {
  // ── Atomic read → modify → write (no stale-snapshot overwrite) ──────────────
  const db = readDB();
  if (!db.bounties) return;
  const bounty = db.bounties[loserId];
  if (!bounty) return;

  // Award the bounty directly in this snapshot
  if (!db.users) db.users = {};
  const winnerEntry = db.users[winnerId] ?? { gems: 500, wagered: 0, profit: 0, deposited: 0, withdrawn: 0 };
  db.users[winnerId] = winnerEntry;
  winnerEntry.gems += bounty.amount;
  const newBal = winnerEntry.gems;

  delete db.bounties[loserId];
  writeDB(db);
  // ─────────────────────────────────────────────────────────────────────────────

  const winner = await client.users.fetch(winnerId).catch(() => null);
  const loser  = await client.users.fetch(loserId).catch(() => null);

  // DM the loser — their bounty has been claimed
  try {
    if (loser) {
      await loser.send({
        embeds: [new EmbedBuilder()
          .setColor(0xE74C3C)
          .setTitle('🎯 Your Bounty Has Been Removed')
          .setDescription(`**${winner?.username ?? 'Someone'}** defeated you and claimed the bounty that was on your head.`)
          .addFields(
            { name: '💀 Reason',        value: `You lost a PvP game against **${winner?.username ?? winnerId}**`, inline: false },
            { name: '💰 Bounty Amount', value: `${bounty.amount.toLocaleString()} 💎 claimed`,                    inline: true  },
          )
          .setFooter({ text: 'The bounty has been cleared — you are free.' })
          .setTimestamp()],
      });
    }
  } catch { /* DMs disabled — ignore */ }

  const claimEmbed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('💰 Bounty Claimed!')
    .setDescription(`<@${winnerId}> defeated <@${loserId}> and **claimed the bounty**!`)
    .addFields(
      { name: '🏆 Claimed By',   value: `${winner?.username ?? winnerId} (<@${winnerId}>)`,  inline: true },
      { name: '🎯 Target Was',   value: `${loser?.username  ?? loserId} (<@${loserId}>)`,    inline: true },
      { name: '💰 Bounty Won',   value: `**${bounty.amount.toLocaleString()} 💎**`,           inline: true },
      { name: '💎 New Balance',  value: `${newBal.toLocaleString()} 💎`,                      inline: true },
    )
    .setFooter({ text: 'Bounty cleared — target is free!' })
    .setTimestamp();

  // Announce in the game channel
  const gameCh = await client.channels.fetch(channelId).catch(() => null);
  if (gameCh) await gameCh.send({ embeds: [claimEmbed] }).catch(() => {});

  // Log to bounty log channel (second message as requested)
  try {
    const logCh = await client.channels.fetch(BOUNTY_LOG_CHANNEL);
    const logEmbed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('💰 Bounty Claimed — Log')
      .addFields(
        { name: 'Claimed By', value: `${winner?.username ?? winnerId} (<@${winnerId}>)`, inline: true },
        { name: 'Target',     value: `${loser?.username  ?? loserId} (<@${loserId}>)`,   inline: true },
        { name: 'Amount',     value: `${bounty.amount.toLocaleString()} 💎`,              inline: true },
        { name: 'Channel',    value: `<#${channelId}>`,                                   inline: true },
      )
      .setTimestamp();
    await logCh.send({ embeds: [logEmbed] });
  } catch (err) {
    console.error('[bounty] Failed to send claim log:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE PROOF FORWARDING  — forwards user's message/attachment to admin channel
// ═══════════════════════════════════════════════════════════════════════════════

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const pending = pendingProofs.get(message.author.id);
  if (!pending) return;
  if (message.channelId !== pending.channelId) return;

  clearTimeout(pending.timeoutId);
  pendingProofs.delete(message.author.id);

  const { amount, requestId } = pending;
  const { admins = [] }       = readDB();
  const adminMentions         = admins.map(id => `<@${id}>`).join(' ');
  const currentBal            = getBalance(message.author.id);

  const confirmId = `dep_confirm:${requestId}:${message.author.id}:${amount}`;
  const denyId    = `dep_deny:${requestId}:${message.author.id}:${amount}`;

  const staffEmbed = new EmbedBuilder()
    .setColor(0x3498DB).setTitle('📥 Deposit Request + Proof')
    .setThumbnail(message.author.displayAvatarURL())
    .setDescription(`A user submitted a deposit request and provided payment proof below.`)
    .addFields(
      { name: 'User',            value: `<@${message.author.id}>`,            inline: true },
      { name: 'Requested',       value: `**${amount.toLocaleString()} 💎**`,   inline: true },
      { name: 'Current Balance', value: `**${currentBal.toLocaleString()} 💎**`, inline: true },
      { name: 'Request ID',      value: `\`${requestId}\``,                   inline: false },
    )
    .setFooter({ text: 'Click Approve to credit gems, Deny to reject.' })
    .setTimestamp();

  // Attach image if the user sent one
  const firstImage = message.attachments.find(a => a.contentType?.startsWith('image/'));
  if (firstImage) staffEmbed.setImage(firstImage.url);

  // Include any typed text as a field
  if (message.content?.trim()) {
    staffEmbed.addFields({ name: '💬 User\'s Message', value: message.content.slice(0, 1024), inline: false });
  }

  // List non-image attachments
  const otherAttachments = [...message.attachments.values()].filter(a => !a.contentType?.startsWith('image/'));
  if (otherAttachments.length) {
    staffEmbed.addFields({ name: '📎 Attachments', value: otherAttachments.map(a => `[${a.name}](${a.url})`).join('\n'), inline: false });
  }

  const depRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel('✅ Approve Deposit').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(denyId).setLabel('❌ Deny').setStyle(ButtonStyle.Danger),
  );

  const staffId = getStaffChannelId();
  if (staffId) {
    const ch = await client.channels.fetch(staffId).catch(() => null);
    if (ch) {
      try {
        const msg = await ch.send({ content: `📢 ${adminMentions} — new deposit request with proof!`, embeds: [staffEmbed], components: [depRow] });
        await msg.pin().catch(() => {});
      } catch {}
    }
  }

  await message.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x2ECC40).setTitle('✅ Proof Received!')
      .setDescription(`Your payment proof has been forwarded to the admin team. You'll be notified once it's reviewed.`)
      .setTimestamp()],
  }).catch(() => {});
});


// ═══════════════════════════════════════════════════════════════════════════════
// INVENTORY DB HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function getInventory(userId) {
  const db = readDB();
  if (!db.inventories) db.inventories = {};
  return db.inventories[userId] || {};
}

function addInventoryItem(userId, itemId, quantity = 1) {
  const db = readDB();
  if (!db.inventories) db.inventories = {};
  if (!db.inventories[userId]) db.inventories[userId] = {};
  db.inventories[userId][itemId] = (db.inventories[userId][itemId] || 0) + quantity;
  writeDB(db);
}

function removeInventoryItem(userId, itemId, quantity = 1) {
  const db = readDB();
  if (!db.inventories) db.inventories = {};
  if (!db.inventories[userId]) db.inventories[userId] = {};
  const cur = db.inventories[userId][itemId] || 0;
  const next = cur - quantity;
  if (next <= 0) {
    delete db.inventories[userId][itemId];
  } else {
    db.inventories[userId][itemId] = next;
  }
  writeDB(db);
  return Math.max(0, cur);
}

function getItemMetadataDB(itemId) {
  const db = readDB();
  return (db.itemMetadata || {})[itemId] || null;
}

function saveItemMetadataDB(itemId, metadata) {
  const db = readDB();
  if (!db.itemMetadata) db.itemMetadata = {};
  db.itemMetadata[itemId] = metadata;
  writeDB(db);
}

function getCachedEmojiDB(itemId) {
  const db = readDB();
  return (db.emojiCache || {})[itemId] || null;
}

function saveEmojiToCacheDB(itemId, emojiStr) {
  const db = readDB();
  if (!db.emojiCache) db.emojiCache = {};
  db.emojiCache[itemId] = emojiStr;
  writeDB(db);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PS99 ITEM / PET METADATA RESOLVER
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchItemFromPS99API(itemId) {
  try {
    const isShiny   = itemId.includes('shiny_');
    const isGolden  = itemId.includes('golden_');
    const isRainbow = itemId.includes('rainbow_') || itemId.includes('rb_');

    const baseId = itemId
      .replace('shiny_', '')
      .replace('rainbow_', '')
      .replace('rb_', '')
      .replace('golden_', '');

    const ps99Id = baseId.replace(/_/g, '%20');
    const res = await fetch(`https://ps99rap.com/api/get/variants?id=${ps99Id}`, {
      headers: { 'accept': '*/*', 'user-agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const items = Array.isArray(data) ? data : (data.data || []);
    if (!items || items.length === 0) return null;

    let targetVariant = 0;
    if (isGolden)  targetVariant = 1;
    if (isRainbow) targetVariant = 2;

    const exactMatch = items.find(opt =>
      opt.variant &&
      opt.variant.shiny   === isShiny &&
      opt.variant.variant === targetVariant
    );
    const result = exactMatch || items[0];
    const value  = result.value ?? result.rapValue ?? result.gems ?? result.rap ?? 0;
    return { name: result.name, icon: result.icon, value: Number(value) || 0 };
  } catch {
    return null;
  }
}

async function resolveItemMeta(itemId) {
  if (!itemId) return null;
  const normId = itemId.toLowerCase().trim();

  // ── Gems pseudo-item ──────────────────────────────────────────────────────
  if (normId.startsWith('gems_')) {
    const valStr = normId.replace('gems_', '');
    let value = 0;
    if (valStr.endsWith('b'))      value = parseFloat(valStr) * 1_000_000_000;
    else if (valStr.endsWith('m')) value = parseFloat(valStr) * 1_000_000;
    else if (valStr.endsWith('k')) value = parseFloat(valStr) * 1_000;
    else                           value = parseFloat(valStr) || 0;
    const dv = value >= 1e9 ? (value/1e9).toFixed(1)+'b' : value >= 1e6 ? (value/1e6).toFixed(1)+'m' : value >= 1e3 ? (value/1e3).toFixed(1)+'k' : value;
    return { name: `${dv} Gems`, value, emoji: '💎', icon: 'https://ps99rap.com/images/currencies/diamonds.png' };
  }

  // ── DB cache ──────────────────────────────────────────────────────────────
  const cached = getItemMetadataDB(itemId);
  if (cached) return { ...cached, emoji: itemId.includes('huge') ? '🐾' : '🐱' };

  // ── PS99 API ──────────────────────────────────────────────────────────────
  const apiData = await fetchItemFromPS99API(itemId);
  const metadata = apiData
    ? { name: apiData.name, value: apiData.value || 0, icon: apiData.icon }
    : { name: itemId.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '), value: 0, icon: null };

  saveItemMetadataDB(itemId, metadata);
  return { ...metadata, emoji: itemId.includes('huge') ? '🐾' : '🐱' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// /inventory  — view your pet/item inventory
// ═══════════════════════════════════════════════════════════════════════════════

const ITEMS_PER_PAGE = 10;

async function handleInventory(interaction) {
  await interaction.deferReply();

  const target = interaction.options.getUser('user') || interaction.user;
  const inv    = getInventory(target.id);
  const entries = Object.entries(inv).filter(([, qty]) => qty > 0);

  if (entries.length === 0) {
    const empty = new EmbedBuilder()
      .setColor(0x95A5A6)
      .setTitle(`🎒 ${target.username}'s Inventory`)
      .setDescription('*This inventory is empty.*')
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .setFooter({ text: 'Admins can add items with /give-item' })
      .setTimestamp();
    return interaction.editReply({ embeds: [empty] });
  }

  const page     = Math.max(1, interaction.options.getInteger('page') || 1);
  const totalPages = Math.ceil(entries.length / ITEMS_PER_PAGE);
  const currentPage = Math.min(page, totalPages);
  const pageEntries = entries.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

  // Resolve metadata for each item on this page
  const resolved = await Promise.all(pageEntries.map(async ([itemId, qty]) => {
    const meta = await resolveItemMeta(itemId).catch(() => null);
    const name = meta?.name || itemId.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const emoji = meta?.emoji || '📦';
    return { itemId, qty, name, emoji };
  }));

  const lines = resolved.map(r => `${r.emoji} **${r.name}** — \`x${r.qty}\``);

  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle(`🎒 ${target.username}'s Inventory`)
    .setThumbnail(target.displayAvatarURL({ size: 256 }))
    .setDescription(lines.join('\n'))
    .addFields({ name: '📦 Total Items', value: `${entries.length} unique item${entries.length !== 1 ? 's' : ''}`, inline: true })
    .setFooter({ text: `Page ${currentPage}/${totalPages}  •  HappyVault` })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// /give-item  [ADMIN] — add an item to a user's inventory
// ═══════════════════════════════════════════════════════════════════════════════

async function handleGiveItem(interaction) {
  if (!guardAdmin(interaction)) return;

  const target   = interaction.options.getUser('user');
  const itemId   = interaction.options.getString('item').toLowerCase().trim().replace(/ /g, '_');
  const quantity = interaction.options.getInteger('quantity') || 1;

  if (quantity < 1)
    return interaction.reply({ content: '❌ Quantity must be at least 1.', flags: 64 });

  addInventoryItem(target.id, itemId, quantity);

  const meta = await resolveItemMeta(itemId).catch(() => null);
  const displayName = meta?.name || itemId;

  const embed = new EmbedBuilder()
    .setColor(0x2ECC71)
    .setTitle('✅ Item Given')
    .addFields(
      { name: '👤 User',     value: `<@${target.id}>`,    inline: true },
      { name: '📦 Item',     value: `**${displayName}**`, inline: true },
      { name: '🔢 Quantity', value: `x${quantity}`,        inline: true },
    )
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// /remove-item  [ADMIN] — remove an item from a user's inventory
// ═══════════════════════════════════════════════════════════════════════════════

async function handleRemoveItem(interaction) {
  if (!guardAdmin(interaction)) return;

  const target   = interaction.options.getUser('user');
  const itemId   = interaction.options.getString('item').toLowerCase().trim().replace(/ /g, '_');
  const quantity = interaction.options.getInteger('quantity') || 1;

  const had = removeInventoryItem(target.id, itemId, quantity);
  if (had === 0)
    return interaction.reply({ content: `❌ <@${target.id}> doesn't have any **${itemId}** in their inventory.`, flags: 64 });

  const meta = await resolveItemMeta(itemId).catch(() => null);
  const displayName = meta?.name || itemId;
  const removed = Math.min(had, quantity);

  const embed = new EmbedBuilder()
    .setColor(0xE74C3C)
    .setTitle('🗑️ Item Removed')
    .addFields(
      { name: '👤 User',     value: `<@${target.id}>`,    inline: true },
      { name: '📦 Item',     value: `**${displayName}**`, inline: true },
      { name: '🔢 Removed',  value: `x${removed}`,         inline: true },
    )
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
