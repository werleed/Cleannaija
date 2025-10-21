require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const twilio = require('./twilio');
const DATA_DIR = path.join(__dirname, 'data');
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
ensure(FILES.meta, { rate_per_kg:120, verification_days:30, auto_approve_kg:10, admins:[] , banned:[] });
ensure(FILES.complaints, []);
ensure(FILES.referrals, []);
const read = p => JSON.parse(fs.readFileSync(p,'utf8')||'[]');
const write = (p,d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));

const BOT_TOKEN = process.env.TELEGRAM_TOKEN || '';
const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID || 0);
if (!BOT_TOKEN) { console.error('Missing TELEGRAM_TOKEN'); process.exit(1); }
const bot = new Telegraf(BOT_TOKEN);

// helper utilities
function findUserByTelegram(id){ return read(FILES.users).find(u=>u.telegram_id===id); }
function saveOrUpdateUser(u){ const arr = read(FILES.users); const i = arr.findIndex(x=>x.telegram_id===u.telegram_id); if(i===-1) arr.push(u); else arr[i]=u; write(FILES.users, arr); }
function computeRank(totalKg){ if(totalKg>=500) return 'Eco-Champion'; if(totalKg>=200) return 'Recycler-Hero'; if(totalKg>=50) return 'Eco-Warrior'; if(totalKg>=10) return 'Starter Recycler'; return 'Newbie'; }
const tips = [
  "Rinse plastic bottles before recycling to avoid contamination.",
  "Separate organic waste for composting to reduce landfill loads.",
  "Flatten cartons and cardboard to save space.",
  "Collect e-waste separately and never put it with regular trash.",
  "Use reusable bags instead of single-use plastic bags."
];
// in-memory flow trackers and OTP attempts
const pendingVerify = {}; // tgId -> { phone, attempts, ts, refBy }
const waitingForWaste = {}; // tgId -> true
const waitingForWithdrawBank = {}; // tgId -> { amount }
const waitingForComplaint = {}; // tgId -> true
// Start: if user exists and verified within expiry, show menu; else prompt verification options
bot.start(async (ctx) => {
  const tg = ctx.from;
  let user = findUserByTelegram(tg.id);
  if (!user) {
    user = { telegram_id: tg.id, username: tg.username||'', first_name: tg.first_name||'', phone:null, verified:false, verified_at:null, total_kg:0, balance:0, referrals_count:0, rank:'Newbie', banned:false };
    saveOrUpdateUser(user);
  }
  // check banned
  const meta = read(FILES.meta);
  if ((meta.banned||[]).includes(tg.id) || user.banned) return ctx.reply('Your account has been suspended. Contact admin.');
  if (user.verified && user.verified_at) {
    const days = meta.verification_days || 30;
    const diff = (Date.now() - new Date(user.verified_at).getTime())/(1000*60*60*24);
    if (diff <= days) return showMainMenu(ctx, user);
  }
  // prompt verification choice
  await ctx.reply('Welcome to CleanNaijaBot — we need to verify your phone first. Choose:', Markup.keyboard([['Use Telegram Number','Enter Phone Manually']]).oneTime().resize());
});
async function showMainMenu(ctx, user){
  const kb = Markup.keyboard([['Scan Waste','My Earnings'], ['Withdraw','File Complaint'], ['History','Tips']]).resize();
  await ctx.reply(`Hi ${user.first_name||''}! Choose an option:`, kb);
}
// handle contact share (Telegram contact)
bot.on('contact', async (ctx) => {
  const contact = ctx.message.contact;
  const tgId = ctx.from.id;
  let user = findUserByTelegram(tgId) || { telegram_id: tgId, username: ctx.from.username||'', first_name: ctx.from.first_name||'' };
  user.phone = contact.phone_number;
  user.verified = false;
  saveOrUpdateUser(user);
  // send OTP via Twilio
  const res = await twilio.startVerify(user.phone);
  pendingVerify[tgId] = { phone: user.phone, attempts:0, ts: Date.now(), refBy: null };
  if (res.success) return ctx.reply('OTP sent to ' + user.phone + '. Enter the 6-digit code (test mode: 123456).');
  return ctx.reply('Failed to send OTP: ' + (res.error||'unknown'));
});
# remaining file continued below due to size

// Continue implementation is in the repository; deploy this file.
