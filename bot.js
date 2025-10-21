// bot.js
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const twilio = require('./twilio'); // wrapper above

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const FILES = {
  users: path.join(DATA_DIR, 'users.json'),
  waste: path.join(DATA_DIR, 'waste.json'),
  withdrawals: path.join(DATA_DIR, 'withdrawals.json'),
  complaints: path.join(DATA_DIR, 'complaints.json'),
  referrals: path.join(DATA_DIR, 'referrals.json'),
  meta: path.join(DATA_DIR, 'meta.json')
};

function ensure(file, init) { if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(init, null, 2)); }
ensure(FILES.users, []);
ensure(FILES.waste, []);
ensure(FILES.withdrawals, []);
ensure(FILES.complaints, []);
ensure(FILES.referrals, []);
ensure(FILES.meta, { rate_per_kg: Number(process.env.RATE_PER_KG || 120), verification_days: Number(process.env.VERIFICATION_DAYS || 30), auto_approve_kg: 10, admins: [ Number(process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_ID || 7003416998) ], banned: [] });

const readJSON = f => JSON.parse(fs.readFileSync(f, 'utf8') || '[]');
const writeJSON = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf8');

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).trim().replace(/[^0-9+]/g, '');
  if (!s.startsWith('+')) {
    if (s.startsWith('0')) s = '+234' + s.slice(1);
    else if (s.startsWith('234')) s = '+' + s;
    else s = '+' + s;
  }
  return s;
}

function findUserByTelegram(id) {
  return readJSON(FILES.users).find(u => u.telegram_id === id);
}
function saveOrUpdateUser(user) {
  const arr = readJSON(FILES.users);
  const idx = arr.findIndex(u => u.telegram_id === user.telegram_id);
  if (idx === -1) arr.push(user); else arr[idx] = user;
  writeJSON(FILES.users, arr);
}
function formatN(n){ return `₦${Number(n||0).toFixed(2)}`; }
function computeRank(totalKg) {
  if (!totalKg) totalKg = 0;
  if (totalKg >= 500) return 'Eco-Champion';
  if (totalKg >= 200) return 'Recycler-Hero';
  if (totalKg >= 50) return 'Eco-Warrior';
  if (totalKg >= 10) return 'Starter Recycler';
  return 'Newbie';
}

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
if (!BOT_TOKEN) { console.error('Missing TELEGRAM_TOKEN'); process.exit(1); }
const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_ID || 7003416998);

const bot = new Telegraf(BOT_TOKEN);

// in-memory states for simple flows
const pendingVerify = {};    // tgId -> { phone, attempts, refBy }
const waitingForWaste = {};  // tgId -> true
const waitingForWithdraw = {}; // tgId -> { amount }
const waitingForComplaint = {}; // tgId -> true

// helper
function adminOnly(ctx) {
  const meta = readJSON(FILES.meta);
  const admins = meta.admins || [];
  if (ctx.from.id === ADMIN_ID || admins.includes(ctx.from.id)) return true;
  ctx.reply('⛔ Unauthorized. Admins only.');
  return false;
}

// START
bot.start(async (ctx) => {
  const tgId = ctx.from.id;
  let user = findUserByTelegram(tgId);
  if (!user) {
    user = {
      telegram_id: tgId,
      username: ctx.from.username || '',
      first_name: ctx.from.first_name || '',
      phone: null,
      verified: false,
      verified_at: null,
      balance: 0,
      total_kg: 0,
      referrals_count: 0,
      rank: 'Newbie',
      banned: false
    };
    saveOrUpdateUser(user);
  }
  const meta = readJSON(FILES.meta);
  if ((meta.banned || []).includes(tgId) || user.banned) return ctx.reply('⛔ Your account is suspended.');

  if (user.verified && user.verified_at) {
    const days = meta.verification_days || 30;
    const diff = (Date.now() - new Date(user.verified_at).getTime()) / (1000*60*60*24);
    if (diff <= days) {
      return ctx.reply(`Welcome back ${user.first_name || ''}!`, Markup.keyboard([
        ['Scan Waste','My Earnings'],
        ['Withdraw','File Complaint'],
        ['History','Profile']
      ]).resize());
    }
  }

  // ask verification method
  return ctx.reply('📱 Verification required. Choose:', Markup.keyboard([['Use Telegram Number','Enter Phone Manually']]).oneTime().resize());
});

// Use Telegram Number or Manual
bot.hears(/^Use Telegram Number$/i, async (ctx) => {
  const tgId = ctx.from.id;
  const tgPhone = ctx.from.phone_number || null; // note: telegram rarely provides phone automatically
  // If user shared contact via contact button, Telegram will provide. We support contact handler anyway.
  if (!tgPhone) {
    // Ask to share contact
    return ctx.reply('Please share your contact via the contact button below.', Markup.keyboard([[Markup.button.contactRequest('Share contact')]]).resize());
  }
  // else proceed (rare case)
  const phone = normalizePhone(tgPhone);
  if (!phone) return ctx.reply('Your Telegram phone could not be used. Please enter manually.');
  const res = await twilio.sendOtp(phone);
  pendingVerify[tgId] = { phone, attempts: 0 };
  if (res.success) return ctx.reply(`OTP sent to ${phone}. Enter the 6-digit code (test: 123456 if Twilio not configured).`);
  return ctx.reply('Failed to send OTP: ' + (res.error || 'unknown'));
});

bot.hears(/^Enter Phone Manually$/i, (ctx) => {
  return ctx.reply('Send your phone in international format, e.g. +2348012345678');
});

// contact share handler
bot.on('contact', async (ctx) => {
  const contact = ctx.message.contact;
  const tgId = ctx.from.id;
  const phone = normalizePhone(contact.phone_number);
  if (!phone) return ctx.reply('Invalid phone.');
  const res = await twilio.sendOtp(phone);
  pendingVerify[tgId] = { phone, attempts: 0 };
  let user = findUserByTelegram(tgId) || { telegram_id: tgId, username: ctx.from.username||'', first_name: ctx.from.first_name||'' };
  user.phone = phone; user.verified = false;
  saveOrUpdateUser(user);
  if (res.success) return ctx.reply(`OTP sent to ${phone}. Enter code here (test: 123456).`);
  return ctx.reply('Failed sending OTP: ' + (res.error || 'unknown'));
});

// manual phone message handler (detect plain phone)
bot.hears(/^\+?[0-9]{7,15}$/, async (ctx) => {
  const tgId = ctx.from.id;
  const phone = normalizePhone(ctx.message.text.trim());
  if (!phone) return ctx.reply('Phone format invalid.');
  const res = await twilio.sendOtp(phone);
  pendingVerify[tgId] = { phone, attempts: 0 };
  let user = findUserByTelegram(tgId) || { telegram_id: tgId, username: ctx.from.username||'', first_name: ctx.from.first_name||'' };
  user.phone = phone; user.verified = false;
  saveOrUpdateUser(user);
  if (res.success) return ctx.reply(`OTP sent to ${phone}. Enter code here (test: 123456 if Twilio not configured).`);
  return ctx.reply('Failed sending OTP: ' + (res.error || 'unknown'));
});

// OTP input
bot.hears(/^\d{4,8}$/, async (ctx) => {
  const tgId = ctx.from.id;
  const code = ctx.message.text.trim();
  const session = pendingVerify[tgId];
  if (!session) return; // not expecting OTP

  session.attempts = (session.attempts || 0) + 1;
  if (session.attempts > 6) { delete pendingVerify[tgId]; return ctx.reply('Too many attempts. Start /start again.'); }

  const chk = await twilio.checkOtp(session.phone, code);
  if (chk.success) {
    let user = findUserByTelegram(tgId) || { telegram_id: tgId, username: ctx.from.username||'', first_name: ctx.from.first_name||'' };
    user.phone = session.phone;
    user.verified = true;
    user.verified_at = new Date().toISOString();
    user.rank = computeRank(user.total_kg || 0);
    saveOrUpdateUser(user);
    delete pendingVerify[tgId];
    await ctx.reply('✅ Verification successful! Full features unlocked.');
    return ctx.reply('Choose an option:', Markup.keyboard([
      ['Scan Waste','My Earnings'],
      ['Withdraw','File Complaint'],
      ['History','Profile']
    ]).resize());
  } else {
    return ctx.reply('❌ Invalid OTP. If you did not receive an SMS, re-run /start to request a new code.');
  }
});

// Scan Waste start
bot.hears(/Scan Waste/i, (ctx) => {
  const u = findUserByTelegram(ctx.from.id);
  if (!u || !u.verified) return ctx.reply('Please verify your phone first using /start.');
  waitingForWaste[ctx.from.id] = true;
  return ctx.reply('Send photo OR type description + weight (e.g. "plastic 2.5") or "estimate" to ask for collector estimate.');
});

// photo handler (simulate detection)
bot.on('photo', async (ctx) => {
  const tgId = ctx.from.id;
  if (!waitingForWaste[tgId]) return;
  try {
    const types = ['Plastic','Metal','Glass','Organic','Paper','E-waste'];
    const t = types[Math.floor(Math.random()*types.length)];
    const kg = Math.round((Math.random()*4 + 0.5) * 10) / 10;
    const meta = readJSON(FILES.meta);
    const amount = Math.round(kg * meta.rate_per_kg * 100) / 100;
    const arr = readJSON(FILES.waste);
    const id = 'W' + Date.now();
    arr.push({ id, user_id: tgId, waste: t, kg, amount, detected: true, status: 'pending', created_at: new Date().toISOString() });
    writeJSON(FILES.waste, arr);

    if (kg <= (meta.auto_approve_kg || 10)) {
      arr[arr.length-1].status = 'collected';
      arr[arr.length-1].collected_at = new Date().toISOString();
      writeJSON(FILES.waste, arr);
      let user = findUserByTelegram(tgId);
      user.total_kg = (user.total_kg || 0) + kg;
      user.balance = (user.balance || 0) + amount;
      user.rank = computeRank(user.total_kg);
      saveOrUpdateUser(user);
      waitingForWaste[tgId] = false;
      await ctx.reply(`Detected ${t} — ${kg}kg. Auto-approved. You earned ${formatN(amount)}. New balance: ${formatN(user.balance)} (Rank: ${user.rank})`);
      try { await bot.telegram.sendMessage(ADMIN_ID, `Auto-approved: ${id} — ${t} ${kg}kg from ${tgId} => ${formatN(amount)}`); } catch(e) {}
      return;
    }

    waitingForWaste[tgId] = false;
    await ctx.reply(`Detected ${t} — ${kg}kg. Recorded pending ID ${id}. Admin will confirm.`);
    try { await bot.telegram.sendMessage(ADMIN_ID, `Pending pickup ${id} from ${tgId}: ${kg}kg — ${formatN(amount)}`); } catch(e) {}
  } catch (e) {
    console.error('photo error', e);
    ctx.reply('Error processing photo. Try again or type description.');
  }
});

// text handler for waste/manual/withdraw/complaints/profile/history
bot.on('text', async (ctx, next) => {
  const tgId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (waitingForWaste[tgId]) {
    const low = text.toLowerCase();
    if (low === 'estimate') {
      const arr = readJSON(FILES.waste);
      const id = 'W' + Date.now();
      arr.push({ id, user_id: tgId, waste: 'ToEstimate', kg: 0, amount: 0, detected: false, status: 'awaiting_estimate', created_at: new Date().toISOString() });
      writeJSON(FILES.waste, arr);
      waitingForWaste[tgId] = false;
      ctx.reply(`Pickup for estimation recorded (ID: ${id}). Admin will arrange collection.`);
      try { await bot.telegram.sendMessage(ADMIN_ID, `Estimate pickup ${id} from ${tgId}`); } catch(e) {}
      return;
    }

    // parse weight if present
    const kgMatch = text.match(/([0-9]+(\.[0-9]+)?)/);
    let kg = kgMatch ? parseFloat(kgMatch[1]) : Math.round((Math.random()*3 + 0.5) * 10) / 10;
    const types = ['plastic','metal','glass','organic','paper','e-waste','electronics','ewaste'];
    let wasteType = 'General';
    for (const t of types) if (text.toLowerCase().includes(t)) { wasteType = t.charAt(0).toUpperCase() + t.slice(1); break; }

    const meta = readJSON(FILES.meta);
    const amount = Math.round(kg * meta.rate_per_kg * 100) / 100;
    const arr = readJSON(FILES.waste);
    const id = 'W' + Date.now();
    arr.push({ id, user_id: tgId, waste: wasteType, kg, amount, detected: false, status: 'pending', created_at: new Date().toISOString() });
    writeJSON(FILES.waste, arr);

    if (kg <= (meta.auto_approve_kg || 10)) {
      arr[arr.length-1].status = 'collected';
      arr[arr.length-1].collected_at = new Date().toISOString();
      writeJSON(FILES.waste, arr);
      let user = findUserByTelegram(tgId);
      user.total_kg = (user.total_kg || 0) + kg;
      user.balance = (user.balance || 0) + amount;
      user.rank = computeRank(user.total_kg);
      saveOrUpdateUser(user);
      waitingForWaste[tgId] = false;
      ctx.reply(`Recorded ${wasteType} — ${kg}kg. Auto-approved. You earned ${formatN(amount)}. New balance: ${formatN(user.balance)} (Rank: ${user.rank})`);
      try { await bot.telegram.sendMessage(ADMIN_ID, `Auto-approved ${id} from ${tgId}: ${kg}kg — ${formatN(amount)}`); } catch(e) {}
      return;
    }

    waitingForWaste[tgId] = false;
    return ctx.reply(`Recorded ${wasteType} — ${kg}kg. Pending admin approval. ID: ${id}`);
  }

  // Withdraw flow
  if (/^Withdraw$/i.test(text)) {
    const user = findUserByTelegram(tgId);
    if (!user || !user.verified) return ctx.reply('You must verify first with /start.');
    const available = Math.round((user.balance || 0) * 100) / 100;
    if (available <= 0) return ctx.reply('No available balance.');
    waitingForWithdraw[tgId] = { amount: available };
    return ctx.reply(`You can withdraw ${formatN(available)}. Send bank details: BankName, AccountNumber`);
  }

  if (waitingForWithdraw[tgId]) {
    const parts = text.split(',');
    if (parts.length < 2) return ctx.reply('Send bank details as "BankName, AccountNumber"');
    const bank = parts[0].trim();
    const account = parts[1].trim().replace(/\s+/g,'');
    const details = waitingForWithdraw[tgId];
    waitingForWithdraw[tgId] = null;
    const arr = readJSON(FILES.withdrawals);
    const id = 'WD' + Date.now();
    arr.push({ id, user_id: tgId, amount: details.amount, bank, account, status: 'pending', requested_at: new Date().toISOString() });
    writeJSON(FILES.withdrawals, arr);
    ctx.reply(`Withdrawal requested: ${id}. Admin will review.`);
    try { await bot.telegram.sendMessage(ADMIN_ID, `New withdrawal ${id} from ${tgId} for ${formatN(details.amount)} — Bank: ${bank}, Account: ${account}`); } catch(e) {}
    return;
  }

  // File Complaint
  if (/^File Complaint$/i.test(text)) {
    waitingForComplaint[tgId] = true;
    return ctx.reply('Please type your complaint (include state / LGA).');
  }
  if (waitingForComplaint[tgId]) {
    const id = 'C' + Date.now();
    const arr = readJSON(FILES.complaints);
    arr.push({ id, user_id: tgId, text, status: 'new', created_at: new Date().toISOString() });
    writeJSON(FILES.complaints, arr);
    waitingForComplaint[tgId] = false;
    ctx.reply('Complaint recorded. Thank you.');
    try { await bot.telegram.sendMessage(ADMIN_ID, `New complaint ${id} from ${tgId}: ${text}`); } catch(e) {}
    return;
  }

  // Profile, History, Earnings
  if (/^Profile$/i.test(text)) {
    const user = findUserByTelegram(tgId);
    if (!user) return ctx.reply('No profile. Use /start.');
    return ctx.reply(`👤 ${user.first_name}\n📞 ${user.phone||'not set'}\nVerified: ${user.verified ? 'Yes' : 'No'}\nBalance: ${formatN(user.balance||0)}\nTotal kg: ${user.total_kg||0}\nRank: ${user.rank}`);
  }
  if (/^History$/i.test(text)) {
    const arr = readJSON(FILES.waste).filter(w => w.user_id === tgId).slice(-20).reverse();
    if (!arr.length) return ctx.reply('No history.');
    const lines = arr.map(a => `${a.id} | ${a.waste} | ${a.kg||0}kg | ${formatN(a.amount||0)} | ${a.status}`);
    return ctx.reply(lines.join('\n'));
  }
  if (/^(My Earnings|My earnings|Balance|My balance)$/i.test(text)) {
    const user = findUserByTelegram(tgId);
    if (!user) return ctx.reply('No profile.');
    return ctx.reply(`Total: ${formatN(user.balance||0)}\nTotal recycled: ${user.total_kg||0}kg\nRank: ${user.rank}`);
  }

  return next();
});

// ADMIN commands (listings & actions)
bot.command('users', (ctx) => {
  if (!adminOnly(ctx)) return;
  const users = readJSON(FILES.users);
  if (!users.length) return ctx.reply('No users.');
  const summary = users.map(u => `${u.telegram_id} — ${u.first_name||u.username||''} — ${u.phone||'no phone'} — ${formatN(u.balance||0)} — kg:${u.total_kg||0}`).join('\n');
  const ch = 4000; let t = summary;
  while (t.length) { ctx.reply(t.slice(0,ch)); t = t.slice(ch); }
});
bot.command('listwaste', (ctx) => { if (!adminOnly(ctx)) return ctx.reply(readJSON(FILES.waste).map(w => `${w.id} ${w.waste} ${w.kg||0}kg ${formatN(w.amount||0)} ${w.status}`).join('\n') || 'No waste'); });
bot.command('withdrawals', (ctx) => { if (!adminOnly(ctx)) return; const arr = readJSON(FILES.withdrawals); ctx.reply(arr.map(w => `${w.id} — ${w.user_id} — ${formatN(w.amount)} — ${w.status}`).join('\n') || 'No withdrawals'); });

bot.command('approve', (ctx) => {
  if (!adminOnly(ctx)) return;
  const id = ctx.message.text.split(' ').slice(1)[0];
  if (!id) return ctx.reply('Usage: /approve <withdrawal_id>');
  const arr = readJSON(FILES.withdrawals);
  const i = arr.findIndex(x => x.id === id);
  if (i === -1) return ctx.reply('Not found');
  arr[i].status = 'approved'; arr[i].approved_at = new Date().toISOString(); writeJSON(FILES.withdrawals, arr);
  const user = findUserByTelegram(arr[i].user_id);
  if (user) { user.balance = Math.max(0, (user.balance||0) - arr[i].amount); saveOrUpdateUser(user); bot.telegram.sendMessage(user.telegram_id, `✅ Your withdrawal ${id} of ${formatN(arr[i].amount)} was approved.`); }
  ctx.reply('Approved and user debited.');
});

bot.command('reject', (ctx) => {
  if (!adminOnly(ctx)) return;
  const id = ctx.message.text.split(' ').slice(1)[0]; if (!id) return ctx.reply('Usage: /reject <withdrawal_id>');
  const arr = readJSON(FILES.withdrawals); const i = arr.findIndex(x => x.id === id); if (i === -1) return ctx.reply('Not found');
  arr[i].status = 'rejected'; arr[i].rejected_at = new Date().toISOString(); writeJSON(FILES.withdrawals, arr);
  bot.telegram.sendMessage(arr[i].user_id, `❌ Your withdrawal ${id} was rejected by admin.`);
  ctx.reply('Rejected.');
});

bot.command('credit', (ctx) => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1);
  if (parts.length < 2) return ctx.reply('Usage: /credit <telegram_id_or_username> <amount>');
  let target = parts[0]; const amount = parseFloat(parts[1]); if (isNaN(amount) || amount <= 0) return ctx.reply('Invalid amount.');
  const users = readJSON(FILES.users);
  let user = users.find(u => String(u.telegram_id) === target);
  if (!user) { if (target.startsWith('@')) target = target.slice(1); user = users.find(u => (u.username||'').toLowerCase() === target.toLowerCase()); }
  if (!user) return ctx.reply('User not found.');
  user.balance = (user.balance || 0) + amount; saveOrUpdateUser(user);
  bot.telegram.sendMessage(user.telegram_id, `💰 Admin credited your account with ${formatN(amount)}. New balance: ${formatN(user.balance)}.`);
  ctx.reply(`Credited ${formatN(amount)}.`);
});

bot.command('markcollected', (ctx) => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1);
  if (!parts.length) return ctx.reply('Usage: /markcollected <waste_id> [actual_kg]');
  const id = parts[0]; const arr = readJSON(FILES.waste); const i = arr.findIndex(x => x.id === id); if (i === -1) return ctx.reply('Not found');
  let actual = arr[i].kg || 0; if (parts[1]) { const p = parseFloat(parts[1]); if (!isNaN(p)) actual = p; }
  arr[i].status = 'collected'; arr[i].actual_kg = actual; arr[i].collected_at = new Date().toISOString(); writeJSON(FILES.waste, arr);
  const user = findUserByTelegram(arr[i].user_id); if (user) { user.total_kg = (user.total_kg||0)+actual; const amt = Math.round(actual * (readJSON(FILES.meta).rate_per_kg || Number(process.env.RATE_PER_KG||120)) * 100)/100; user.balance = (user.balance||0)+amt; user.rank = computeRank(user.total_kg); saveOrUpdateUser(user); bot.telegram.sendMessage(user.telegram_id, `✅ Your pickup ${id} was collected. You earned ${formatN(amt)}.`); }
  ctx.reply('Marked collected and credited user.');
});

bot.command('setrate', (ctx) => {
  if (!adminOnly(ctx)) return;
  const v = parseFloat(ctx.message.text.split(' ').slice(1)[0]); if (isNaN(v) || v <= 0) return ctx.reply('Usage: /setrate <amount>');
  const meta = readJSON(FILES.meta); meta.rate_per_kg = v; writeJSON(FILES.meta, meta); ctx.reply(`Rate set to ${formatN(v)}.`);
});

bot.command('broadcast', async (ctx) => {
  if (!adminOnly(ctx)) return;
  const message = ctx.message.text.split(' ').slice(1).join(' ');
  if (!message) return ctx.reply('Usage: /broadcast <message>');
  const users = readJSON(FILES.users);
  let sent = 0;
  for (const u of users) {
    try { await bot.telegram.sendMessage(u.telegram_id, `📣 Admin: ${message}`); sent++; } catch(e){}
  }
  ctx.reply(`Broadcast to ${sent} users.`);
});

bot.command('ban', (ctx) => {
  if (!adminOnly(ctx)) return;
  const id = Number(ctx.message.text.split(' ').slice(1)[0]); if (!id) return ctx.reply('Usage: /ban <tg_id>');
  const meta = readJSON(FILES.meta); meta.banned = meta.banned || []; if (!meta.banned.includes(id)) meta.banned.push(id); writeJSON(FILES.meta, meta); ctx.reply(`Banned ${id}`);
});
bot.command('unban', (ctx) => {
  if (!adminOnly(ctx)) return;
  const id = Number(ctx.message.text.split(' ').slice(1)[0]); if (!id) return ctx.reply('Usage: /unban <tg_id>');
  const meta = readJSON(FILES.meta); meta.banned = (meta.banned||[]).filter(x => x !== id); writeJSON(FILES.meta, meta); ctx.reply(`Unbanned ${id}`);
});

bot.command('export', async (ctx) => {
  if (!adminOnly(ctx)) return;
  try {
    await ctx.reply('Exporting files...');
    await ctx.replyWithDocument({ source: FILES.users });
    await ctx.replyWithDocument({ source: FILES.waste });
    await ctx.replyWithDocument({ source: FILES.withdrawals });
    await ctx.replyWithDocument({ source: FILES.complaints });
    ctx.reply('Done.');
  } catch (e) {
    ctx.reply('Export failed: ' + e.message);
  }
});

bot.command('help', (ctx) => {
  ctx.reply(`User commands: Use /start then: Scan Waste, My Earnings, Withdraw, File Complaint, History, Profile\nAdmin commands: /setrate /users /listwaste /withdrawals /approve /reject /credit /markcollected /broadcast /ban /unban /export`);
});

// Launch
bot.launch().then(() => console.log('CleanNaija bot launched')).catch(e => console.error('Bot launch error', e));
process.once('SIGINT', () => bot.stop('SIGINT')); process.once('SIGTERM', () => bot.stop('SIGTERM'));
