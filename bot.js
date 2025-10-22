// bot.js (CommonJS)
require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const twilio = require('twilio');
const axios = require('axios'); // included for future offline/online features

// --- Environment & sanity checks ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH;
const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID || process.env.TWILIO_VERIFY;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID ? Number(process.env.ADMIN_TELEGRAM_ID) : null;

if (!TELEGRAM_TOKEN) {
  console.error('FATAL: TELEGRAM_TOKEN (or BOT_TOKEN) environment variable is required.');
  process.exit(1);
}
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SID) {
  console.error('FATAL: Twilio env vars (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID) are required.');
  process.exit(1);
}

// Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- Storage paths & initialization ---
const ROOT = path.join(__dirname);
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(UPLOADS_DIR);

// default config
const defaultConfig = {
  admins: ADMIN_TELEGRAM_ID ? [ADMIN_TELEGRAM_ID] : [],
  features: {
    wasteScan: true,
    withdrawals: true,
    uploads: true
  },
  languagesSupported: ['en', 'ha', 'yo', 'ig'] // English, Hausa, Yoruba, Igbo
};

if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');

// --- Helpers for storage ---
const loadJSON = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8') || 'null') || null; }
  catch (e) { return null; }
};
const saveJSON = (p, data) => { fs.writeFileSync(p, JSON.stringify(data, null, 2)); };

const config = () => loadJSON(CONFIG_FILE) || defaultConfig;
const saveConfig = (c) => saveJSON(CONFIG_FILE, c);

const loadUsers = () => loadJSON(USERS_FILE) || [];
const saveUsers = (u) => saveJSON(USERS_FILE, u);

// Find user by telegram id
const findUser = (telegramId) => loadUsers().find(u => u.telegram_id === telegramId);

// Create user if not exists
const createUserIfMissing = (msg) => {
  const id = msg.chat.id;
  let users = loadUsers();
  if (!users.find(u => u.telegram_id === id)) {
    const user = {
      telegram_id: id,
      username: msg.from?.username || null,
      first_name: msg.from?.first_name || null,
      phone: null,
      verified: false,
      awaiting_otp: false,
      awaiting_waste: false,
      awaiting_withdraw: false,
      total_waste: 0,
      balance: 0,
      language: 'en',
      referrals: []
    };
    users.push(user);
    saveUsers(users);
    return user;
  }
  return users.find(u => u.telegram_id === id);
};

// --- Telegram bot setup (polling) ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Graceful handling of polling startup errors
bot.on('polling_error', (err) => {
  console.error('Polling error:', err && err.code ? err : String(err));
});

// --- Utility: simple phone normalization (very basic) ---
function normalizePhoneNumber(phone) {
  // Remove spaces, dashes, parentheses
  if (!phone) return null;
  let p = phone.replace(/[()\s-]/g, '');
  // If starts with 0 and country not provided, try adding +234 for Nigeria
  if (/^0\d{9,}$/.test(p)) {
    return '+234' + p.slice(1);
  }
  if (/^\d{10,}$/.test(p)) {
    // assume local 10-digit -> add +234
    return '+234' + p.slice(1);
  }
  if (p.startsWith('+')) return p;
  // fallback: return as-is
  return p;
}

// --- I18n messages (minimal) ---
const MESSAGES = {
  en: {
    welcome: (name) => `👋 Welcome ${name || ''}!\nPlease verify your phone number to continue.\nYou can share your contact or type your phone number.`,
    otp_sent: (phone) => `📨 Verification code sent to ${phone}. Please reply with the 6-digit code.`,
    otp_failed: `❌ Failed to send OTP. Please check Twilio settings or try again later.`,
    verified: `✅ Phone verified successfully! Use /menu to continue.`,
    invalid_code: `❌ Invalid code. Please try again.`,
    need_verified: `⚠️ You must verify your phone before using this feature. Use /start.`,
    menu: `Main Menu:`,
    scan_prompt: `📸 Send a photo of your waste or type the weight in KG:`,
    recorded: (w, amount) => `✅ Recorded ${w}kg waste. You earned ₦${amount.toFixed(2)}!`,
    withdraw_min: `⚠️ Minimum withdrawal is ₦1000.`,
    withdraw_received: `✅ Withdrawal request received. Admin will review it.`,
    stats: (u) => `📈 Total Waste: ${u.total_waste}kg\n💰 Balance: ₦${u.balance.toFixed(2)}`
  }
  // other languages can be added as objects: ha, yo, ig
};

function t(user, key, ...args) {
  const lang = (user && user.language) || 'en';
  const str = (MESSAGES[lang] && MESSAGES[lang][key]) || (MESSAGES['en'][key]);
  return typeof str === 'function' ? str(...args) : str;
}

// --- Bot command handlers ---

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const user = createUserIfMissing(msg);
  const name = user.first_name || msg.from?.first_name || 'there';
  bot.sendMessage(chatId, t(user, 'welcome', name), {
    reply_markup: {
      keyboard: [[{ text: "📱 Share My Number", request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
});

// Contact shared by user
bot.on('contact', async (msg) => {
  try {
    const chatId = msg.chat.id;
    createUserIfMissing(msg);
    let users = loadUsers();
    const user = users.find(u => u.telegram_id === chatId);
    if (!user) return;
    const raw = msg.contact.phone_number;
    const phone = normalizePhoneNumber(raw);
    user.phone = phone;
    user.awaiting_otp = true;
    saveUsers(users);

    // send verification
    try {
      await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
        .verifications.create({ to: phone, channel: 'sms' });
      bot.sendMessage(chatId, t(user, 'otp_sent', phone));
    } catch (err) {
      console.error('Twilio send OTP error:', err && err.message ? err.message : err);
      bot.sendMessage(chatId, t(user, 'otp_failed'));
    }
  } catch (e) {
    console.error('contact handler error:', e);
  }
});

// Catch-all message handler for OTP, menu actions, text input
bot.on('message', async (msg) => {
  if (!msg || !msg.chat) return;
  // ignore contact events (handled above) and edited messages
  if (msg.contact) return;
  if (!msg.text) {
    // support image uploads in 'photo' event instead
    return;
  }

  const chatId = msg.chat.id;
  const users = loadUsers();
  let user = users.find(u => u.telegram_id === chatId);
  if (!user) user = createUserIfMissing(msg);

  const text = msg.text.trim();

  // OTP 6-digit handling if awaiting
  if (user.awaiting_otp && /^\d{4,6}$/.test(text)) {
    // attempt verification
    try {
      const res = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
        .verificationChecks.create({ to: user.phone, code: text });

      if (res && res.status === 'approved') {
        user.verified = true;
        user.awaiting_otp = false;
        saveUsers(users);
        bot.sendMessage(chatId, t(user, 'verified'));
      } else {
        bot.sendMessage(chatId, t(user, 'invalid_code'));
      }
    } catch (err) {
      console.error('Twilio verification error:', err && err.message ? err.message : err);
      bot.sendMessage(chatId, `⚠️ Verification failed. ${err && err.message ? err.message : ''}`);
    }
    return;
  }

  // If user not verified, block other command usage except /start
  if (!user.verified && text !== '/start') {
    bot.sendMessage(chatId, t(user, 'need_verified'));
    return;
  }

  // Main menu commands
  if (text === '/menu') {
    const buttons = [
      [{ text: "♻️ Scan Waste" }],
      [{ text: "💰 Withdraw" }],
      [{ text: "📊 My Stats" }]
    ];
    const cfg = config();
    if (cfg.admins && cfg.admins.includes(chatId)) buttons.push([{ text: "🛠 Admin Panel" }]);

    return bot.sendMessage(chatId, t(user, 'menu'), {
      reply_markup: { keyboard: buttons, resize_keyboard: true }
    });
  }

  // Admin only commands
  const cfg = config();
  if (text === '/admin' && cfg.admins.includes(chatId)) {
    const msgTxt = `🧰 Admin Panel\nCommands:\n/users - list users\n/toggle featureName - toggle features (wasteScan, withdrawals, uploads)\n/pending - list pending withdrawals\n/broadcast <text> - send to all users`;
    return bot.sendMessage(chatId, msgTxt);
  }

  if (cfg.admins.includes(chatId) && text.startsWith('/toggle')) {
    const parts = text.split(/\s+/);
    const feature = parts[1];
    if (!feature) return bot.sendMessage(chatId, 'Usage: /toggle <featureName>');
    const conf = config();
    if (conf.features.hasOwnProperty(feature)) {
      conf.features[feature] = !conf.features[feature];
      saveConfig(conf);
      return bot.sendMessage(chatId, `Feature ${feature} set to ${conf.features[feature]}`);
    } else {
      return bot.sendMessage(chatId, `Unknown feature. Valid: ${Object.keys(conf.features).join(', ')}`);
    }
  }

  if (cfg.admins.includes(chatId) && text === '/users') {
    const us = loadUsers();
    const list = us.map(u => `${u.telegram_id} ${u.first_name || ''} ${u.phone || 'no-phone'} - ₦${u.balance.toFixed(2)}`).join('\n') || 'No users';
    return bot.sendMessage(chatId, `👥 Users:\n${list}`);
  }

  if (cfg.admins.includes(chatId) && text === '/pending') {
    const us = loadUsers();
    const pend = us.filter(u => u.pending_withdraw).map(u => `${u.telegram_id} - ${u.phone} - ₦${u.pending_withdraw.amount}`).join('\n') || 'No pending withdrawals';
    return bot.sendMessage(chatId, `🕒 Pending withdrawals:\n${pend}`);
  }

  if (cfg.admins.includes(chatId) && text.startsWith('/approve')) {
    // /approve <telegram_id>
    const parts = text.split(/\s+/);
    const tid = Number(parts[1]);
    if (!tid) return bot.sendMessage(chatId, 'Usage: /approve <telegram_id>');
    let usersList = loadUsers();
    const u = usersList.find(x => x.telegram_id === tid);
    if (!u || !u.pending_withdraw) return bot.sendMessage(chatId, 'No pending withdrawal for that user.');
    // approve
    const amount = u.pending_withdraw.amount;
    u.pending_withdraw = null;
    u.balance = 0;
    saveUsers(usersList);
    bot.sendMessage(chatId, `✅ Withdraw approved for ${tid}: ₦${amount}`);
    bot.sendMessage(tid, `💸 Your withdrawal of ₦${amount} has been approved by admin.`);
    return;
  }

  if (cfg.admins.includes(chatId) && text.startsWith('/reject')) {
    // /reject <telegram_id> <reason (optional)>
    const parts = text.split(/\s+/);
    const tid = Number(parts[1]);
    const reason = parts.slice(2).join(' ') || 'No reason provided';
    if (!tid) return bot.sendMessage(chatId, 'Usage: /reject <telegram_id> <reason>');
    let usersList = loadUsers();
    const u = usersList.find(x => x.telegram_id === tid);
    if (!u || !u.pending_withdraw) return bot.sendMessage(chatId, 'No pending withdrawal for that user.');
    const amount = u.pending_withdraw.amount;
    u.pending_withdraw = null;
    saveUsers(usersList);
    bot.sendMessage(chatId, `❌ Withdraw rejected for ${tid}`);
    bot.sendMessage(tid, `❌ Your withdrawal of ₦${amount} was rejected by admin. Reason: ${reason}`);
    return;
  }

  if (cfg.admins.includes(chatId) && text.startsWith('/broadcast ')) {
    const content = text.replace('/broadcast ', '').trim();
    const usersList = loadUsers();
    usersList.forEach(u => {
      try { bot.sendMessage(u.telegram_id, `📣 Broadcast: ${content}`); } catch (e) { }
    });
    return bot.sendMessage(chatId, 'Broadcast sent.');
  }

  // User features:
  if (text === '♻️ Scan Waste' || text === 'Scan Waste') {
    if (!cfg.features.wasteScan) return bot.sendMessage(chatId, '♻️ Waste scanning is temporarily disabled by admin.');
    user.awaiting_waste = true;
    saveUsers(loadUsers());
    return bot.sendMessage(chatId, t(user, 'scan_prompt'));
  }

  // If awaiting waste and text is a numeric weight
  if (user.awaiting_waste && /^\d+(\.\d+)?$/.test(text)) {
    const weight = parseFloat(text);
    const pricePerKg = 120; // simulation
    const amount = weight * pricePerKg;
    user.total_waste = (user.total_waste || 0) + weight;
    user.balance = (user.balance || 0) + amount;
    user.awaiting_waste = false;
    saveUsers(loadUsers());
    return bot.sendMessage(chatId, t(user, 'recorded', weight, amount));
  }

  if (text === '💰 Withdraw' || text === 'Withdraw') {
    if (!cfg.features.withdrawals) return bot.sendMessage(chatId, 'Withdrawals are currently disabled by admin.');
    if (user.balance < 1000) return bot.sendMessage(chatId, t(user, 'withdraw_min'));
    // mark pending withdrawal
    user.pending_withdraw = { amount: user.balance, requested_at: Date.now() };
    saveUsers(loadUsers());
    // notify admins
    const conf = config();
    const adminIds = conf.admins || [];
    adminIds.forEach(aid => {
      try {
        bot.sendMessage(aid, `💰 Withdrawal request from ${user.telegram_id} (${user.phone || 'no-phone'}) - ₦${user.pending_withdraw.amount}\nApprove: /approve ${user.telegram_id}\nReject: /reject ${user.telegram_id} <reason>`);
      } catch (e) { console.error('notify admin error', e); }
    });
    return bot.sendMessage(chatId, t(user, 'withdraw_received'));
  }

  if (text === '📊 My Stats' || text === 'My Stats') {
    return bot.sendMessage(chatId, t(user, 'stats', user));
  }

  // default fallback
  bot.sendMessage(chatId, "I didn't understand that. Use /menu or /start.");
});

// Handle photos for offline detection/upload flow
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const usersList = loadUsers();
  const user = usersList.find(u => u.telegram_id === chatId);
  if (!user || !user.verified) return bot.sendMessage(chatId, t(user, 'need_verified'));

  const cfg = config();
  if (!cfg.features.uploads) return bot.sendMessage(chatId, 'Image uploads are disabled by admin.');

  // Save the highest resolution photo
  const photos = msg.photo || [];
  const last = photos[photos.length - 1];
  if (!last || !last.file_id) return bot.sendMessage(chatId, 'No valid photo found.');

  try {
    const file = await bot.getFile(last.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;

    // Download and save locally to uploads folder
    const filename = `${Date.now()}_${chatId}_${path.basename(file.file_path)}`;
    const filepath = path.join(UPLOADS_DIR, filename);
    const resp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(filepath, resp.data);

    // Offline detection placeholder:
    // In production you'd run a model here. We'll simulate detection and give a price.
    const fakeDetected = { type: 'Plastic Bottles', confidence: 0.88, estimated_kg: 1.2 };
    const priceKg = 120;
    const amount = fakeDetected.estimated_kg * priceKg;
    user.total_waste = (user.total_waste || 0) + fakeDetected.estimated_kg;
    user.balance = (user.balance || 0) + amount;
    saveUsers(usersList);

    bot.sendMessage(chatId, `Detected: ${fakeDetected.type} (confidence ${Math.round(fakeDetected.confidence*100)}%).\nEstimated: ${fakeDetected.estimated_kg}kg -> ₦${amount.toFixed(2)} credited to your wallet.`);
  } catch (e) {
    console.error('photo processing error', e && e.message ? e.message : e);
    bot.sendMessage(chatId, '⚠️ Failed to process the image. Try again.');
  }
});

// startup message
console.log('🤖 Bot started successfully...');
