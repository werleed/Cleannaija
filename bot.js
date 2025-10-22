// bot.js
require('dotenv').config();
const fs = require('fs');
const fsExtra = require('fs-extra');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const twilio = require('twilio');
const axios = require('axios');
const fetch = require('node-fetch');

// --- Environment / config ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID ? parseInt(process.env.ADMIN_TELEGRAM_ID, 10) : null;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID;

if (!TELEGRAM_TOKEN) {
  console.error('FATAL: TELEGRAM_TOKEN or BOT_TOKEN missing.');
  process.exit(1);
}
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SID) {
  console.warn('⚠️ Twilio credentials missing — OTP won’t work until set.');
}

// --- Paths ---
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
const loadJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8') || '{}'); } catch { return {}; } };
const saveJSON = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
const loadUsers = () => { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '[]'); } catch { return []; } };
const saveUsers = (a) => fs.writeFileSync(USERS_FILE, JSON.stringify(a, null, 2), 'utf8');

// --- Twilio client ---
let twilioClient = null;
try { twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN); } catch { twilioClient = null; }

// --- Telegram bot ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('🤖 Bot started successfully...');

// --- Messages ---
const MESSAGES = {
  en: {
    welcome_unverified: (n) => `👋 Welcome ${n || ''}! Please verify your phone first.`,
    otp_sent: (p) => `📨 Code sent to ${p}`,
    otp_failed: `❌ Failed to send OTP.`,
    verified_ok: `✅ Phone verified! Use /menu`,
    already_verified: `✅ Already verified!`,
    need_verify: `⚠️ Verify first using /start`,
    main_menu: `Main Menu:`,
    recorded: (kg, naira) => `✅ Recorded ${kg}kg waste — ₦${naira.toFixed(2)} earned.`,
    min_withdraw: `⚠️ Minimum ₦1000 to withdraw.`,
    withdraw_received: `✅ Withdrawal request sent.`,
    stats: (t, b) => `📈 Waste: ${t}kg\n💰 Balance: ₦${b.toFixed(2)}`
  }
};
const msg = (key, user, ...a) => {
  const lang = (user && user.language) || 'en';
  const entry = (MESSAGES[lang] && MESSAGES[lang][key]) || MESSAGES.en[key];
  return typeof entry === 'function' ? entry(...a) : entry;
};

// --- Start ---
bot.onText(/\/start/, (msgObj) => {
  const chatId = msgObj.chat.id;
  const users = loadUsers();
  let user = users.find(u => u.telegram_id === chatId);
  if (!user) {
    user = { telegram_id: chatId, verified: false, balance: 0, total_waste: 0, language: 'en' };
    users.push(user);
    saveUsers(users);
  }
  if (!user.verified && loadJSON(SETTINGS_FILE).verification_enabled) {
    bot.sendMessage(chatId, msg('welcome_unverified', user, msgObj.from.first_name), {
      reply_markup: { keyboard: [[{ text: "📱 Share My Number", request_contact: true }]], resize_keyboard: true }
    });
  } else bot.sendMessage(chatId, msg('already_verified', user));
});

// --- Contact Handler ---
bot.on('contact', async (m) => {
  const chatId = m.chat.id;
  const phone = m.contact?.phone_number;
  const users = loadUsers();
  const user = users.find(u => u.telegram_id === chatId);
  if (!user) return bot.sendMessage(chatId, 'Use /start first');
  user.phone = phone;
  user.awaiting_otp = true;
  saveUsers(users);

  if (!twilioClient) return bot.sendMessage(chatId, msg('otp_failed', user));
  try {
    await twilioClient.verify.v2.services(TWILIO_VERIFY_SID).verifications.create({ to: phone, channel: 'sms' });
    bot.sendMessage(chatId, msg('otp_sent', user, phone));
  } catch (e) {
    console.error('OTP error:', e.message);
    bot.sendMessage(chatId, `${msg('otp_failed', user)} (${e.message})`);
  }
});

// --- Main Message Logic ---
bot.on('message', async (m) => {
  const chatId = m.chat.id;
  const text = (m.text || '').trim();
  if (m.contact) return;

  let users = loadUsers();
  let user = users.find(u => u.telegram_id === chatId);
  if (!user) {
    user = { telegram_id: chatId, verified: false, balance: 0, total_waste: 0, language: 'en' };
    users.push(user); saveUsers(users);
  }

  // Handle OTP input
  if (user.awaiting_otp && /^\d{4,6}$/.test(text)) {
    try {
      const result = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
        .verificationChecks.create({ to: user.phone, code: text });
      if (result.status === 'approved') {
        user.verified = true; user.awaiting_otp = false; saveUsers(users);
        return bot.sendMessage(chatId, msg('verified_ok', user));
      }
      return bot.sendMessage(chatId, '❌ Invalid code');
    } catch (e) {
      return bot.sendMessage(chatId, '⚠️ Verification failed');
    }
  }

  if (!user.verified && loadJSON(SETTINGS_FILE).verification_enabled)
    return bot.sendMessage(chatId, msg('need_verify', user));

  // Upload photo (scan waste)
  if (m.photo?.length) {
    try {
      const fileId = m.photo.at(-1).file_id;
      const filePath = await bot.getFileLink(fileId);
      const img = await axios.get(filePath, { responseType: 'arraybuffer' });
      const filename = `upload_${chatId}_${Date.now()}.jpg`;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), img.data);
      user.awaiting_waste = true;
      user.last_upload = filename;
      saveUsers(users);
      return bot.sendMessage(chatId, '📸 Photo saved. Send weight in KG.');
    } catch {
      return bot.sendMessage(chatId, '❌ Failed to save image.');
    }
  }

  // Weight input
  if (user.awaiting_waste && /^\d+(\.\d+)?$/.test(text)) {
    const kg = parseFloat(text);
    const earned = kg * 120;
    user.total_waste += kg;
    user.balance += earned;
    user.awaiting_waste = false;
    saveUsers(users);
    return bot.sendMessage(chatId, msg('recorded', user, kg, earned));
  }

  // Menu
  if (text === '/menu' || text.toLowerCase() === 'menu') {
    const buttons = [
      [{ text: "♻️ Scan Waste" }],
      [{ text: "💰 Withdraw" }],
      [{ text: "📊 My Stats" }],
      [{ text: "🔁 Change Language" }]
    ];
    if (ADMIN_TELEGRAM_ID === chatId) buttons.push([{ text: "🛠 Admin Panel" }]);
    return bot.sendMessage(chatId, msg('main_menu', user), { reply_markup: { keyboard: buttons, resize_keyboard: true } });
  }

  if (text === "♻️ Scan Waste") {
    user.awaiting_waste = true;
    saveUsers(users);
    return bot.sendMessage(chatId, "📸 Send photo or type weight in KG");
  }

  if (text === "💰 Withdraw") {
    if (!loadJSON(SETTINGS_FILE).withdrawals_enabled)
      return bot.sendMessage(chatId, "Withdrawals disabled");
    if (user.balance < 1000)
      return bot.sendMessage(chatId, msg('min_withdraw', user));
    user.awaiting_withdraw = true; saveUsers(users);
    return bot.sendMessage(chatId, `💳 Balance ₦${user.balance}\nSend your account info`);
  }

  if (user.awaiting_withdraw) {
    user.awaiting_withdraw = false;
    user.pending_withdrawal = { amount: user.balance, info: text, status: 'pending' };
    saveUsers(users);
    bot.sendMessage(chatId, msg('withdraw_received', user));
    if (ADMIN_TELEGRAM_ID)
      bot.sendMessage(ADMIN_TELEGRAM_ID, `💰 Withdrawal request from ${user.phone}\n₦${user.balance}\nInfo: ${text}\nApprove: /approve ${chatId}\nReject: /reject ${chatId}`);
    return;
  }

  if (text === "📊 My Stats") return bot.sendMessage(chatId, msg('stats', user, user.total_waste, user.balance));

  // Admin Panel
  if (text === "🛠 Admin Panel" && chatId === ADMIN_TELEGRAM_ID)
    return bot.sendMessage(chatId, "/approve <id>\n/reject <id>\n/toggle_verification\n/toggle_withdrawals\n/users");

  if (text.startsWith('/approve') && chatId === ADMIN_TELEGRAM_ID) {
    const id = text.split(' ')[1];
    const all = loadUsers();
    const u = all.find(x => String(x.telegram_id) === id);
    if (!u?.pending_withdrawal) return bot.sendMessage(chatId, 'No pending withdrawal');
    u.balance = 0; u.pending_withdrawal.status = 'approved'; saveUsers(all);
    bot.sendMessage(u.telegram_id, '✅ Withdrawal approved!');
    return bot.sendMessage(chatId, 'Approved.');
  }

  if (text.startsWith('/reject') && chatId === ADMIN_TELEGRAM_ID) {
    const id = text.split(' ')[1];
    const all = loadUsers();
    const u = all.find(x => String(x.telegram_id) === id);
    if (!u?.pending_withdrawal) return bot.sendMessage(chatId, 'No pending withdrawal');
    u.pending_withdrawal.status = 'rejected'; saveUsers(all);
    bot.sendMessage(u.telegram_id, '❌ Withdrawal rejected.');
    return bot.sendMessage(chatId, 'Rejected.');
  }

  if (text === '/toggle_verification' && chatId === ADMIN_TELEGRAM_ID) {
    const s = loadJSON(SETTINGS_FILE);
    s.verification_enabled = !s.verification_enabled; saveJSON(SETTINGS_FILE, s);
    return bot.sendMessage(chatId, `Verification: ${s.verification_enabled}`);
  }

  if (text === '/toggle_withdrawals' && chatId === ADMIN_TELEGRAM_ID) {
    const s = loadJSON(SETTINGS_FILE);
    s.withdrawals_enabled = !s.withdrawals_enabled; saveJSON(SETTINGS_FILE, s);
    return bot.sendMessage(chatId, `Withdrawals: ${s.withdrawals_enabled}`);
  }
});
// --- Keep bot alive on Railway ---
const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.send('🤖 Bot is live and healthy!');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // Send periodic self-pings to keep container alive
  setInterval(() => {
    fetch(`http://localhost:${PORT}/health`)
      .then(() => console.log('✅ Keep-alive ping sent'))
      .catch((err) => console.log('⚠️ Keep-alive failed:', err.message));
  }, 240000); // every 4 minutes
});
