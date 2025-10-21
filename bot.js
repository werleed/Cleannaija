/**
 * bot.js - CleanNaija full feature bot (ready to run)
 * Dependencies: telegraf, twilio, dotenv, axios, express (optional)
 * Save as bot.js at project root (same folder as package.json & .env)
 */

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const twilioSdk = require('twilio');
const axios = require('axios');

// ============ Configuration ============
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
if (!BOT_TOKEN) { console.error('Missing TELEGRAM_TOKEN'); process.exit(1); }
const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_ID || 7003416998);
const DEFAULT_RATE = Number(process.env.RATE_PER_KG || 120);

const TW_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TW_AUTH = process.env.TWILIO_AUTH_TOKEN || '';
const TW_VERIFY = process.env.TWILIO_VERIFY_SID || '';
let twilio = null;
if (TW_SID && TW_AUTH) {
  try { twilio = twilioSdk(TW_SID, TW_AUTH); } catch (e) { console.error('Twilio init err', e.message); }
}

// ============ Data files ==============
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

const read = f => JSON.parse(fs.readFileSync(f, 'utf8') || '[]');
const write = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

// ============ Helpers =================
const bot = new Telegraf(BOT_TOKEN);
const pendingVerify = {};      // tgId -> { phone, attempts, ts, refBy }
const waitingForWaste = {};    // tgId -> true
const waitingForWithdrawBank = {};
const waitingForComplaint = {};
const greetedUsers = new Set();

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).trim().replace(/\s+/g, '');
  if (!s.startsWith('+')) {
    if (s.startsWith('0')) s = '+234' + s.slice(1);
    else if (s.startsWith('234')) s = '+' + s;
    else s = '+' + s;
  }
  return s;
}
function findUserByTelegram(id) { return read(FILES.users).find(u => u.telegram_id === id); }
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
function formatN(n) { return `₦${Number(n||0).toFixed(2)}`; }

// Twilio wrappers with test fallback (OTP = 123456)
async function sendOtp(phone) {
  if (!twilio || !TW_VERIFY) return { success: true, simulated: true };
  try {
    const resp = await twilio.verify.v2.services(TW_VERIFY).verifications.create({ to: phone, channel: 'sms' });
    return { success: true, sid: resp.sid, status: resp.status };
  } catch (e) { return { success: false, error: e.message || String(e) }; }
}
async function checkOtp(phone, code) {
  if (!twilio || !TW_VERIFY) return { success: code === '123456', simulated: true };
  try {
    const resp = await twilio.verify.v2.services(TW_VERIFY).verificationChecks.create({ to: phone, code });
    return { success: resp.status === 'approved', status: resp.status };
  } catch (e) { return { success: false, error: e.message || String(e) }; }
}

// ============ Bot flows ================
bot.start(async (ctx) => {
  const t = ctx.from;
  if (greetedUsers.has(t.id)) return;
  greetedUsers.add(t.id);

  let user = findUserByTelegram(t.id);
  if (!user) {
    user = { telegram_id: t.id, username: t.username||'', first_name: t.first_name||'', phone: null, verified: false, verified_at: null, total_kg: 0, balance: 0, referrals_count: 0, rank: 'Newbie', banned: false };
    saveOrUpdateUser(user);
  }
  const meta = read(FILES.meta);
  if ((meta.banned||[]).includes(t.id) || user.banned) return ctx.reply('Your account is suspended. Contact admin.');

  if (user.verified && user.verified_at) {
    const days = meta.verification_days || 30;
    const diff = (Date.now() - new Date(user.verified_at).getTime())/(1000*60*60*24);
    if (diff <= days) return showMainMenu(ctx, user);
  }

  return ctx.reply('Welcome to CleanNaija — phone verification required. Choose an option:', Markup.keyboard([['Use Telegram Number','Enter Phone Manually']]).oneTime().resize());
});

async function showMainMenu(ctx, user) {
  await ctx.reply(`Hi ${user.first_name||''}! Choose:`, Markup.keyboard([['Scan Waste','My Earnings'], ['Withdraw','File Complaint'], ['History','Tips']]).resize());
}

// Contact share
bot.on('contact', async (ctx) => {
  try {
    const contact = ctx.message.contact;
    const tgId = ctx.from.id;
    const phone = normalizePhone(contact.phone_number);
    if (!phone) return ctx.reply('Invalid phone supplied.');

    let user = findUserByTelegram(tgId) || { telegram_id: tgId, username: ctx.from.username||'', first_name: ctx.from.first_name||'' };
    user.phone = phone; user.verified = false;
    saveOrUpdateUser(user);

    const res = await sendOtp(phone);
    pendingVerify[tgId] = { phone, attempts: 0, ts: Date.now(), refBy: null };
    if (res.success) return ctx.reply(`OTP sent to ${phone}. Enter the 6-digit code (test mode: 123456).`);
    return ctx.reply('Failed to send OTP: ' + (res.error||'unknown'));
  } catch (e) {
    console.error('contact err', e);
    ctx.reply('Contact handling failed.');
  }
});

// Manual entry
bot.hears(new RegExp('^Enter Phone Manually$','i'), ctx => ctx.reply('Send phone in international format (e.g. +2348012345678)'));
bot.hears(/^\+?[0-9]{7,15}$/, async (ctx) => {
  const tgId = ctx.from.id; const phone = normalizePhone(ctx.message.text.trim());
  if (!phone) return ctx.reply('Invalid phone format.');
  let user = findUserByTelegram(tgId) || { telegram_id: tgId, username: ctx.from.username||'', first_name: ctx.from.first_name||''};
  user.phone = phone; user.verified = false; saveOrUpdateUser(user);
  const res = await sendOtp(phone);
  pendingVerify[tgId] = { phone, attempts: 0, ts: Date.now(), refBy: null };
  if (res.success) return ctx.reply(`OTP sent to ${phone}. Enter the 6-digit code (test mode: 123456).`);
  return ctx.reply('Failed to send OTP: ' + (res.error||'unknown'));
});

// OTP input
bot.hears(/^\d{4,8}$/, async (ctx) => {
  const code = ctx.message.text.trim(), tgId = ctx.from.id, session = pendingVerify[tgId];
  if (!session) return; session.attempts = (session.attempts||0)+1;
  if (session.attempts > 6) { delete pendingVerify[tgId]; return ctx.reply('Too many attempts. Restart /start.'); }
  const chk = await checkOtp(session.phone, code);
  if (chk.success) {
    let user = findUserByTelegram(tgId) || { telegram_id: tgId, username: ctx.from.username||'', first_name: ctx.from.first_name||'' };
    user.phone = session.phone; user.verified = true; user.verified_at = new Date().toISOString();
    // referral bonus if present
    if (session.refBy) {
      const refs = read(FILES.referrals);
      refs.push({ referrer: session.refBy, referred: tgId, date: new Date().toISOString() });
      write(FILES.referrals, refs);
      const refUser = findUserByTelegram(session.refBy);
      if (refUser) { refUser.balance = (refUser.balance||0)+50; refUser.referrals_count = (refUser.referrals_count||0)+1; saveOrUpdateUser(refUser); }
      user.balance = (user.balance||0)+50;
      saveOrUpdateUser(user);
      ctx.reply('Verification successful — referral bonus applied (₦50).');
    } else {
      saveOrUpdateUser(user);
      ctx.reply('✅ Phone verified successfully!');
    }
    delete pendingVerify[tgId];
    return showMainMenu(ctx, user);
  } else {
    return ctx.reply('OTP invalid: ' + (chk.error||'not approved') + `. Attempts: ${session.attempts}/6`);
  }
});

// Scan Waste starter
bot.hears(/Scan Waste/i, ctx => {
  const user = findUserByTelegram(ctx.from.id);
  if (!user || !user.verified) return ctx.reply('You must verify first (/start).');
  waitingForWaste[ctx.from.id] = true;
  return ctx.reply('Send a photo OR type description & weight (e.g. "plastic 2.5") or type "estimate" to request estimation.');
});

// Photo flow: simulated detection
bot.on('photo', async (ctx) => {
  const tgId = ctx.from.id; if (!waitingForWaste[tgId]) return;
  const types = ['Plastic','Metal','Glass','Organic','Paper','E-waste'];
  const wasteType = types[Math.floor(Math.random()*types.length)];
  const kg = Math.round((Math.random()*4 + 0.5) * 10) / 10;
  const meta = read(FILES.meta);
  const amount = Math.round(kg * meta.rate_per_kg * 100)/100;
  const arr = read(FILES.waste); const id = 'W' + Date.now();
  arr.push({ id, user_id: tgId, waste: wasteType, kg, amount, detected: true, status: 'pending', created_at: new Date().toISOString() });
  write(FILES.waste, arr);

  if (kg <= (meta.auto_approve_kg||10)) {
    arr[arr.length-1].status = 'collected'; arr[arr.length-1].collected_at = new Date().toISOString(); write(FILES.waste, arr);
    let user = findUserByTelegram(tgId); user.total_kg = (user.total_kg||0)+kg; user.balance = (user.balance||0)+amount; user.rank = computeRank(user.total_kg); saveOrUpdateUser(user);
    waitingForWaste[tgId] = false; ctx.reply(`Detected ${wasteType} — ${kg}kg. Auto-approved. You earned ${formatN(amount)}. New balance: ${formatN(user.balance)} (Rank: ${user.rank})`);
    try { await bot.telegram.sendMessage(ADMIN_ID, `Auto-approved ${id} from ${tgId}: ${kg}kg — ${formatN(amount)}`); } catch(e) {}
    return;
  }
  waitingForWaste[tgId] = false;
  ctx.reply(`Recorded ${wasteType} — ${kg}kg as pending (ID:${id}). Admin will confirm collection.`);
  try { await bot.telegram.sendMessage(ADMIN_ID, `Pending pickup ${id} from ${tgId}: ${kg}kg — ${formatN(amount)}`); } catch(e) {}
});

// Text handler covers manual waste, withdraw, complaints
bot.on('text', async (ctx, next) => {
  const tgId = ctx.from.id; const txt = ctx.message.text.trim();

  if (waitingForWaste[tgId]) {
    const lowered = txt.toLowerCase();
    if (lowered === 'estimate') {
      const arr = read(FILES.waste); const id = 'W'+Date.now();
      arr.push({ id, user_id: tgId, waste: 'ToEstimate', kg: 0, amount: 0, detected: false, status: 'awaiting_collection', created_at: new Date().toISOString() });
      write(FILES.waste, arr); waitingForWaste[tgId] = false; ctx.reply(`Pickup recorded for estimation. ID: ${id}`);
      try { await bot.telegram.sendMessage(ADMIN_ID, `Estimate pickup ${id} from ${tgId}`); } catch(e) {}
      return;
    }
    const kgMatch = txt.match(/([0-9]+(\.[0-9]+)?)/);
    let kg = kgMatch ? parseFloat(kgMatch[1]) : Math.round((Math.random()*3 + 0.5) * 10)/10;
    const types = ['plastic','metal','glass','organic','paper','e-waste','electronics','ewaste'];
    let wasteType = 'General';
    for (const t of types) if (txt.toLowerCase().includes(t)) { wasteType = t.charAt(0).toUpperCase()+t.slice(1); break; }
    const meta = read(FILES.meta); const amount = Math.round(kg * meta.rate_per_kg * 100)/100;
    const arr = read(FILES.waste); const id = 'W'+Date.now();
    arr.push({ id, user_id: tgId, waste: wasteType, kg, amount, detected: false, status: 'pending', created_at: new Date().toISOString() });
    write(FILES.waste, arr);

    if (kg <= (meta.auto_approve_kg||10)) {
      arr[arr.length-1].status = 'collected'; arr[arr.length-1].collected_at = new Date().toISOString(); write(FILES.waste, arr);
      let user = findUserByTelegram(tgId); user.total_kg = (user.total_kg||0)+kg; user.balance = (user.balance||0)+amount; user.rank = computeRank(user.total_kg); saveOrUpdateUser(user);
      waitingForWaste[tgId] = false; ctx.reply(`Recorded ${wasteType} — ${kg}kg. Auto-approved. You earned ${formatN(amount)}. New balance: ${formatN(user.balance)} (Rank: ${user.rank})`);
      try { await bot.telegram.sendMessage(ADMIN_ID, `Auto-approved ${id} from ${tgId}: ${kg}kg — ${formatN(amount)}`); } catch(e) {}
      return;
    }
    waitingForWaste[tgId] = false; ctx.reply(`Recorded ${wasteType} — ${kg}kg. Pending admin approval. ID: ${id}`);
    return;
  }

  if (waitingForWithdrawBank[tgId]) {
    const parts = txt.split(',');
    if (parts.length < 2) return ctx.reply('Please send bank details as "BankName, AccountNumber"');
    const bank = parts[0].trim(), acct = parts[1].replace(/\s+/g,'').trim();
    const details = waitingForWithdrawBank[tgId]; waitingForWithdrawBank[tgId] = null;
    const arr = read(FILES.withdrawals); const id = 'WD'+Date.now();
    arr.push({ id, user_id: tgId, amount: details.amount, bank, account: acct, status: 'pending', requested_at: new Date().toISOString() });
    write(FILES.withdrawals, arr); ctx.reply(`Withdrawal requested: ${id}. Admin will review.`);
    try { await bot.telegram.sendMessage(ADMIN_ID, `New withdrawal ${id} from ${tgId} for ${formatN(details.amount)} — Bank: ${bank}, Account: ${acct}`); } catch(e) {}
    return;
  }

  if (waitingForComplaint[tgId]) {
    const id = 'C'+Date.now(); const arr = read(FILES.complaints);
    arr.push({ id, user_id: tgId, text: txt, status: 'new', created_at: new Date().toISOString() });
    write(FILES.complaints, arr); waitingForComplaint[tgId] = false; ctx.reply('Complaint recorded. Thank you.');
    try { await bot.telegram.sendMessage(ADMIN_ID, `New complaint ${id} from ${tgId}: ${txt}`); } catch(e) {}
    return;
  }

  return next();
});

// My Earnings
bot.hears(/My Earnings/i, ctx => {
  const u = findUserByTelegram(ctx.from.id); if (!u) return ctx.reply('No profile. Use /start.');
  ctx.reply(`Name: ${u.first_name}\nTotal kg: ${u.total_kg || 0}\nAvailable: ${formatN(u.balance || 0)}\nRate: ${formatN(read(FILES.meta).rate_per_kg || DEFAULT_RATE)}`);
});

// History
bot.hears(/History/i, ctx => {
  const arr = read(FILES.waste).filter(w => w.user_id === ctx.from.id).slice(-20).reverse();
  if (!arr.length) return ctx.reply('No history.');
  const lines = arr.map(a => `${a.id} | ${a.waste} | ${a.kg || 0}kg | ${formatN(a.amount||0)} | ${a.status}`);
  ctx.reply(lines.join('\n'));
});

// Tips
bot.hears(/Tips/i, ctx => ctx.reply('Tip: Rinse and separate recyclables for higher value. Keep organic in separate bag.'));

// Withdraw
bot.hears(/Withdraw/i, ctx => {
  const user = findUserByTelegram(ctx.from.id);
  if (!user || !user.verified) return ctx.reply('You must verify first (/start).');
  const available = Math.max(0, (user.balance || 0));
  if (available <= 0) return ctx.reply('No available balance.');
  waitingForWithdrawBank[ctx.from.id] = { amount: Math.round(available*100)/100 };
  ctx.reply(`You can withdraw ${formatN(available)}. Send bank details as: BankName, AccountNumber`);
});

// File Complaint
bot.hears(/File Complaint/i, ctx => { waitingForComplaint[ctx.from.id] = true; ctx.reply('Type your complaint now (include State/LGA).'); });

// ============ Admin helpers ============
function adminOnly(ctx) {
  const isAdmin = ctx.from.id === ADMIN_ID || (read(FILES.meta).admins || []).includes(ctx.from.id);
  if (!isAdmin) { ctx.reply('Unauthorized — admin only.'); return false; }
  return true;
}

// /setrate <amount>
bot.command('setrate', ctx => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1);
  if (!parts.length) return ctx.reply('Usage: /setrate <amount>');
  const v = parseFloat(parts[0]); if (isNaN(v)) return ctx.reply('Invalid amount');
  const meta = read(FILES.meta); meta.rate_per_kg = v; write(FILES.meta, meta);
  ctx.reply(`Rate set to ${formatN(v)}`);
});

// /users
bot.command('users', ctx => {
  if (!adminOnly(ctx)) return;
  const users = read(FILES.users);
  if (!users.length) return ctx.reply('No users.');
  const lines = users.map(u => `${u.telegram_id} — ${u.first_name||''} — ${u.phone||'no phone'} — ${formatN(u.balance||0)} — kg:${u.total_kg||0}`);
  let txt = lines.join('\n');
  while (txt.length) { ctx.reply(txt.slice(0,4000)); txt = txt.slice(4000); }
});

// /listwaste
bot.command('listwaste', ctx => {
  if (!adminOnly(ctx)) return;
  const arr = read(FILES.waste); if (!arr.length) return ctx.reply('No waste records.');
  const lines = arr.map(a => `${a.id} — user:${a.user_id} — ${a.waste} — ${a.kg || 0}kg — ${formatN(a.amount||0)} — ${a.status||'n/a'}`);
  ctx.reply(lines.join('\n'));
});

// /withdrawals
bot.command('withdrawals', ctx => {
  if (!adminOnly(ctx)) return;
  const arr = read(FILES.withdrawals); if (!arr.length) return ctx.reply('No withdrawals.');
  ctx.reply(arr.map(w => `${w.id} — user:${w.user_id} — ${formatN(w.amount)} — ${w.status}`).join('\n'));
});

// /approve <id>
bot.command('approve', ctx => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1); if (!parts.length) return ctx.reply('Usage: /approve <withdrawal_id>');
  const id = parts[0]; const arr = read(FILES.withdrawals); const i = arr.findIndex(x=>x.id===id); if (i===-1) return ctx.reply('Not found');
  arr[i].status = 'approved'; arr[i].approved_at = new Date().toISOString(); write(FILES.withdrawals, arr);
  const user = findUserByTelegram(arr[i].user_id);
  if (user) { user.balance = Math.max(0, (user.balance||0)-arr[i].amount); saveOrUpdateUser(user); bot.telegram.sendMessage(user.telegram_id, `Your withdrawal ${id} of ${formatN(arr[i].amount)} has been approved.`); }
  ctx.reply('Approved and debited user balance.');
});

// /reject <id>
bot.command('reject', ctx => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1); if (!parts.length) return ctx.reply('Usage: /reject <id>');
  const id = parts[0]; const arr = read(FILES.withdrawals); const i = arr.findIndex(x=>x.id===id); if (i===-1) return ctx.reply('Not found');
  arr[i].status = 'rejected'; arr[i].rejected_at = new Date().toISOString(); write(FILES.withdrawals, arr);
  bot.telegram.sendMessage(arr[i].user_id, `Your withdrawal ${id} has been rejected.`);
  ctx.reply('Rejected.');
});

// /credit <id_or_username> <amount>
bot.command('credit', ctx => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1); if (parts.length<2) return ctx.reply('Usage: /credit <telegram_id_or_username> <amount>');
  let target = parts[0]; const amount = parseFloat(parts[1]); if (isNaN(amount)||amount<=0) return ctx.reply('Invalid amount');
  const users = read(FILES.users); let user = users.find(u=>String(u.telegram_id)===target) || users.find(u=> (u.username||'').toLowerCase()===target.replace('@','').toLowerCase());
  if (!user) return ctx.reply('User not found.');
  user.balance = (user.balance||0)+amount; saveOrUpdateUser(user);
  bot.telegram.sendMessage(user.telegram_id, `Admin credited ${formatN(amount)} to your account. New balance: ${formatN(user.balance)}.`);
  ctx.reply(`Credited ${formatN(amount)} to ${user.telegram_id}`);
});

// /markcollected <waste_id> [actual_kg]
bot.command('markcollected', ctx => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1); if (!parts.length) return ctx.reply('Usage: /markcollected <waste_id> [actual_kg]');
  const id = parts[0]; const arr = read(FILES.waste); const i = arr.findIndex(x=>x.id===id); if (i===-1) return ctx.reply('Not found');
  let actual = arr[i].kg || 0; if (parts[1]) { const p=parseFloat(parts[1]); if(!isNaN(p)) actual=p; }
  arr[i].status = 'collected'; arr[i].actual_kg = actual; arr[i].collected_at = new Date().toISOString(); write(FILES.waste, arr);
  const user = findUserByTelegram(arr[i].user_id); const meta = read(FILES.meta);
  if (user) {
    user.total_kg = (user.total_kg||0)+actual;
    const amt = Math.round(actual * (meta.rate_per_kg||DEFAULT_RATE) *100)/100;
    user.balance = (user.balance||0)+amt; user.rank = computeRank(user.total_kg); saveOrUpdateUser(user);
    bot.telegram.sendMessage(user.telegram_id, `Your pickup ${id} was collected. You earned ${formatN(amt)} (kg:${actual}).`);
  }
  ctx.reply('Marked collected and credited user.');
});

// /setrate
bot.command('setrate', ctx => {
  if (!adminOnly(ctx)) return;
  const p = ctx.message.text.split(' ').slice(1); if (!p[0]) return ctx.reply('Usage: /setrate <amount>');
  const v = parseFloat(p[0]); if (isNaN(v)) return ctx.reply('Invalid');
  const meta = read(FILES.meta); meta.rate_per_kg = v; write(FILES.meta, meta); ctx.reply(`Rate set to ${formatN(v)}`);
});

// /broadcast
bot.command('broadcast', async ctx => {
  if (!adminOnly(ctx)) return; const text = ctx.message.text.split(' ').slice(1).join(' '); if (!text) return ctx.reply('Usage: /broadcast <message>');
  const users = read(FILES.users); let sent=0;
  for (const u of users) { try{ await bot.telegram.sendMessage(u.telegram_id, `📣 Admin: ${text}`); sent++; }catch(e){} }
  ctx.reply(`Broadcast attempted to ${sent} users.`);
});

// /ban /unban
bot.command('ban', ctx => { if (!adminOnly(ctx)) return; const id = Number(ctx.message.text.split(' ').slice(1)[0]); if(!id) return ctx.reply('Usage: /ban <telegram_id>'); const meta = read(FILES.meta); meta.banned = meta.banned||[]; if(!meta.banned.includes(id)) meta.banned.push(id); write(FILES.meta, meta); ctx.reply(`Banned ${id}`); });
bot.command('unban', ctx => { if (!adminOnly(ctx)) return; const id = Number(ctx.message.text.split(' ').slice(1)[0]); if(!id) return ctx.reply('Usage: /unban <telegram_id>'); const meta = read(FILES.meta); meta.banned = (meta.banned||[]).filter(x=>x!==id); write(FILES.meta, meta); ctx.reply(`Unbanned ${id}`); });

// /export send JSON files
bot.command('export', async ctx => {
  if (!adminOnly(ctx)) return;
  try {
    await ctx.reply('Preparing export...');
    await ctx.replyWithDocument({ source: FILES.users });
    await ctx.replyWithDocument({ source: FILES.waste });
    await ctx.replyWithDocument({ source: FILES.withdrawals });
    await ctx.replyWithDocument({ source: FILES.complaints });
    ctx.reply('Export complete.');
  } catch (e) { ctx.reply('Export failed: ' + String(e)); }
});

// /me and /help
bot.command('me', ctx => { const u = findUserByTelegram(ctx.from.id); if (!u) return ctx.reply('No profile. /start'); ctx.reply(`You: ${u.first_name}\nPhone: ${u.phone||'not set'}\nVerified: ${u.verified? 'Yes':'No'}\nBalance: ${formatN(u.balance||0)}\nTotal kg: ${u.total_kg||0}\nRank: ${u.rank}`);});
bot.command('help', ctx => ctx.reply('User commands: Scan Waste, My Earnings, Withdraw, File Complaint, History. Admins have extra commands (/setrate /approve /credit /broadcast /export).'));

// Launch
bot.launch().then(()=>console.log('CleanNaijaBot started — Admin:', ADMIN_ID)).catch(e=>console.error('launch error', e));
process.once('SIGINT', ()=>bot.stop('SIGINT'));
process.once('SIGTERM', ()=>bot.stop('SIGTERM'));
