require('dotenv').config();
const fs = require('fs');
const fsExtra = require('fs-extra');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const twilio = require('twilio');
const axios = require('axios');

// --- Config ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID ? parseInt(process.env.ADMIN_TELEGRAM_ID, 10) : null;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID;
const PORT = process.env.PORT || 8080;

if (!TELEGRAM_TOKEN) {
  console.error('FATAL: TELEGRAM_TOKEN or BOT_TOKEN missing. Set it in Railway environment variables.');
  process.exit(1);
}

// --- Data dirs ---
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fsExtra.ensureDirSync(DATA_DIR);
fsExtra.ensureDirSync(UPLOADS_DIR);

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');
if (!fs.existsSync(SETTINGS_FILE)) {
  const defaults = { verification_enabled: true, withdrawals_enabled: true, language_default: 'en' };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaults, null, 2), 'utf8');
}

// --- Helpers ---
const loadJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8') || 'null') || {}; } catch (e) { return {}; } };
const saveJSON = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
const loadUsers = () => { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '[]'); } catch (e) { return []; } };
const saveUsers = (a) => fs.writeFileSync(USERS_FILE, JSON.stringify(a, null, 2), 'utf8');

// --- Twilio init (optional) ---
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  try { twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN); }
  catch (e) { console.warn('Twilio init failed:', e.message || e); twilioClient = null; }
}

// --- Telegram bot (polling) ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on('polling_error', (err) => {
  console.error('Polling error:', err && err.code ? `${err.code} ${err.message}` : err);
  // If token is invalid, exit so process manager / Railway shows error and you can fix env var.
  if (err && err.code === 'ETELEGRAM' && err.message && err.message.includes('401')) {
    console.error('Unauthorized: TELEGRAM_TOKEN invalid. Exiting.');
    process.exit(1);
  }
  // If conflict (409), probably multiple bot instances; log and exit so you can stop duplicate instance.
  if (err && err.code === 'ETELEGRAM' && err.message && err.message.includes('409')) {
    console.error('Conflict: another getUpdates running. Exiting.');
    process.exit(1);
  }
});

console.log('🤖 Bot started successfully (POLLING mode)...');

// --- Messages (multi-language) ---
const MESSAGES = { /* keep the mapping from your earlier version for en, fr, ha, yo, ak */ };
// For brevity: simple english-only messages if not defined. You can paste your MESSAGES object in here.
// If you want the full translations included automatically, copy your earlier MESSAGES constant into this file.

// --- Minimal message helper (English fallback) ---
const messageSimple = (key, user, ...args) => {
  const map = {
    welcome_unverified: (n) => `👋 Welcome ${n || ''}! Please verify your phone.`,
    otp_sent: (p) => `📨 Code sent to ${p}`,
    otp_failed: () => `❌ OTP failed (Twilio missing).`,
    verified_ok: () => `✅ Phone verified! Use /menu`,
    already_verified: () => `✅ Already verified!`,
    need_verify: () => `⚠️ Verify first using /start`,
    main_menu: () => `Main Menu:`,
    recorded: (kg, naira) => `✅ Recorded ${kg}kg — ₦${naira.toFixed(2)} earned.`,
    min_withdraw: () => `⚠️ Minimum ₦1000 to withdraw.`,
    withdraw_received: () => `✅ Withdrawal request sent.`,
    stats: (t, b) => `📈 Waste: ${t}kg\n💰 Balance: ₦${b.toFixed(2)}`
  };
  const f = map[key] || (() => key);
  return f(...args);
};

// --- Handlers & flows (condensed but full)
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const users = loadUsers();
  let user = users.find(u => u.telegram_id === chatId);
  if (!user) {
    user = { telegram_id: chatId, verified: false, balance: 0, total_waste: 0, language: 'en' };
    users.push(user); saveUsers(users);
  }
  if (!user.verified && loadJSON(SETTINGS_FILE).verification_enabled) {
    return bot.sendMessage(chatId, messageSimple('welcome_unverified', user, msg.from && msg.from.first_name), {
      reply_markup: { keyboard: [[{ text: '📱 Share My Number', request_contact: true }]], resize_keyboard: true }
    });
  }
  return bot.sendMessage(chatId, messageSimple('already_verified', user));
});

bot.on('contact', async (m) => {
  const chatId = m.chat.id;
  const phone = m.contact && m.contact.phone_number;
  if (!phone) return bot.sendMessage(chatId, 'Invalid contact');
  const users = loadUsers();
  const user = users.find(u => u.telegram_id === chatId);
  if (!user) return bot.sendMessage(chatId, 'Please /start first');
  user.phone = phone; user.awaiting_otp = true; saveUsers(users);
  if (!twilioClient) return bot.sendMessage(chatId, messageSimple('otp_failed', user));
  try {
    await twilioClient.verify.v2.services(TWILIO_VERIFY_SID).verifications.create({ to: phone, channel: 'sms' });
    bot.sendMessage(chatId, messageSimple('otp_sent', user, phone));
  } catch (e) {
    console.error('OTP send error', e && e.message ? e.message : e);
    bot.sendMessage(chatId, `${messageSimple('otp_failed', user)} (${e && e.message ? e.message : 'error'})`);
  }
});

bot.on('message', async (m) => {
  const chatId = m.chat.id;
  if (m.contact) return; // handled above
  const text = (m.text || '').trim();
  const users = loadUsers();
  let user = users.find(u => u.telegram_id === chatId);
  if (!user) { user = { telegram_id: chatId, verified: false, balance: 0, total_waste: 0, language: 'en' }; users.push(user); saveUsers(users); }

  // OTP check
  if (user.awaiting_otp && /^\d{4,6}$/.test(text)) {
    if (!twilioClient) return bot.sendMessage(chatId, messageSimple('otp_failed', user));
    try {
      const check = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID).verificationChecks.create({ to: user.phone, code: text });
      if (check && check.status === 'approved') { user.verified = true; user.awaiting_otp = false; saveUsers(users); return bot.sendMessage(chatId, messageSimple('verified_ok', user)); }
      return bot.sendMessage(chatId, '❌ Invalid code');
    } catch (e) { console.error('verify check err', e); return bot.sendMessage(chatId, '⚠️ Verification failed'); }
  }

  if (!user.verified && loadJSON(SETTINGS_FILE).verification_enabled) return bot.sendMessage(chatId, messageSimple('need_verify', user));

  // photo upload
  if (m.photo && m.photo.length) {
    const fileId = m.photo[m.photo.length - 1].file_id;
    try {
      const url = await bot.getFileLink(fileId);
      const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
      const filename = `upload_${chatId}_${Date.now()}.jpg`;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), resp.data);
      user.awaiting_waste = true; user.last_upload = filename; saveUsers(users);
      return bot.sendMessage(chatId, `📸 Photo saved. Send weight in KG.`);
    } catch (e) { console.error('photo save err', e); return bot.sendMessage(chatId, '❌ Failed to save image.'); }
  }

  // weight input
  if (user.awaiting_waste && /^\d+(\.\d+)?$/.test(text)) {
    const kg = parseFloat(text); const earned = kg * 120;
    user.total_waste = (user.total_waste || 0) + kg; user.balance = (user.balance || 0) + earned; user.awaiting_waste = false; saveUsers(users);
    return bot.sendMessage(chatId, messageSimple('recorded', user, kg, earned));
  }

  // menu
  if (text === '/menu' || text.toLowerCase() === 'menu') {
    const buttons = [[{ text: '♻️ Scan Waste' }], [{ text: '💰 Withdraw' }], [{ text: '📊 My Stats' }], [{ text: '🔁 Change Language' }]];
    if (ADMIN_TELEGRAM_ID === chatId) buttons.push([{ text: '🛠 Admin Panel' }]);
    return bot.sendMessage(chatId, messageSimple('main_menu', user), { reply_markup: { keyboard: buttons, resize_keyboard: true } });
  }

  if (text === '♻️ Scan Waste') { user.awaiting_waste = true; saveUsers(users); return bot.sendMessage(chatId, '📸 Send photo or type weight in KG'); }

  if (text === '💰 Withdraw') {
    if (!loadJSON(SETTINGS_FILE).withdrawals_enabled) return bot.sendMessage(chatId, 'Withdrawals disabled');
    if ((user.balance || 0) < 1000) return bot.sendMessage(chatId, messageSimple('min_withdraw', user));
    user.awaiting_withdraw = true; saveUsers(users); return bot.sendMessage(chatId, `💳 Balance ₦${user.balance}\nSend your account info`);
  }

  if (user.awaiting_withdraw) {
    user.awaiting_withdraw = false; user.pending_withdrawal = { amount: user.balance, info: text, status: 'pending' }; saveUsers(users);
    bot.sendMessage(chatId, messageSimple('withdraw_received', user));
    if (ADMIN_TELEGRAM_ID) bot.sendMessage(ADMIN_TELEGRAM_ID, `Withdrawal request from ${user.phone || user.telegram_id} ₦${user.balance} Info: ${text}`);
    return;
  }

  if (text === '📊 My Stats') return bot.sendMessage(chatId, messageSimple('stats', user, user.total_waste, user.balance));

  // admin commands
  if (text.startsWith('/approve') && chatId === ADMIN_TELEGRAM_ID) {
    const id = text.split(' ')[1]; const all = loadUsers(); const u = all.find(x => String(x.telegram_id) === String(id));
    if (!u || !u.pending_withdrawal) return bot.sendMessage(chatId, 'No pending withdrawal'); u.balance = 0; u.pending_withdrawal.status = 'approved'; saveUsers(all);
    bot.sendMessage(u.telegram_id, '✅ Withdrawal approved!'); return bot.sendMessage(chatId, 'Approved.');
  }
  if (text.startsWith('/reject') && chatId === ADMIN_TELEGRAM_ID) {
    const id = text.split(' ')[1]; const all = loadUsers(); const u = all.find(x => String(x.telegram_id) === String(id));
    if (!u || !u.pending_withdrawal) return bot.sendMessage(chatId, 'No pending withdrawal'); u.pending_withdrawal.status = 'rejected'; saveUsers(all);
    bot.sendMessage(u.telegram_id, '❌ Withdrawal rejected.'); return bot.sendMessage(chatId, 'Rejected.');
  }

  // default fallback
  return bot.sendMessage(chatId, '🤖 I did not understand that. Use /menu');
});

// --- Express health endpoints (keep-alive on Railway) ---
const app = express();
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/', (req, res) => res.send('🤖 Bot is live and healthy!'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // keep-alive using axios to localhost (no node-fetch required)
  setInterval(() => {
    axios.get(`http://localhost:${PORT}/health`).then(() => console.log('✅ Keep-alive ping')).catch(e => console.log('⚠️ Keep-alive failed', e.message || e));
  }, 240000);
});
