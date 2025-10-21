/**
 * bot.js - CleanNaija full feature bot
 * - Twilio verify OTP (or test fallback 123456)
 * - Telegram contact or manual phone
 * - Waste scan (photo/manual), auto-detect kg simulation
 * - Earnings simulation, wallet, withdrawals (request -> admin approve)
 * - Complaints, referrals, history
 * - Admin commands: approve/reject withdrawal, credit user, set rate, broadcast, export data, list users/waste
 * - Local JSON storage (auto-create files in ./data)
 *
 * Dependencies: telegraf, twilio, dotenv, axios (optional)
 *
 * Place in same folder as .env that includes:
 * TELEGRAM_TOKEN, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID, ADMIN_TELEGRAM_ID
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const twilioSdk = require('twilio');
const axios = require('axios');

// init twilio client (may be empty; we support test fallback)
const TW_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TW_AUTH = process.env.TWILIO_AUTH_TOKEN || '';
const TW_VERIFY = process.env.TWILIO_VERIFY_SID || '';
let twilio = null;
if (TW_SID && TW_AUTH) {
  try { twilio = twilioSdk(TW_SID, TW_AUTH); } catch (e){ twilio = null; console.error('Twilio init error', e.message); }
}

// Bot and config
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
if (!BOT_TOKEN) { console.error('Missing TELEGRAM_TOKEN'); process.exit(1); }
const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_ID || 7003416998);
const DEFAULT_RATE = Number(process.env.RATE_PER_KG || 120);

const bot = new Telegraf(BOT_TOKEN);

// Data files
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
const ensureFile = (f, init) => { if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(init, null, 2)); };
ensureFile(FILES.users, []);
ensureFile(FILES.waste, []);
ensureFile(FILES.withdrawals, []);
ensureFile(FILES.complaints, []);
ensureFile(FILES.referrals, []);
ensureFile(FILES.meta, { rate_per_kg: DEFAULT_RATE, verification_days: 30, auto_approve_kg: 10, admins: [ADMIN_ID], banned: [] });

// JSON helpers
const read = file => JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// Utilities
function findUserByTelegram(id) {
  return read(FILES.users).find(u => u.telegram_id === id);
}
function saveOrUpdateUser(u) {
  const arr = read(FILES.users);
  const i = arr.findIndex(x => x.telegram_id === u.telegram_id);
  if (i === -1) arr.push(u); else arr[i] = u;
  write(FILES.users, arr);
}
function computeRank(totalKg) {
  if (!totalKg) totalKg = 0;
  if (totalKg >= 500) return 'Eco-Champion';
  if (totalKg >= 200) return 'Recycler-Hero';
  if (totalKg >= 50) return 'Eco-Warrior';
  if (totalKg >= 10) return 'Starter Recycler';
  return 'Newbie';
}
function formatN(amount) { return `₦${Number(amount || 0).toFixed(2)}`; }

// In-memory state
const pendingVerify = {};        // tgId -> { phone, attempts, ts, refBy }
const waitingForWaste = {};      // tgId -> true
const waitingForWithdrawBank = {}; // tgId -> { amount }
const waitingForComplaint = {};  // tgId -> true
const greetedUsers = new Set();  // prevent duplicate welcome messages

// Validation helpers
function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).trim();
  s = s.replace(/\s+/g, '');
  if (!s.startsWith('+')) {
    // assume Nigeria if starts with 0 or 234
    if (s.startsWith('0')) s = '+234' + s.slice(1);
    else if (s.startsWith('234')) s = '+' + s;
    else s = '+' + s;
  }
  return s;
}

// Twilio wrappers with test fallback
async function sendOtp(phone) {
  // returns { success: true } on success, { success:false, error: ... } on fail
  if (!twilio || !TW_VERIFY) {
    // test fallback
    return { success: true, simulated: true };
  }
  try {
    const resp = await twilio.verify.v2.services(TW_VERIFY).verifications.create({ to: phone, channel: 'sms' });
    return { success: true, sid: resp.sid, status: resp.status };
  } catch (err) {
    return { success: false, error: err.message || JSON.stringify(err) };
  }
}
async function checkOtp(phone, code) {
  if (!twilio || !TW_VERIFY) {
    return { success: code === '123456', simulated: true, code };
  }
  try {
    const resp = await twilio.verify.v2.services(TW_VERIFY).verificationChecks.create({ to: phone, code });
    return { success: resp.status === 'approved', status: resp.status };
  } catch (err) {
    return { success: false, error: err.message || JSON.stringify(err) };
  }
}

// MAIN FLOWS

// START - verification-first
bot.start(async (ctx) => {
  const tg = ctx.from;
  // greet once per session (avoid double welcome)
  if (greetedUsers.has(tg.id)) return;
  greetedUsers.add(tg.id);

  // ensure user record
  let user = findUserByTelegram(tg.id);
  if (!user) {
    user = { telegram_id: tg.id, username: tg.username || '', first_name: tg.first_name || '', phone: null, verified: false, verified_at: null, total_kg: 0, balance: 0, referrals_count: 0, rank: 'Newbie', banned: false };
    saveOrUpdateUser(user);
  }

  const meta = read(FILES.meta);
  // banned?
  if ((meta.banned || []).includes(tg.id) || user.banned) {
    return ctx.reply('Your account is suspended. Contact admin.');
  }

  // if verified within expiry, show menu
  if (user.verified && user.verified_at) {
    const days = meta.verification_days || 30;
    const diffDays = (Date.now() - new Date(user.verified_at).getTime()) / (1000*60*60*24);
    if (diffDays <= days) {
      return showMainMenu(ctx, user);
    }
  }

  // else prompt verification choice
  return ctx.reply('Welcome to CleanNaija — phone verification required. Choose an option:', Markup.keyboard([['Use Telegram Number','Enter Phone Manually']]).oneTime().resize());
});

// show main menu
async function showMainMenu(ctx, user) {
  const kb = Markup.keyboard([['Scan Waste','My Earnings'], ['Withdraw','File Complaint'], ['History','Tips']]).resize();
  await ctx.reply(`Hi ${user.first_name || ''}! Choose an option:`, kb);
}

// CONTACT share (telegram contact)
bot.on('contact', async (ctx) => {
  try {
    const contact = ctx.message.contact;
    const tgId = ctx.from.id;
    const phone = normalizePhone(contact.phone_number);
    if (!phone) return ctx.reply('Invalid phone provided.');

    let user = findUserByTelegram(tgId) || { telegram_id: tgId, username: ctx.from.username || '', first_name: ctx.from.first_name || '' };
    user.phone = phone;
    user.verified = false;
    saveOrUpdateUser(user);

    const res = await sendOtp(phone);
    pendingVerify[tgId] = { phone, attempts: 0, ts: Date.now(), refBy: null };
    if (res.success) return ctx.reply(`OTP sent to ${phone}. Enter the 6-digit code (test: 123456).`);
    return ctx.reply('Failed to send OTP: ' + (res.error || 'unknown'));
  } catch (e) {
    console.error('contact handler error', e);
    return ctx.reply('Contact handling failed.');
  }
});

// ENTER PHONE manually
bot.hears(new RegExp('^Enter Phone Manually$', 'i'), ctx => ctx.reply('Please send your phone in international format, e.g. +2348012345678'));
bot.hears(/^\+?[0-9]{7,15}$/, async (ctx) => {
  // if text looks like a phone
  const tgId = ctx.from.id;
  const phone = normalizePhone(ctx.message.text.trim());
  if (!phone) return ctx.reply('Phone format invalid.');

  let user = findUserByTelegram(tgId) || { telegram_id: tgId, username: ctx.from.username || '', first_name: ctx.from.first_name || ''};
  user.phone = phone; user.verified = false;
  saveOrUpdateUser(user);

  const res = await sendOtp(phone);
  pendingVerify[tgId] = { phone, attempts: 0, ts: Date.now(), refBy: null };
  if (res.success) return ctx.reply(`OTP sent to ${phone}. Enter the 6-digit code (test: 123456).`);
  return ctx.reply('Failed to send OTP: ' + (res.error || 'unknown'));
});

// OTP entry handler (4-8 digits allowed)
bot.hears(/^\d{4,8}$/, async (ctx) => {
  const code = ctx.message.text.trim();
  const tgId = ctx.from.id;
  const session = pendingVerify[tgId];
  if (!session) return; // not an OTP context

  session.attempts = (session.attempts || 0) + 1;
  if (session.attempts > 6) { delete pendingVerify[tgId]; return ctx.reply('Too many attempts. Restart with /start.'); }

  const chk = await checkOtp(session.phone, code);
  if (chk.success) {
    let user = findUserByTelegram(tgId) || { telegram_id: tgId, username: ctx.from.username||'', first_name: ctx.from.first_name||'' };
    user.phone = session.phone;
    user.verified = true;
    user.verified_at = new Date().toISOString();
    saveOrUpdateUser(user);

    // referral bonus
    if (session.refBy) {
      const refArr = read(FILES.referrals);
      refArr.push({ referrer: session.refBy, referred: tgId, date: new Date().toISOString() });
      write(FILES.referrals, refArr);
      const refUser = findUserByTelegram(session.refBy);
      if (refUser) {
        refUser.balance = (refUser.balance || 0) + 50;
        refUser.referrals_count = (refUser.referrals_count || 0) + 1;
        saveOrUpdateUser(refUser);
      }
      user.balance = (user.balance || 0) + 50;
      saveOrUpdateUser(user);
      ctx.reply('Verification successful — referral bonus applied (₦50).');
    } else {
      ctx.reply('✅ Phone verified successfully!');
    }

    delete pendingVerify[tgId];
    return showMainMenu(ctx, user);
  } else {
    return ctx.reply('OTP invalid: ' + (chk.error || 'not approved') + `. Attempts: ${session.attempts}/6`);
  }
});

// SCAN WASTE flow starters
bot.hears(/Scan Waste/i, ctx => {
  const user = findUserByTelegram(ctx.from.id);
  if (!user || !user.verified) return ctx.reply('You must verify your phone first. Use /start and share contact or enter number.');
  waitingForWaste[ctx.from.id] = true;
  return ctx.reply('Send a photo of the waste OR type description and weight (e.g. "plastic 2.5") or type "estimate" for collector estimate.');
});

// PHOTO handler -> simulate detection
bot.on('photo', async (ctx) => {
  const tgId = ctx.from.id;
  if (!waitingForWaste[tgId]) return; // ignore photos outside flow
  // simulate detection
  const types = ['Plastic','Metal','Glass','Organic','Paper','E-waste'];
  const wasteType = types[Math.floor(Math.random()*types.length)];
  const kg = Math.round((Math.random()*4 + 0.5) * 10) / 10; // 0.5 - 4.5
  const meta = read(FILES.meta);
  const amount = Math.round(kg * meta.rate_per_kg * 100) / 100;
  const arr = read(FILES.waste);
  const id = 'W' + Date.now();
  arr.push({ id, user_id: tgId, waste: wasteType, kg, amount, detected: true, status: 'pending', created_at: new Date().toISOString() });
  write(FILES.waste, arr);

  // auto-approve small pickups
  if (kg <= (meta.auto_approve_kg || 10)) {
    arr[arr.length-1].status = 'collected';
    arr[arr.length-1].collected_at = new Date().toISOString();
    write(FILES.waste, arr);
    let user = findUserByTelegram(tgId);
    user.total_kg = (user.total_kg || 0) + kg;
    user.balance = (user.balance || 0) + amount;
    user.rank = computeRank(user.total_kg);
    saveOrUpdateUser(user);
    waitingForWaste[tgId] = false;
    ctx.reply(`Detected ${wasteType} — ${kg}kg. Auto-approved. You earned ${formatN(amount)}. New balance: ${formatN(user.balance)} (Rank: ${user.rank})`);
    // notify admin
    try { await bot.telegram.sendMessage(ADMIN_ID, `Auto-approved: ${id} — ${wasteType} ${kg}kg from ${tgId} => ${formatN(amount)}`); } catch(e) {}
    return;
  }

  waitingForWaste[tgId] = false;
  ctx.reply(`Recorded ${wasteType} — ${kg}kg as pending. ID: ${id}. Admin will confirm collection.`);
  try { await bot.telegram.sendMessage(ADMIN_ID, `Pending pickup ${id} from ${tgId}: ${kg}kg — ${formatN(amount)}`); } catch(e) {}
});

// TEXT handler: waste manual, withdraw bank, complaints, tips etc.
bot.on('text', async (ctx, next) => {
  const tgId = ctx.from.id;
  const text = ctx.message.text.trim();

  // waiting for waste manual input
  if (waitingForWaste[tgId]) {
    const lowered = text.toLowerCase();
    if (lowered === 'estimate') {
      const arr = read(FILES.waste);
      const id = 'W' + Date.now();
      arr.push({ id, user_id: tgId, waste: 'ToEstimate', kg: 0, amount: 0, detected: false, status: 'awaiting_collection', created_at: new Date().toISOString() });
      write(FILES.waste, arr);
      waitingForWaste[tgId] = false;
      ctx.reply(`Pickup recorded for estimation. ID: ${id}.`);
      try { await bot.telegram.sendMessage(ADMIN_ID, `Estimate pickup ${id} from ${tgId}`); } catch(e) {}
      return;
    }
    // try parse kg
    const kgMatch = text.match(/([0-9]+(\.[0-9]+)?)/);
    let kg = kgMatch ? parseFloat(kgMatch[1]) : Math.round((Math.random()*3 + 0.5) * 10) / 10;
    // detect waste type
    const types = ['plastic','metal','glass','organic','paper','e-waste','electronics','ewaste'];
    let wasteType = 'General';
    for (const t of types) if (text.toLowerCase().includes(t)) { wasteType = t.charAt(0).toUpperCase() + t.slice(1); break; }

    const meta = read(FILES.meta);
    const amount = Math.round(kg * meta.rate_per_kg * 100) / 100;
    const arr = read(FILES.waste);
    const id = 'W' + Date.now();
    arr.push({ id, user_id: tgId, waste: wasteType, kg, amount, detected: false, status: 'pending', created_at: new Date().toISOString() });
    write(FILES.waste, arr);

    // auto-approve if small
    if (kg <= (meta.auto_approve_kg || 10)) {
      arr[arr.length-1].status = 'collected';
      arr[arr.length-1].collected_at = new Date().toISOString();
      write(FILES.waste, arr);
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

  // waiting for withdraw bank details
  if (waitingForWithdrawBank[tgId]) {
    const parts = text.split(',');
    if (parts.length < 2) return ctx.reply('Please send bank details as "BankName, AccountNumber"');
    const bank = parts[0].trim();
    const account = parts[1].trim().replace(/\s+/g,'');
    const details = waitingForWithdrawBank[tgId];
    waitingForWithdrawBank[tgId] = null;
    const arr = read(FILES.withdrawals);
    const id = 'WD' + Date.now();
    arr.push({ id, user_id: tgId, amount: details.amount, bank, account, status: 'pending', requested_at: new Date().toISOString() });
    write(FILES.withdrawals, arr);
    ctx.reply(`Withdrawal requested: ${id}. Admin will review.`);
    try { await bot.telegram.sendMessage(ADMIN_ID, `New withdrawal ${id} from ${tgId} for ${formatN(details.amount)} — Bank: ${bank}, Account: ${account}`); } catch(e) {}
    return;
  }

  // waiting for complaint
  if (waitingForComplaint[tgId]) {
    const id = 'C' + Date.now();
    const arr = read(FILES.complaints);
    arr.push({ id, user_id: tgId, text, status: 'new', created_at: new Date().toISOString() });
    write(FILES.complaints, arr);
    waitingForComplaint[tgId] = false;
    ctx.reply('Complaint recorded. Thank you.');
    try { await bot.telegram.sendMessage(ADMIN_ID, `New complaint ${id} from ${tgId}: ${text}`); } catch(e) {}
    return;
  }

  return next();
});

// My Earnings
bot.hears(/My Earnings/i, ctx => {
  const user = findUserByTelegram(ctx.from.id);
  if (!user) return ctx.reply('No profile found. Use /start.');
  return ctx.reply(`Name: ${user.first_name || ''}\nTotal kg recorded: ${user.total_kg || 0}\nAvailable (simulated): ${formatN(user.balance || 0)}\nRate per kg: ${formatN(read(FILES.meta).rate_per_kg || DEFAULT_RATE)}`);
});

// History
bot.hears(/History/i, ctx => {
  const arr = read(FILES.waste).filter(w => w.user_id === ctx.from.id).slice(-20).reverse();
  if (!arr.length) return ctx.reply('No history.');
  const lines = arr.map(a => `${a.id} | ${a.waste} | ${a.kg || 0}kg | ${formatN(a.amount || 0)} | ${a.status}`);
  return ctx.reply(lines.join('\n'));
});

// Tips
bot.hears(/Tips/i, ctx => ctx.reply('Tip: Separate dry recyclables (plastic, metal, glass) from organic to increase value.'));

// Withdraw
bot.hears(/Withdraw/i, ctx => {
  const user = findUserByTelegram(ctx.from.id);
  if (!user || !user.verified) return ctx.reply('You must verify your phone first.');
  const available = Math.max(0, (user.balance || 0));
  if (available <= 0) return ctx.reply('No available balance to withdraw.');
  waitingForWithdrawBank[ctx.from.id] = { amount: Math.round(available * 100) / 100 };
  return ctx.reply(`You can withdraw ${formatN(available)}. Send bank details as: BankName, AccountNumber`);
});

// File Complaint
bot.hears(/File Complaint/i, ctx => { waitingForComplaint[ctx.from.id] = true; ctx.reply('Please type your complaint (include state/LGA if relevant).'); });

// ADMIN: helper to restrict commands
function adminOnly(ctx) {
  if (ctx.from.id !== ADMIN_ID && !((read(FILES.meta).admins || []).includes(ctx.from.id))) {
    ctx.reply('Unauthorized. Admins only.');
    return false;
  }
  return true;
}

// Admin: list users
bot.command('users', ctx => {
  if (!adminOnly(ctx)) return;
  const users = read(FILES.users);
  if (!users.length) return ctx.reply('No users.');
  const lines = users.map(u => `${u.telegram_id} — ${u.first_name||''} — ${u.phone||'no phone'} — ${formatN(u.balance||0)} — kg:${u.total_kg||0}`);
  // chunk if too long
  const chunkSize = 4000;
  let text = lines.join('\n');
  while (text.length) {
    ctx.reply(text.slice(0, chunkSize));
    text = text.slice(chunkSize);
  }
});

// Admin: list waste
bot.command('listwaste', ctx => {
  if (!adminOnly(ctx)) return;
  const arr = read(FILES.waste);
  if (!arr.length) return ctx.reply('No waste records.');
  const lines = arr.map(p => `${p.id} — user:${p.user_id} — ${p.waste} — ${p.kg || 0}kg — ${formatN(p.amount||0)} — ${p.status||'n/a'}`);
  ctx.reply(lines.join('\n'));
});

// Admin: list withdrawals
bot.command('withdrawals', ctx => {
  if (!adminOnly(ctx)) return;
  const arr = read(FILES.withdrawals);
  if (!arr.length) return ctx.reply('No withdrawals.');
  const lines = arr.map(w => `${w.id} — user:${w.user_id} — ${formatN(w.amount)} — ${w.status}`);
  ctx.reply(lines.join('\n'));
});

// Admin: approve withdrawal /approve <id>
bot.command('approve', ctx => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1);
  if (!parts.length) return ctx.reply('Usage: /approve <withdrawal_id>');
  const id = parts[0];
  const arr = read(FILES.withdrawals);
  const i = arr.findIndex(x => x.id === id);
  if (i === -1) return ctx.reply('Withdrawal not found.');
  arr[i].status = 'approved';
  arr[i].approved_at = new Date().toISOString();
  write(FILES.withdrawals, arr);
  // debit user's simulated balance
  const user = findUserByTelegram(arr[i].user_id);
  if (user) {
    user.balance = Math.max(0, (user.balance || 0) - arr[i].amount);
    saveOrUpdateUser(user);
    bot.telegram.sendMessage(user.telegram_id, `Your withdrawal ${id} of ${formatN(arr[i].amount)} has been approved by admin.`);
  }
  ctx.reply('Withdrawal approved and user debited.');
});

// Admin: reject withdrawal /reject <id>
bot.command('reject', ctx => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1);
  if (!parts.length) return ctx.reply('Usage: /reject <withdrawal_id>');
  const id = parts[0];
  const arr = read(FILES.withdrawals);
  const i = arr.findIndex(x => x.id === id);
  if (i === -1) return ctx.reply('Withdrawal not found.');
  arr[i].status = 'rejected';
  arr[i].rejected_at = new Date().toISOString();
  write(FILES.withdrawals, arr);
  bot.telegram.sendMessage(arr[i].user_id, `Your withdrawal ${id} has been rejected by admin.`);
  ctx.reply('Withdrawal rejected.');
});

// Admin: credit (simulate payout) /credit <telegram_id_or_username> <amount>
bot.command('credit', ctx => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1);
  if (parts.length < 2) return ctx.reply('Usage: /credit <telegram_id_or_username> <amount>');
  let target = parts[0];
  const amount = parseFloat(parts[1]);
  if (isNaN(amount) || amount <= 0) return ctx.reply('Invalid amount.');
  // try find by id first, then username
  let user = null;
  const users = read(FILES.users);
  const byId = users.find(u => String(u.telegram_id) === target);
  if (byId) user = byId;
  else {
    if (target.startsWith('@')) target = target.slice(1);
    const byName = users.find(u => (u.username || '').toLowerCase() === target.toLowerCase());
    if (byName) user = byName;
  }
  if (!user) return ctx.reply('User not found.');
  user.balance = (user.balance || 0) + amount;
  saveOrUpdateUser(user);
  bot.telegram.sendMessage(user.telegram_id, `Admin credited your account with ${formatN(amount)}. New balance: ${formatN(user.balance)}.`);
  ctx.reply(`Credited ${formatN(amount)} to ${user.telegram_id}`);
});

// Admin: mark collected /markcollected <waste_id> [actual_kg]
bot.command('markcollected', ctx => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1);
  if (!parts.length) return ctx.reply('Usage: /markcollected <waste_id> [actual_kg]');
  const id = parts[0];
  const arr = read(FILES.waste);
  const i = arr.findIndex(x => x.id === id);
  if (i === -1) return ctx.reply('Waste id not found.');
  let actual = arr[i].kg || 0;
  if (parts[1]) {
    const p = parseFloat(parts[1]);
    if (!isNaN(p)) actual = p;
  }
  arr[i].status = 'collected';
  arr[i].actual_kg = actual;
  arr[i].collected_at = new Date().toISOString();
  write(FILES.waste, arr);
  const user = findUserByTelegram(arr[i].user_id);
  if (user) {
    user.total_kg = (user.total_kg || 0) + actual;
    const amt = Math.round(actual * (read(FILES.meta).rate_per_kg || DEFAULT_RATE) * 100) / 100;
    user.balance = (user.balance || 0) + amt;
    user.rank = computeRank(user.total_kg);
    saveOrUpdateUser(user);
    bot.telegram.sendMessage(user.telegram_id, `Your pickup ${id} was collected. You earned ${formatN(amt)} (kg:${actual}).`);
  }
  ctx.reply(`Marked ${id} as collected and credited user.`);
});

// Admin: set rate /setrate <amount>
bot.command('setrate', ctx => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1);
  if (!parts.length) return ctx.reply('Usage: /setrate <amount>');
  const amt = parseFloat(parts[0]);
  if (isNaN(amt) || amt <= 0) return ctx.reply('Invalid amount.');
  const meta = read(FILES.meta);
  meta.rate_per_kg = amt;
  write(FILES.meta, meta);
  ctx.reply(`Rate per kg set to ${formatN(amt)}.`);
});

// Admin: broadcast /broadcast <message...>
bot.command('broadcast', async ctx => {
  if (!adminOnly(ctx)) return;
  const text = ctx.message.text.split(' ').slice(1).join(' ');
  if (!text) return ctx.reply('Usage: /broadcast <message>');
  const users = read(FILES.users);
  let sent = 0;
  for (const u of users) {
    try { await bot.telegram.sendMessage(u.telegram_id, `📣 Admin broadcast:\n\n${text}`); sent++; } catch(e){ /* ignore */ }
  }
  ctx.reply(`Broadcast attempted to ${sent} users.`);
});

// Admin: ban /unban
bot.command('ban', ctx => {
  if (!adminOnly(ctx)) return;
  const id = Number(ctx.message.text.split(' ').slice(1)[0]);
  if (!id) return ctx.reply('Usage: /ban <telegram_id>');
  const meta = read(FILES.meta);
  meta.banned = meta.banned || [];
  if (!meta.banned.includes(id)) meta.banned.push(id);
  write(FILES.meta, meta);
  ctx.reply(`Banned ${id}`);
});
bot.command('unban', ctx => {
  if (!adminOnly(ctx)) return;
  const id = Number(ctx.message.text.split(' ').slice(1)[0]);
  if (!id) return ctx.reply('Usage: /unban <telegram_id>');
  const meta = read(FILES.meta);
  meta.banned = (meta.banned || []).filter(x => x !== id);
  write(FILES.meta, meta);
  ctx.reply(`Unbanned ${id}`);
});

// Admin: export data files (send JSON)
bot.command('export', async ctx => {
  if (!adminOnly(ctx)) return;
  try {
    await ctx.reply('Preparing files...');
    await ctx.replyWithDocument({ source: FILES.users });
    await ctx.replyWithDocument({ source: FILES.waste });
    await ctx.replyWithDocument({ source: FILES.withdrawals });
    await ctx.replyWithDocument({ source: FILES.complaints });
    ctx.reply('Export sent.');
  } catch (e) {
    console.error('export error', e);
    ctx.reply('Export failed: ' + e.message);
  }
});

// small helper: /me
bot.command('me', ctx => {
  const user = findUserByTelegram(ctx.from.id);
  if (!user) return ctx.reply('No profile. Use /start.');
  ctx.reply(`You:\nName: ${user.first_name}\nPhone: ${user.phone||'not set'}\nVerified: ${user.verified ? 'Yes' : 'No'}\nBalance: ${formatN(user.balance||0)}\nTotal kg: ${user.total_kg||0}\nRank: ${user.rank}`);
});

// help
bot.command('help', ctx => {
  const txt = `Commands (users): Scan Waste, My Earnings, Withdraw, File Complaint, History, Tips\nAdmin commands: /setrate /users /listwaste /withdrawals /approve /reject /credit /markcollected /broadcast /ban /unban /export`;
  ctx.reply(txt);
});

// Launch
bot.launch().then(()=> console.log('CleanNaijaBot running — Admin:', ADMIN_ID)).catch(e => console.error('Launch failed', e));

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
