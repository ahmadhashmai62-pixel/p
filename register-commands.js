import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import 'dotenv/config';

const commands = [
  // ── Public ──────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription("Check your Gem balance or another user's balance")
    .addUserOption(opt =>
      opt.setName('user').setDescription('User to check').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Roblox account — your Roblox avatar will show on your balance card')
    .addStringOption(opt =>
      opt.setName('username').setDescription('Your Roblox username').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Unlink your Roblox account from your balance card'),

  new SlashCommandBuilder()
    .setName('withdraw')
    .setDescription('Request a gem withdrawal (staff must confirm before gems are removed)')
    .addStringOption(opt =>
      opt.setName('amount').setDescription('Gems to withdraw — supports 1k, 1m, 1b, 1t').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('request-deposit')
    .setDescription('Request a deposit — bot will ask you to send your payment proof in chat')
    .addStringOption(opt =>
      opt.setName('amount').setDescription('Gems you want deposited — supports 1k, 1m, 1b, 1t').setRequired(true)
    ),

  // ── PvP Games ───────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('pvp-coinflip')
    .setDescription('Challenge another player to a coin flip')
    .addUserOption(opt =>
      opt.setName('opponent').setDescription('Player to challenge').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('bet').setDescription('Gems to bet — supports 1k, 1m, 1b, 1t').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('item').setDescription('Optional bonus item to wager (e.g. huge_cat) — winner takes it').setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('quantity').setDescription('Quantity of the bonus item (default 1)').setRequired(false).setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('pvp-mines')
    .setDescription('Challenge another player to a mines game on a 5×5 grid')
    .addUserOption(opt =>
      opt.setName('opponent').setDescription('Player to challenge').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('bet').setDescription('Gems to bet — supports 1k, 1m, 1b, 1t').setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('mines')
        .setDescription('Number of mines to place (default 5, max 15)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(15)
    )
    .addStringOption(opt =>
      opt.setName('item').setDescription('Optional bonus item to wager (e.g. huge_cat) — winner takes it').setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('quantity').setDescription('Quantity of the bonus item (default 1)').setRequired(false).setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('pvp-blackjack')
    .setDescription('Challenge another player to blackjack')
    .addUserOption(opt =>
      opt.setName('opponent').setDescription('Player to challenge').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('bet').setDescription('Gems to bet — supports 1k, 1m, 1b, 1t').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('item').setDescription('Optional bonus item to wager (e.g. huge_cat) — winner takes it').setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('quantity').setDescription('Quantity of the bonus item (default 1)').setRequired(false).setMinValue(1)
    ),

  // ── Admin ────────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('deposit')
    .setDescription('[ADMIN] Add gems to a user\'s balance')
    .addUserOption(opt =>
      opt.setName('user').setDescription('User to credit').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('amount').setDescription('Gems to add — supports 1k, 1m, 1b, 1t').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('confirm-withdraw')
    .setDescription('[ADMIN] Confirm a pending withdrawal and deduct gems')
    .addUserOption(opt =>
      opt.setName('user').setDescription('User whose withdrawal to confirm').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('amount').setDescription('Gems to deduct — supports 1k, 1m, 1b, 1t').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('add-admin')
    .setDescription('[ADMIN] Grant admin permissions to a user')
    .addUserOption(opt =>
      opt.setName('user').setDescription('User to promote').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('set-staff-channel')
    .setDescription('[ADMIN] Set the channel where withdrawal/deposit requests are posted')
    .addChannelOption(opt =>
      opt.setName('channel').setDescription('Staff log channel').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('pvp-rps')
    .setDescription('Challenge another player to Rock Paper Scissors')
    .addUserOption(opt =>
      opt.setName('opponent').setDescription('Player to challenge').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('bet').setDescription('Gems to bet — supports 1k, 1m, 1b, 1t').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('item').setDescription('Optional bonus item to wager (e.g. huge_cat) — winner takes it').setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('quantity').setDescription('Quantity of the bonus item (default 1)').setRequired(false).setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('bounty')
    .setDescription('Place a gem bounty on a player — first person to beat them in any PvP game claims it')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Player to put a bounty on').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('amount').setDescription('Bounty amount — supports 1k, 1m, 1b, 1t').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('tip')
    .setDescription('Send gems to another player')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Player to tip').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('amount').setDescription('Gems to tip — supports 1k, 1m, 1b, 1t').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the top 10 players in a chosen category')
    .addStringOption(opt =>
      opt.setName('category')
        .setDescription('What to rank by')
        .setRequired(true)
        .addChoices(
          { name: '💰 Top Cash (balance)',  value: 'gems'      },
          { name: '🎲 Top Wagered',         value: 'wagered'   },
          { name: '📥 Top Deposited',       value: 'deposited' },
          { name: '📤 Top Withdrawn',       value: 'withdrawn' },
        )
    ),

  // ── Inventory ────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('inventory')
    .setDescription('View your pet/item inventory or another player\'s')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Player whose inventory to view').setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('page').setDescription('Page number').setRequired(false).setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('give-item')
    .setDescription('[ADMIN] Add a pet or item to a user\'s inventory')
    .addUserOption(opt =>
      opt.setName('user').setDescription('User to give the item to').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('item').setDescription('Item ID (e.g. huge_cat, shiny_dog, golden_dragon)').setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('quantity').setDescription('How many to give (default 1)').setRequired(false).setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('remove-item')
    .setDescription('[ADMIN] Remove a pet or item from a user\'s inventory')
    .addUserOption(opt =>
      opt.setName('user').setDescription('User to remove the item from').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('item').setDescription('Item ID to remove').setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('quantity').setDescription('How many to remove (default 1)').setRequired(false).setMinValue(1)
    ),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

try {
  console.log('Registering slash commands...');
  await rest.put(
    Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
    { body: commands }
  );
  console.log('Successfully registered all slash commands globally.');
} catch (err) {
  console.error(err);
}
