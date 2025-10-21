require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const twilio = require('./twilio');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PICKUPS_FILE = path.join(DATA_DIR, 'pickups.json');
const WITHDRAW_FILE = path.join(DATA_DIR, 'withdrawals.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');

const ensureFile = (p, initial) => {
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(initial, null, 2));
};
ensureFile(USERS_FILE, []);
ensureFile(PICKUPS_FILE, []);
ensureFile(WITHDRAW_FILE, []);
ensureFile(META_FILE, { rate_per_kg: 100 }); // default ₦100 per kg

const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8') || '[]');
const writeJSON = (p, data) => fs.writeFileSync(p, JSON.stringify(data, null, 2));

const BOT_TOKEN = process.env.TELEGRAM_TOKEN || '';
const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID || '123456789'); // placeholder admin id
if (!BOT_TOKEN) { console.error('Missing TELEGRAM_TOKEN in .env'); process.exit(1); }
const bot = new Telegraf(BOT_TOKEN);

// Helpers
const findUser = (tgId) => readJSON(USERS_FILE).find(u => u.telegram_id === tgId);
const saveOrUpdateUser = (user) => {
  const users = readJSON(USERS_FILE);
  const i = users.findIndex(u => u.telegram_id === user.telegram_id);
  if (i === -1) users.push(user); else users[i] = user;
  writeJSON(USERS_FILE, users);
};

// In-memory states for flows
const pendingVerify = {};
const waitingForKg = {};
const waitingForWithdrawDetails = {};

// Start command
bot.start(async (ctx) => {
  const tg = ctx.from;
  let user = findUser(tg.id);
  if (!user) {
    user = { telegram_id: tg.id, username: tg.username||'', first_name: tg.first_name||'', phone: null, verified: false, created_at: new Date().toISOString(), total_kg:0, balance:0 };
    saveOrUpdateUser(user);
  }
  await ctx.replyWithMarkdown(`*Welcome to CleanNaijaBot*\nA smart waste pickup & payout assistant for Nigeria.\n\nYou can request pickup, file complaints, and withdraw approved earnings.`,
    Markup.keyboard([['Request Pickup','File Complaint'], ['Withdraw','My Info']]).resize().oneTime());
});

// Contact handler: user shares contact via Telegram contact button
bot.on('contact', async (ctx) => {
  try {
    const contact = ctx.message.contact;
    const tgId = ctx.from.id;
    let user = findUser(tgId);
    if (!user) { user = { telegram_id: tgId, username: ctx.from.username||'', first_name: ctx.from.first_name||'', total_kg:0, balance:0 }; }
    user.phone = contact.phone_number;
    user.verified = false;
    saveOrUpdateUser(user);
    await ctx.reply('Thanks — sending OTP to ' + user.phone);
    const res = await twilio.startVerify(user.phone);
    if (res.success) {
      pendingVerify[tgId] = { phone: user.phone, ts: Date.now() };
      await ctx.reply('OTP sent. Enter the 6-digit code here (in test mode use 123456).');
    } else {
      await ctx.reply('Failed to start verification: ' + (res.error||'unknown'));
    }
  } catch (e) {
    console.error(e);
    await ctx.reply('Error processing contact.');
  }
});

// OTP handler (numeric text)
bot.hears(/^\d{4,8}$/, async (ctx) => {
  const code = ctx.message.text.trim();
  const tgId = ctx.from.id;
  const pend = pendingVerify[tgId];
  if (!pend) return ctx.reply('No pending verification. Use /start and share your phone.');
  const chk = await twilio.checkVerify(pend.phone, code);
  if (chk.success) {
    const user = findUser(tgId);
    user.verified = true;
    user.verified_at = new Date().toISOString();
    saveOrUpdateUser(user);
    delete pendingVerify[tgId];
    return ctx.reply('✅ Your phone is verified. You can now use pickup and withdraw features.', Markup.removeKeyboard());
  }
  return ctx.reply('OTP invalid: ' + (chk.error||'failed'));
});

// My Info
bot.hears(/My Info/i, ctx => {
  const user = findUser(ctx.from.id);
  if (!user) return ctx.reply('No profile found. Send /start.');
  const meta = readJSON(META_FILE);
  const text = `Name: ${user.first_name||'—'}\nPhone: ${user.phone||'—'}\nVerified: ${user.verified?('Yes on ' + (user.verified_at||'')):'No'}\nTotal kg recorded: ${user.total_kg}\nAvailable (simulated): ₦${user.balance.toFixed(2)}\nRate per kg: ₦${meta.rate_per_kg}`;
  ctx.reply(text);
});

// Request Pickup
bot.hears(/Request Pickup/i, ctx => {
  const user = findUser(ctx.from.id);
  if (!user || !user.verified) return ctx.reply('You must verify your phone first. Use /start and share contact.');
  waitingForKg[ctx.from.id] = true;
  ctx.reply('Enter the weight of waste to pickup in kg (e.g., "3.5"). If you prefer the collector to estimate, send "estimate".');
});

bot.on('text', async (ctx, next) => {
  const tgId = ctx.from.id;
  if (waitingForKg[tgId]) {
    const text = ctx.message.text.trim().toLowerCase();
    let kg = 0;
    if (text === 'estimate') {
      // set kg to 1 as placeholder and mark for collector estimation
      kg = 1;
    } else {
      const parsed = parseFloat(text.replace(/[^0-9.]/g,''));
      if (isNaN(parsed) || parsed <= 0) return ctx.reply('Please enter a valid number for kg, e.g., 2 or 3.5, or "estimate".');
      kg = parsed;
    }
    waitingForKg[tgId] = false;
    // record pickup
    const pickups = readJSON(PICKUPS_FILE);
    const id = 'PU' + Date.now();
    pickups.push({ id, user_id: tgId, kg, status: 'requested', created_at: new Date().toISOString() });
    writeJSON(PICKUPS_FILE, pickups);
    return ctx.reply(`Pickup requested. ID: ${id}. Recorded weight: ${kg} kg. Admin will confirm collection and payment.`);
  }
  if (waitingForWithdrawDetails[tgId]) {
    // expecting bank details after entering withdraw amount
    const parts = ctx.message.text.split(',');
    if (parts.length < 2) return ctx.reply('Please provide "BankName, AccountNumber".');
    const bank = parts[0].trim();
    const account = parts[1].replace(/\s+/g,'').trim();
    const details = waitingForWithdrawDetails[tgId];
    waitingForWithdrawDetails[tgId] = null;
    const w = { id: 'W' + Date.now(), user_id: tgId, amount: details.amount, bank, account, status: 'pending', requested_at: new Date().toISOString() };
    const ws = readJSON(WITHDRAW_FILE);
    ws.push(w);
    writeJSON(WITHDRAW_FILE, ws);
    return ctx.reply('Withdrawal request recorded and pending admin approval. Withdrawal ID: ' + w.id);
  }
  return next();
});

// Withdraw command: calculate available from total kg * rate
bot.hears(/Withdraw/i, ctx => {
  const user = findUser(ctx.from.id);
  if (!user || !user.verified) return ctx.reply('You must verify your phone first.');
  const meta = readJSON(META_FILE);
  // calculate available from recorded total_kg minus already paid via withdrawals
  const withdrawals = readJSON(WITHDRAW_FILE).filter(w => w.user_id === ctx.from.id && w.status !== 'rejected');
  const paid = withdrawals.reduce((s,w)=>s+(w.status==='approved'?w.amount:0),0);
  const available_from_kg = user.total_kg;
  const available_amount = (available_from_kg * meta.rate_per_kg) - paid;
  if (available_amount <= 0) return ctx.reply('You have no available balance for withdrawal at the moment.');
  waitingForWithdrawDetails[ctx.from.id] = { amount: Math.round(available_amount*100)/100 };
  ctx.reply(`You can withdraw ₦${available_amount.toFixed(2)}. Enter recipient bank details as "BankName, AccountNumber" to request withdrawal.`);
});

// Status for pickups/withdrawals
bot.hears(/Status/i, ctx => {
  const pickups = readJSON(PICKUPS_FILE).filter(p => p.user_id === ctx.from.id);
  const ws = readJSON(WITHDRAW_FILE).filter(w => w.user_id === ctx.from.id);
  const lines = [];
  if (pickups.length) {
    lines.push('Pickups:');
    pickups.forEach(p => lines.push(`${p.id} — ${p.kg}kg — ${p.status}`));
  } else lines.push('No pickups recorded.');
  if (ws.length) {
    lines.push('\nWithdrawals:');
    ws.forEach(w => lines.push(`${w.id} — ₦${w.amount} — ${w.status}`));
  } else lines.push('\nNo withdrawals recorded.');
  ctx.reply(lines.join('\n'));
});

// Admin commands - protected by ADMIN_ID
bot.command('setrate', ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Unauthorized.');
  const parts = ctx.message.text.split(' ').slice(1);
  if (!parts.length) return ctx.reply('Usage: /setrate <amount_per_kg>');
  const amt = parseFloat(parts[0].replace(/[^0-9.]/g,''));
  if (isNaN(amt) || amt <= 0) return ctx.reply('Enter a valid rate per kg.');
  const meta = readJSON(META_FILE);
  meta.rate_per_kg = amt;
  writeJSON(META_FILE, meta);
  ctx.reply('Rate per kg updated to ₦' + amt);
});

bot.command('viewusers', ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Unauthorized.');
  const users = readJSON(USERS_FILE);
  if (!users.length) return ctx.reply('No users.');
  const lines = users.map(u => `${u.telegram_id} — ${u.first_name||''} — ${u.phone||'no phone'} — kg:${u.total_kg} — verified:${u.verified? 'yes':'no'}`);
  ctx.reply(lines.join('\n'));
});

bot.command('approve', ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Unauthorized.');
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) return ctx.reply('Usage: /approve <withdrawal_id>');
  const id = args[0].trim();
  const ws = readJSON(WITHDRAW_FILE);
  const idx = ws.findIndex(x => x.id === id);
  if (idx === -1) return ctx.reply('Withdrawal not found.');
  ws[idx].status = 'approved';
  ws[idx].approved_at = new Date().toISOString();
  writeJSON(WITHDRAW_FILE, ws);
  // simulate payout: mark user balance decreased and send message
  const uid = ws[idx].user_id;
  const user = findUser(uid);
  // reduce user's total_kg or add to paid summary - here we'll deduct proportional kg
  const meta = readJSON(META_FILE);
  const kg_deduct = Math.round((ws[idx].amount / meta.rate_per_kg) * 100)/100;
  user.total_kg = Math.max(0, (user.total_kg||0) - kg_deduct);
  user.balance = Math.max(0, (user.balance||0) - ws[idx].amount);
  saveOrUpdateUser(user);
  ctx.reply('Withdrawal ' + id + ' approved and simulated payout executed.');
  bot.telegram.sendMessage(uid, `Your withdrawal ${id} for ₦${ws[idx].amount} has been approved and marked paid.`);
});

bot.command('broadcast', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Unauthorized.');
  const msg = ctx.message.text.split(' ').slice(1).join(' ');
  if (!msg) return ctx.reply('Usage: /broadcast <message>');
  const users = readJSON(USERS_FILE);
  let sent = 0;
  for (const u of users) {
    try {
      await bot.telegram.sendMessage(u.telegram_id, msg);
      sent++;
    } catch (e) { /* ignore */ }
  }
  ctx.reply('Broadcast sent to ' + sent + ' users (attempted).');
});

bot.command('listpickups', ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Unauthorized.');
  const pickups = readJSON(PICKUPS_FILE);
  if (!pickups.length) return ctx.reply('No pickups.');
  const lines = pickups.map(p => `${p.id} — user:${p.user_id} — ${p.kg}kg — ${p.status}`);
  ctx.reply(lines.join('\n'));
});

// When admin collects/marks pickup as completed and credits user
bot.command('markcollected', ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Unauthorized.');
  const args = ctx.message.text.split(' ').slice(1);
  if (!args.length) return ctx.reply('Usage: /markcollected <pickup_id> [actual_kg_optional]');
  const id = args[0].trim();
  const pickups = readJSON(PICKUPS_FILE);
  const idx = pickups.findIndex(p => p.id === id);
  if (idx === -1) return ctx.reply('Pickup not found.');
  let actualKg = pickups[idx].kg;
  if (args[1]) {
    const parsed = parseFloat(args[1].replace(/[^0-9.]/g,''));
    if (!isNaN(parsed) && parsed > 0) actualKg = parsed;
  }
  pickups[idx].status = 'collected';
  pickups[idx].collected_at = new Date().toISOString();
  pickups[idx].actual_kg = actualKg;
  writeJSON(PICKUPS_FILE, pickups);
  // credit user: add to user's total_kg and balance
  const user = findUser(pickups[idx].user_id);
  const meta = readJSON(META_FILE);
  user.total_kg = (user.total_kg || 0) + actualKg;
  user.balance = (user.balance || 0) + (actualKg * meta.rate_per_kg);
  saveOrUpdateUser(user);
  ctx.reply(`Pickup ${id} marked collected. User ${user.telegram_id} credited ₦${(actualKg*meta.rate_per_kg).toFixed(2)}.`);
  bot.telegram.sendMessage(user.telegram_id, `Your pickup ${id} was collected. You earned ₦${(actualKg*meta.rate_per_kg).toFixed(2)} (kg: ${actualKg}).`);
});

// Help and default
bot.command('help', ctx => {
  const helpText = [
    'User commands:',
    'Request Pickup — start pickup flow',
    'File Complaint — send complaint text',
    'Withdraw — request withdrawal of available amount',
    'My Info — view profile',
    'Status — view pickups & withdrawals',
    '\nAdmin commands:',
    '/setrate <amount> — set ₦ per kg',
    '/viewusers — list users',
    '/listpickups — list pickups',
    '/markcollected <pickup_id> [actual_kg] — mark pickup collected and credit user',
    '/approve <withdrawal_id> — approve withdrawal (simulated payout)',
    '/broadcast <message> — send message to all users'
  ].join('\n');
  ctx.reply(helpText);
});

// File complaint (simple)
bot.hears(/File Complaint/i, ctx => {
  const user = findUser(ctx.from.id);
  if (!user || !user.verified) return ctx.reply('You must verify your phone first.');
  ctx.reply('Please type your complaint (include State and LGA if applicable):');
  waitingForComplaint[ctx.from.id] = true;
});
const waitingForComplaint = {};
bot.on('text', (ctx, next) => {
  const tgId = ctx.from.id;
  if (waitingForComplaint[tgId]) {
    const text = ctx.message.text;
    const complaintsFile = path.join(DATA_DIR, 'complaints.json');
    if (!fs.existsSync(complaintsFile)) fs.writeFileSync(complaintsFile, '[]');
    const complaints = JSON.parse(fs.readFileSync(complaintsFile, 'utf8'));
    const c = { id: 'C' + Date.now(), user_id: tgId, text, status: 'new', created_at: new Date().toISOString() };
    complaints.push(c);
    fs.writeFileSync(complaintsFile, JSON.stringify(complaints, null, 2));
    waitingForComplaint[tgId] = false;
    return ctx.reply('Complaint recorded. Thank you.');
  }
  return next();
});

// Launch bot
bot.launch().then(() => console.log('CleanNaijaBot started. Admin ID:', ADMIN_ID));

// graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
