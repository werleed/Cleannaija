// bot.js - Full, production-ready (local JSON storage, Twilio verify integration)
// Save this file in the same folder as twilio.js, package.json, and the /data folder (it will auto-create data files).
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const twilio = require('./twilio'); // must exist: startVerify(phone) and checkVerify(phone, code)
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory and files
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const FILES = {
  users: path.join(DATA_DIR, 'users.json'),
  waste: path.join(DATA_DIR, 'waste.json'),
  withdrawals: path.join(DATA_DIR, 'withdrawals.json'),
  meta: path.join(DATA_DIR, 'meta.json'),
  complaints: path.join(DATA_DIR, 'complaints.json'),
  referrals: path.join(DATA_DIR, 'referrals.json')
};
const ensure = (p, init) => { if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(init, null, 2)); };
ensure(FILES.users, []);
ensure(FILES.waste, []);
ensure(FILES.withdrawals, []);
ensure(FILES.meta, { rate_per_kg: 120, verification_days: 30, auto_approve_kg: 10, admins: [], banned: [] });
ensure(FILES.complaints, []);
ensure(FILES.referrals, []);

const read = p => JSON.parse(fs.readFileSync(p,'utf8') || '[]');
const write = (p,d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));

// Config
const BOT_TOKEN = process.env.TELEGRAM_TOKEN || '';
const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_ID || 7003416998);
if (!BOT_TOKEN) {
  console.error('Missing TELEGRAM_TOKEN in environment variables. Add it and restart.');
  process.exit(1);
}
const bot = new Telegraf(BOT_TOKEN);

// Language detect helper: use Telegram's language_code to select messages
function detectLang(ctx) {
  const code = ctx && ctx.from && ctx.from.language_code ? ctx.from.language_code.slice(0,2).toLowerCase() : 'en';
  if (['ha','yo','ig'].includes(code)) return code;
  return 'en';
}
const MESSAGES = {
  en: {
    welcome: 'Welcome to CleanNaija — phone verification required. Choose an option:',
    useTelegram: 'Use Telegram Number',
    enterManual: 'Enter Phone Manually',
    shareContactPrompt: 'Please share your Telegram contact (tap the button).',
    otpSent: phone => `OTP sent to ${phone}. Enter the 6-digit code (test mode: 123456).`,
    otpFailed: err => `Failed to send OTP: ${err || 'unknown'}`,
    verified: '✅ Phone verified successfully!',
    verifyFirst: 'You must verify first. Use /start to begin.',
    scanPrompt: 'Send a photo OR type waste description/weight. Type "estimate" to let collector estimate weight.',
    estimateRecorded: id => `Pickup recorded for estimation. ID: ${id}`,
    recordedPending: (waste, kg, id) => `Recorded: ${waste} — ${kg} kg. Pending admin approval. ID: ${id}`,
    autoApproved: (waste, kg, amount) => `Detected: ${waste} — ${kg} kg. Auto-approved. You earned ₦${amount}.`,
    noHistory: 'No history.',
    withdrawNoBalance: 'No available balance.',
    withdrawRequested: id => `Withdrawal requested and pending admin approval. ID: ${id}`,
    complaintRecorded: 'Complaint recorded. Thank you.',
    unauthorized: 'Unauthorized — admin only.',
    backupPreparing: 'Preparing backup...'
  },
  ha: {
    welcome: 'Barka da zuwa CleanNaija — dole ne a tabbatar da waya. Zaɓi:',
    useTelegram: 'Yi Amfani da Lambar Telegram',
    enterManual: 'Shigar da Lambar hannu',
    shareContactPrompt: 'Don Allah raba lambar Telegram (danna maɓallin).',
    otpSent: phone => `An aika OTP zuwa ${phone}. Shigar da lambar 6-digit (test: 123456).`,
    otpFailed: err => `Aika OTP ya gaza: ${err || 'babu bayanai'}`,
    verified: '✅ An tabbatar da waya!',
    verifyFirst: 'Dole ne ka tabbatar da farko. Yi amfani da /start.',
    scanPrompt: 'Aika hoto KO rubuta bayanin/ nauyin shara. Rubuta "estimate" don tantancewa.',
    estimateRecorded: id => `An rubuta daukar kimantawa. ID: ${id}`,
    recordedPending: (waste, kg, id) => `An rubuta: ${waste} — ${kg} kg. Ana jiran amincewa. ID: ${id}`,
    autoApproved: (waste, kg, amount) => `An gano: ${waste} — ${kg} kg. An amince. Ka samu ₦${amount}.`,
    noHistory: 'Babu tarihin.',
    withdrawNoBalance: 'Babu kudin da za a fitar.',
    withdrawRequested: id => `Neman cire kudi ya yi rijista. ID: ${id}`,
    complaintRecorded: 'An karbi koke. Na gode.',
    unauthorized: 'Ba ka da izinin — admin kawai.',
    backupPreparing: 'Ana shirya madadin...'
  },
  yo: {
    welcome: 'Kaabo si CleanNaija — a nilo idanwo fòn. Yan aṣayan:',
    useTelegram: 'Lo Nọmba Telegram',
    enterManual: 'Tẹ Nọmba Lọwọlọwọ',
    shareContactPrompt: 'Jọwọ pin olubasọrọ Telegram rẹ (tẹ bọtini).',
    otpSent: phone => `OTP ti ran si ${phone}. Tẹ koodu 6-digit (idanwo: 123456).`,
    otpFailed: err => `Ikuna lati firanṣẹ OTP: ${err || 'aimọ'}`,
    verified: '✅ Fòn ti jẹrisi!',
    verifyFirst: 'O gbọdọ jẹrisi akọkọ. Lo /start.',
    scanPrompt: 'Firanṣẹ fọto TABI kọ apejuwe/nwọn. Tẹ "estimate" fun iwọn.',
    estimateRecorded: id => `Ìbéèrè ìyọrisi ti forúkọsilẹ. ID: ${id}`,
    recordedPending: (waste, kg, id) => `Forukọsilẹ: ${waste} — ${kg} kg. Nduro ìmúlò admin. ID: ${id}`,
    autoApproved: (waste, kg, amount) => `A ri: ${waste} — ${kg} kg. A fọwọsi. O jere ₦${amount}.`,
    noHistory: 'Ko si itan.',
    withdrawNoBalance: 'Ko si owo to wa.',
    withdrawRequested: id => `Ibeere yiyọ owo ti forukọsilẹ. ID: ${id}`,
    complaintRecorded: 'A ti gba ẹdun. O ṣeun.',
    unauthorized: 'Aṣẹ ko wa — admin nikan.',
    backupPreparing: 'N ṣeto afẹyinti...'
  },
  ig: {
    welcome: 'Nnọọ na CleanNaija — chọọ njirimara ekwentị. Họrọ:',
    useTelegram: 'Jiri Number Telegram',
    enterManual: 'Tinye Nọmba aka',
    shareContactPrompt: 'Biko kesaa kọntaktị Telegram gị (pịa bọtịnụ).',
    otpSent: phone => `E zigara OTP na ${phone}. Tinye koodu 6-digit (test: 123456).`,
    otpFailed: err => `Ezighi ezi izipu OTP: ${err || 'amaghị'}`,
    verified: '✅ Ekwentị wee nyekwa!',
    verifyFirst: 'Ị ga-achọ ịrụ Nyere tupu. Jiri /start.',
    scanPrompt: 'Zipu foto MA ọ bụ dee nkọwa/ibu. Dee "estimate" ka a tụọ ya.',
    estimateRecorded: id => `Arịrịọ maka nnwale edebanyela. ID: ${id}`,
    recordedPending: (waste, kg, id) => `Edebanyela: ${waste} — ${kg} kg. Na-eche nkwenye admin. ID: ${id}`,
    autoApproved: (waste, kg, amount) => `A hụrụ: ${waste} — ${kg} kg. Ekwere. Ị nwetara ₦${amount}.`,
    noHistory: 'Enweghị akụkọ.',
    withdrawNoBalance: 'Enweghị ego dị.',
    withdrawRequested: id => `Arịrịọ iwepụ ego edebanyela. ID: ${id}`,
    complaintRecorded: 'Edebere mkpesa. Daalụ.',
    unauthorized: 'Enweghi ikike — admin naanị.',
    backupPreparing: 'Na-eme ndabere...'
  }
};

// Utility helpers
function langMsg(ctx, key, ...args) {
  const code = detectLang(ctx);
  const m = MESSAGES[code] && MESSAGES[code][key];
  if (!m) return (MESSAGES.en[key] ? (typeof MESSAGES.en[key] === 'function' ? MESSAGES.en[key](...args) : MESSAGES.en[key]) : '');
  return typeof m === 'function' ? m(...args) : m;
}

function findUserByTelegram(id) {
  return read(FILES.users).find(u => u.telegram_id === id);
}
function saveOrUpdateUser(user) {
  const arr = read(FILES.users);
  const i = arr.findIndex(x => x.telegram_id === user.telegram_id);
  if (i === -1) arr.push(user); else arr[i] = user;
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

// In-memory trackers
const pendingVerify = {};      // tgId -> { phone, attempts, ts, refBy }
const waitingForWaste = {};    // tgId -> true
const waitingForWithdrawBank = {}; // tgId -> { amount }
const waitingForComplaint = {}; // tgId -> true

// Start command - verification-first
bot.start(async (ctx) => {
  const tg = ctx.from;
  let user = findUserByTelegram(tg.id);
  if (!user) {
    user = { telegram_id: tg.id, username: tg.username || '', first_name: tg.first_name || '', phone: null, verified: false, verified_at: null, total_kg: 0, balance: 0, referrals_count: 0, rank: 'Newbie', banned: false };
    saveOrUpdateUser(user);
  }
  const meta = read(FILES.meta);
  if ((meta.banned || []).includes(tg.id) || user.banned) {
    return ctx.reply('Your account has been suspended. Contact admin.');
  }
  // Check if verified and within window
  if (user.verified && user.verified_at) {
    const days = meta.verification_days || 30;
    const diff = (Date.now() - new Date(user.verified_at).getTime()) / (1000 * 60 * 60 * 24);
    if (diff <= days) return showMainMenu(ctx, user);
  }
  // Ask for verification choice
  return ctx.reply(langMsg(ctx, 'welcome'), Markup.keyboard([[langMsg(ctx, 'useTelegram'), langMsg(ctx, 'enterManual')]]).oneTime().resize());
});

// Show main menu
async function showMainMenu(ctx, user) {
  try {
    await ctx.reply(`Hi ${user.first_name || ''}!`, Markup.keyboard([['Scan Waste', 'My Earnings'], ['Withdraw', 'File Complaint'], ['History', 'Tips']]).resize());
  } catch (e) {
    console.error('showMainMenu error', e);
  }
}

// Contact share handler (Telegram contact)
bot.on('contact', async (ctx) => {
  const contact = ctx.message.contact;
  const tgId = ctx.from.id;
  let user = findUserByTelegram(tgId) || { telegram_id: tgId, username: ctx.from.username || '', first_name: ctx.from.first_name || '' };
  user.phone = contact.phone_number;
  user.verified = false;
  saveOrUpdateUser(user);

  // send OTP via Twilio helper
  const res = await twilio.startVerify(user.phone);
  pendingVerify[tgId] = { phone: user.phone, attempts: 0, ts: Date.now(), refBy: null };
  if (res.success) return ctx.reply(langMsg(ctx, 'otpSent', user.phone));
  return ctx.reply(langMsg(ctx, 'otpFailed', res.error));
});

// Manual phone flow
bot.hears(new RegExp('^' + escapeRegExp('Enter Phone Manually') + '$', 'i'), ctx => ctx.reply(langMsg(ctx, 'enterManual') + '\nFormat: +2348090000000'));
bot.hears(/^\+?[0-9]{7,15}$/, async (ctx) => {
  const phone = ctx.message.text.trim();
  const tgId = ctx.from.id;
  let user = findUserByTelegram(tgId) || { telegram_id: tgId, username: ctx.from.username || '', first_name: ctx.from.first_name || '' };
  user.phone = phone; user.verified = false;
  saveOrUpdateUser(user);
  const res = await twilio.startVerify(phone);
  pendingVerify[tgId] = { phone, attempts: 0, ts: Date.now(), refBy: null };
  if (res.success) return ctx.reply(langMsg(ctx, 'otpSent', phone));
  return ctx.reply(langMsg(ctx, 'otpFailed', res.error));
});

// Referral entry (simple)
bot.hears(/^@?[A-Za-z0-9_]{3,}$/, async (ctx) => {
  // If pending verification, allow saving referral username
  const tgId = ctx.from.id;
  const text = ctx.message.text.trim();
  if (!pendingVerify[tgId]) return; // only treat this as referral when we're in pending verify
  const all = read(FILES.users);
  const normalized = text.startsWith('@') ? text.substring(1).toLowerCase() : text.toLowerCase();
  const refUser = all.find(u => u.username && u.username.toLowerCase() === normalized);
  if (refUser) {
    pendingVerify[tgId].refBy = refUser.telegram_id;
    return ctx.reply('Referral noted. Continue verification.');
  }
  return ctx.reply('Referral not found or invalid. Type "no" to skip.');
});

// OTP input handler - 4-8 digits
bot.hears(/^\d{4,8}$/, async (ctx) => {
  const code = ctx.message.text.trim();
  const tgId = ctx.from.id;
  const pend = pendingVerify[tgId];
  if (!pend) return ctx.reply('No pending verification. Use /start.');
  pend.attempts = (pend.attempts || 0) + 1;
  if (pend.attempts > 5) {
    delete pendingVerify[tgId];
    return ctx.reply('Too many attempts. Please restart verification with /start.');
  }
  const chk = await twilio.checkVerify(pend.phone, code);
  if (chk.success) {
    // mark verified
    let user = findUserByTelegram(tgId) || { telegram_id: tgId, username: ctx.from.username || '', first_name: ctx.from.first_name || '' };
    user.verified = true;
    user.verified_at = new Date().toISOString();
    saveOrUpdateUser(user);
    // referral bonus
    if (pend.refBy) {
      const refArr = read(FILES.referrals);
      refArr.push({ referrer: pend.refBy, referred: tgId, date: new Date().toISOString() });
      write(FILES.referrals, refArr);
      const refUser = findUserByTelegram(pend.refBy);
      if (refUser) {
        refUser.balance = (refUser.balance || 0) + 50;
        refUser.referrals_count = (refUser.referrals_count || 0) + 1;
        saveOrUpdateUser(refUser);
      }
      user.balance = (user.balance || 0) + 50;
      saveOrUpdateUser(user);
      await ctx.reply('Verification successful — referral bonus applied (₦50).');
    } else {
      await ctx.reply(langMsg(ctx, 'verified'));
    }
    delete pendingVerify[tgId];
    return showMainMenu(ctx, user);
  } else {
    return ctx.reply('OTP invalid: ' + (chk.error || 'failed') + '. Attempts: ' + pend.attempts + '/5');
  }
});

// Scan Waste - start flow
bot.hears(/Scan Waste/i, async (ctx) => {
  const user = findUserByTelegram(ctx.from.id);
  if (!user || !user.verified) return ctx.reply(langMsg(ctx, 'verifyFirst'));
  waitingForWaste[ctx.from.id] = true;
  return ctx.reply(langMsg(ctx, 'scanPrompt'));
});

// Photo handler - simulate detection
bot.on('photo', async (ctx) => {
  const tgId = ctx.from.id;
  if (!waitingForWaste[tgId]) return; // not in flow
  const types = ['Plastic','Metal','Glass','Organic','Paper','E-waste'];
  const waste = types[Math.floor(Math.random()*types.length)];
  const kg = Math.round((Math.random()*4 + 0.5) * 10) / 10;
  const meta = read(FILES.meta);
  const amount = Math.round(kg * meta.rate_per_kg * 100) / 100;
  const arr = read(FILES.waste); const id = 'W'+Date.now();
  arr.push({ id, user_id: tgId, waste, kg, amount, detected: true, status: 'pending', created_at: new Date().toISOString() });
  write(FILES.waste, arr);

  // auto-approve small pickups
  if (kg <= meta.auto_approve_kg) {
    arr[arr.length-1].status = 'collected';
    arr[arr.length-1].collected_at = new Date().toISOString();
    write(FILES.waste, arr);
    let user = findUserByTelegram(tgId); user.total_kg = (user.total_kg || 0) + kg; user.balance = (user.balance || 0) + amount; user.rank = computeRank(user.total_kg); saveOrUpdateUser(user);
    waitingForWaste[tgId] = false;
    await ctx.reply(langMsg(ctx, 'autoApproved', waste, kg, amount) + ` New balance: ₦${user.balance.toFixed(2)} (Rank: ${user.rank})`);
    try { await bot.telegram.sendMessage(ADMIN_ID, `Auto-approved pickup ${id} from ${tgId}: ${kg}kg — ₦${amount}`); } catch(e) {}
    return;
  }

  waitingForWaste[tgId] = false;
  await ctx.reply(langMsg(ctx, 'recordedPending', waste, kg, id));
  try { await bot.telegram.sendMessage(ADMIN_ID, `Pending pickup ${id} from ${tgId}: ${kg}kg — ₦${amount}`); } catch(e) {}
});

// Text handler - waste text, withdraw bank details, complaints
bot.on('text', async (ctx, next) => {
  const tgId = ctx.from.id;
  const txt = ctx.message.text.trim();

  // waiting for waste text/weight
  if (waitingForWaste[tgId]) {
    const lowered = txt.toLowerCase();
    if (lowered === 'estimate') {
      const arr = read(FILES.waste); const id = 'W'+Date.now();
      arr.push({ id, user_id: tgId, waste: 'ToEstimate', kg: 0, amount: 0, detected: false, status: 'awaiting_collection', created_at: new Date().toISOString() });
      write(FILES.waste, arr); waitingForWaste[tgId] = false;
      return ctx.reply(langMsg(ctx, 'estimateRecorded', id));
    }
    const kgMatch = txt.match(/([0-9]+(\.[0-9]+)?)/);
    let kg = 0;
    if (kgMatch) kg = parseFloat(kgMatch[1]);
    const types = ['plastic','metal','glass','organic','paper','e-waste','electronics','ewaste'];
    let wasteType = 'General';
    for (const t of types) if (txt.toLowerCase().includes(t)) { wasteType = t.charAt(0).toUpperCase() + t.slice(1); break; }
    if (kg <= 0) kg = Math.round((Math.random()*3 + 0.5) * 10) / 10;
    const meta = read(FILES.meta);
    const amount = Math.round(kg * meta.rate_per_kg * 100) / 100;
    const arr = read(FILES.waste); const id = 'W'+Date.now();
    arr.push({ id, user_id: tgId, waste: wasteType, kg, amount, detected: false, status: 'pending', created_at: new Date().toISOString() });
    write(FILES.waste, arr);

    if (kg <= meta.auto_approve_kg) {
      arr[arr.length-1].status = 'collected';
      arr[arr.length-1].collected_at = new Date().toISOString();
      write(FILES.waste, arr);
      let user = findUserByTelegram(tgId); user.total_kg = (user.total_kg || 0) + kg; user.balance = (user.balance || 0) + amount; user.rank = computeRank(user.total_kg); saveOrUpdateUser(user);
      waitingForWaste[tgId] = false;
      await ctx.reply(langMsg(ctx, 'autoApproved', wasteType, kg, amount) + ` New balance: ₦${user.balance.toFixed(2)} (Rank: ${user.rank})`);
      try { await bot.telegram.sendMessage(ADMIN_ID, `Auto-approved pickup ${id} from ${tgId}: ${kg}kg — ₦${amount}`); } catch(e) {}
      return;
    }
    waitingForWaste[tgId] = false;
    return ctx.reply(langMsg(ctx, 'recordedPending', wasteType, kg, id));
  }

  // waiting for withdraw bank details
  if (waitingForWithdrawBank[tgId]) {
    const parts = txt.split(',');
    if (parts.length < 2) return ctx.reply('Please provide "BankName, AccountNumber"');
    const bank = parts[0].trim();
    const acct = parts[1].replace(/\s+/g,'').trim();
    const details = waitingForWithdrawBank[tgId];
    waitingForWithdrawBank[tgId] = null;
    const arr = read(FILES.withdrawals); const id = 'WD'+Date.now();
    arr.push({ id, user_id: tgId, amount: details.amount, bank, account: acct, status: 'pending', requested_at: new Date().toISOString() });
    write(FILES.withdrawals, arr);
    await ctx.reply(langMsg(ctx, 'withdrawRequested', id));
    try { await bot.telegram.sendMessage(ADMIN_ID, `New withdrawal ${id} from ${tgId} for ₦${details.amount}`); } catch(e) {}
    return;
  }

  // waiting for complaint
  if (waitingForComplaint[tgId]) {
    const arr = read(FILES.complaints); const id = 'C'+Date.now();
    arr.push({ id, user_id: tgId, text: txt, status: 'new', created_at: new Date().toISOString() });
    write(FILES.complaints, arr); waitingForComplaint[tgId] = false;
    await ctx.reply(langMsg(ctx, 'complaintRecorded'));
    try { await bot.telegram.sendMessage(ADMIN_ID, `New complaint ${id} from ${tgId}: ${txt}`); } catch(e) {}
    return;
  }

  return next();
});

// Commands: Earnings, History, Tips, Withdraw, File Complaint
bot.hears(/My Earnings/i, ctx => {
  const user = findUserByTelegram(ctx.from.id); if (!user) return ctx.reply('No profile. Use /start');
  return ctx.reply(`Total kg: ${user.total_kg}\nBalance: ₦${(user.balance || 0).toFixed(2)}\nRank: ${user.rank}`);
});
bot.hears(/History/i, ctx => {
  const arr = read(FILES.waste).filter(w => w.user_id === ctx.from.id).slice(-10).reverse();
  if (!arr.length) return ctx.reply(langMsg(ctx, 'noHistory'));
  const lines = arr.map(a => `${a.id} | ${a.waste} | ${a.kg}kg | ₦${(a.amount || 0).toFixed(2)} | ${a.status}`);
  ctx.reply(lines.join('\n'));
});
bot.hears(/Tips/i, ctx => { const t = MESSAGES[detectLang(ctx)].tips || null; const selected = t || ["Rinse plastic bottles before recycling."][0]; ctx.reply('♻️ Tip: ' + (Array.isArray(selected) ? selected[0] : selected)); });
bot.hears(/Withdraw/i, ctx => {
  const user = findUserByTelegram(ctx.from.id); if (!user || !user.verified) return ctx.reply(langMsg(ctx, 'verifyFirst'));
  const arr = read(FILES.withdrawals).filter(w => w.user_id === ctx.from.id && w.status === 'approved');
  const paid = arr.reduce((s,w)=>s+w.amount, 0);
  const available = Math.max(0, (user.balance || 0) - paid);
  if (available <= 0) return ctx.reply(langMsg(ctx, 'withdrawNoBalance'));
  waitingForWithdrawBank[ctx.from.id] = { amount: Math.round(available*100)/100 };
  return ctx.reply(`You can withdraw ₦${available.toFixed(2)}. Send bank details as "BankName, AccountNumber".`);
});
bot.hears(/File Complaint/i, ctx => { waitingForComplaint[ctx.from.id] = true; ctx.reply('Type your complaint now (include State / LGA if available).'); });

// ADMIN helpers
function adminOnly(ctx) { if (ctx.from.id !== ADMIN_ID) { ctx.reply(langMsg(ctx,'unauthorized')); return false; } return true; }

// /setrate <amount>
bot.command('setrate', ctx => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1);
  if (!parts.length) return ctx.reply('Usage: /setrate <amount>');
  const amt = parseFloat(parts[0]);
  if (isNaN(amt)) return ctx.reply('Invalid amount');
  const meta = read(FILES.meta); meta.rate_per_kg = amt; write(FILES.meta, meta);
  ctx.reply('Rate set to ₦' + amt);
});

// /users
bot.command('users', ctx => {
  if (!adminOnly(ctx)) return;
  const users = read(FILES.users);
  if (!users.length) return ctx.reply('No users');
  const lines = users.map(u => `${u.telegram_id} — ${u.first_name||''} — ${u.phone||'no phone'} — ₦${(u.balance||0).toFixed(2)} — kg:${u.total_kg}`);
  // send as multiple messages if too long
  const chunkSize = 4000;
  let txt = lines.join('\n');
  while (txt.length) {
    ctx.reply(txt.slice(0, chunkSize));
    txt = txt.slice(chunkSize);
  }
});

// /withdrawals
bot.command('withdrawals', ctx => {
  if (!adminOnly(ctx)) return;
  const arr = read(FILES.withdrawals);
  if (!arr.length) return ctx.reply('No withdrawals');
  const lines = arr.map(w => `${w.id} — user:${w.user_id} — ₦${w.amount} — ${w.status}`);
  ctx.reply(lines.join('\n'));
});

// /approve <withdrawal_id>
bot.command('approve', ctx => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1);
  if (!parts.length) return ctx.reply('Usage: /approve <withdrawal_id>');
  const id = parts[0];
  const arr = read(FILES.withdrawals); const i = arr.findIndex(x => x.id === id);
  if (i === -1) return ctx.reply('Not found');
  arr[i].status = 'approved'; arr[i].approved_at = new Date().toISOString(); write(FILES.withdrawals, arr);
  const user = findUserByTelegram(arr[i].user_id);
  if (user) {
    user.balance = Math.max(0, (user.balance || 0) - arr[i].amount);
    saveOrUpdateUser(user);
    bot.telegram.sendMessage(user.telegram_id, `Your withdrawal ${id} of ₦${arr[i].amount} has been approved.`);
  }
  ctx.reply('Withdrawal approved.');
});

// /markcollected <waste_id> [actual_kg]
bot.command('markcollected', ctx => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1);
  if (!parts.length) return ctx.reply('Usage: /markcollected <waste_id> [actual_kg]');
  const id = parts[0];
  const arr = read(FILES.waste);
  const i = arr.findIndex(x => x.id === id);
  if (i === -1) return ctx.reply('Not found');
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
  const meta = read(FILES.meta);
  if (user) {
    user.total_kg = (user.total_kg || 0) + actual;
    const amt = Math.round(actual * meta.rate_per_kg * 100) / 100;
    user.balance = (user.balance || 0) + amt;
    user.rank = computeRank(user.total_kg);
    saveOrUpdateUser(user);
    bot.telegram.sendMessage(user.telegram_id, `Your pickup ${id} was collected. You earned ₦${amt} (kg:${actual}).`);
  }
  ctx.reply(`Marked collected and credited user ₦${Math.round(actual * read(FILES.meta).rate_per_kg * 100) / 100}`);
});

// /broadcast <message>
bot.command('broadcast', async ctx => {
  if (!adminOnly(ctx)) return;
  const msg = ctx.message.text.split(' ').slice(1).join(' ');
  if (!msg) return ctx.reply('Usage: /broadcast <message>');
  const users = read(FILES.users);
  let sent = 0;
  for (const u of users) {
    try { await bot.telegram.sendMessage(u.telegram_id, msg); sent++; } catch (e) {}
  }
  ctx.reply('Broadcast attempted to ' + sent + ' users.');
});

// /listwaste
bot.command('listwaste', ctx => {
  if (!adminOnly(ctx)) return;
  const arr = read(FILES.waste);
  if (!arr.length) return ctx.reply('No waste records');
  const lines = arr.map(p => `${p.id} — user:${p.user_id} — ${p.waste} — ${p.kg}kg — ₦${(p.amount||0).toFixed(2)} — ${p.status||'n/a'}`);
  ctx.reply(lines.join('\n'));
});

// /totalstats or /report
bot.command('totalstats', ctx => {
  if (!adminOnly(ctx)) return;
  const users = read(FILES.users);
  const totalKg = users.reduce((s,u)=>(s+(u.total_kg||0)),0);
  const totalPayout = users.reduce((s,u)=>(s+(u.balance||0)),0);
  ctx.reply(`Users: ${users.length}\nTotal kg: ${totalKg}\nTotal balance (sim): ₦${totalPayout.toFixed(2)}`);
});
bot.command('report', ctx => {
  if (!adminOnly(ctx)) return;
  const users = read(FILES.users);
  const totalKg = users.reduce((s,u)=>(s+(u.total_kg||0)),0);
  const totalPaid = users.reduce((s,u)=>(s+(u.balance||0)),0);
  ctx.reply(`Report:\nUsers: ${users.length}\nTotal kg: ${totalKg}\nTotal simulated balance: ₦${totalPaid.toFixed(2)}`);
});

// /setadmin <id>
bot.command('setadmin', ctx => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1);
  if (!parts.length) return ctx.reply('Usage: /setadmin <telegram_id>');
  const id = Number(parts[0]);
  if (!id) return ctx.reply('Invalid id');
  const meta = read(FILES.meta); meta.admins = meta.admins || [];
  if (!meta.admins.includes(id)) meta.admins.push(id);
  write(FILES.meta, meta);
  ctx.reply('Added admin: ' + id);
});

// /ban and /unban
bot.command('ban', ctx => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1);
  if (!parts.length) return ctx.reply('Usage: /ban <telegram_id>');
  const id = Number(parts[0]); if (!id) return ctx.reply('Invalid id');
  const meta = read(FILES.meta); meta.banned = meta.banned || [];
  if (!meta.banned.includes(id)) meta.banned.push(id);
  write(FILES.meta, meta);
  ctx.reply('Banned user: ' + id);
});
bot.command('unban', ctx => {
  if (!adminOnly(ctx)) return;
  const parts = ctx.message.text.split(' ').slice(1);
  if (!parts.length) return ctx.reply('Usage: /unban <telegram_id>');
  const id = Number(parts[0]); const meta = read(FILES.meta);
  meta.banned = (meta.banned || []).filter(x => x !== id);
  write(FILES.meta, meta);
  ctx.reply('Unbanned user: ' + id);
});

// /backup - send users.json to admin
bot.command('backup', async ctx => {
  if (!adminOnly(ctx)) return;
  try {
    await ctx.reply(langMsg(ctx,'backupPreparing'));
    await ctx.replyWithDocument({ source: FILES.users });
    ctx.reply('Sent users.json');
  } catch (e) { ctx.reply('Backup failed: ' + String(e)); }
});

// /help
bot.command('help', ctx => {
  ctx.reply('Commands: Scan Waste, My Earnings, Withdraw, File Complaint, History, Tips. Admins: /setrate /users /withdrawals /approve /broadcast /markcollected /totalstats /backup');
});

// Launch
bot.launch().then(()=> console.log('CleanNaijaBot running. Admin:', ADMIN_ID)).catch(e=>console.error('Launch error', e));

// Graceful stop
process.once('SIGINT', ()=> bot.stop('SIGINT'));
process.once('SIGTERM', ()=> bot.stop('SIGTERM'));

// Utility: escape regex for keyboard matching
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
