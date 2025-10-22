// bot.js
// Clean9ja unified bot + admin UI + mock Twilio
require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');

const PORT = process.env.PORT || 8080;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || '';

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

fs.ensureDirSync(DATA_DIR);

// Helper to load/save JSON
const loadJSON = (file, fallback) => {
  try {
    if (!fs.existsSync(file)) {
      fs.writeJsonSync(file, fallback ?? {}, { spaces: 2 });
    }
    return fs.readJsonSync(file);
  } catch (err) {
    console.error('Failed to load JSON', file, err);
    return fallback ?? {};
  }
};
const saveJSON = (file, obj) => fs.writeJsonSync(file, obj, { spaces: 2 });

// Initialize persistent files with safe defaults
const defaultSettings = {
  mode: 'POLLING', // or WEBHOOK
  withdrawals_enabled: true,
  online_scanning: true,
  offline_scanning: false,
  min_withdraw: 1000,
  price_per_kg: 50,
  languages: ['en', 'yo'],
  default_language: 'en',
  twilio_enabled: false,
  admins: [], // put telegram user ids
};
const defaultMessages = {
  en: {
    welcome: "Welcome to Clean9ja Bot. Use the menu to interact with the service.",
    min_withdraw: "You need at least ₦{min} to withdraw.",
    withdrawal_disabled: "Withdrawals are currently disabled by admin.",
    withdrawal_requested: "✅ Withdrawal request received. Admin will process it shortly.",
    send_otp_prompt: "We will send you an OTP to verify your phone before using the bot.",
    otp_sent: "An OTP has been sent to {phone}. Enter it to verify.",
    otp_failed: "❌ Failed to send OTP. Admin must configure Twilio or use mock verification.",
    otp_verified: "✅ Phone verified successfully. You may proceed.",
    not_verified: "You must verify your phone before using this feature.",
    professional_error: "An error occurred. Please try again or contact an admin.",
    scan_online: "Online scanning started — analyzing image for waste...",
    scan_offline: "Offline scanning started — please upload an image to scan.",
  },
  yo: {
    welcome: "Kaabo si Clean9ja Bot. Lo menu lati ba eto sọrọ.",
    min_withdraw: "O nilo o kere ₦{min} lati fa owo.",
    withdrawal_disabled: "A ko gba awọn yiyọ kuro lọwọlọwọ nipasẹ admin.",
    // ... other messages can be added
  }
};

const users = loadJSON(USERS_FILE, {});
const settings = loadJSON(SETTINGS_FILE, defaultSettings);
const messages = loadJSON(MESSAGES_FILE, defaultMessages);

saveJSON(USERS_FILE, users);
saveJSON(SETTINGS_FILE, settings);
saveJSON(MESSAGES_FILE, messages);

// utility message function (language templating)
function message(key, user = {}, params = {}) {
  const lang = (user.lang || settings.default_language || 'en');
  const langMessages = messages[lang] || messages['en'];
  let text = langMessages[key] || messages['en'][key] || key;
  for (const k in params) text = text.replace(`{${k}}`, params[k]);
  // support also numeric placeholders from settings
  text = text.replace('{min}', settings.min_withdraw);
  return text;
}

// Mock Twilio module (no external API)
const twilio = require('twilio');

// Create or re-use bot
if (!TELEGRAM_TOKEN) {
  console.warn('TELEGRAM_TOKEN not provided — bot will not connect to Telegram until set.');
}
const botOptions = { polling: true };
const bot = new TelegramBot(TELEGRAM_TOKEN, botOptions);

// Express admin UI
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// simple auth for admin panel: check token in query or header (basic)
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'adminsecret';
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token || req.body.token;
  if (token === ADMIN_SECRET) return next();
  return res.status(401).send('Unauthorized');
}

// Admin routes (JSON)
app.get('/admin/settings', requireAdmin, (req, res) => {
  res.json(loadJSON(SETTINGS_FILE, defaultSettings));
});
app.post('/admin/settings', requireAdmin, (req, res) => {
  const incoming = req.body;
  const cur = loadJSON(SETTINGS_FILE, defaultSettings);
  const updated = { ...cur, ...incoming };
  saveJSON(SETTINGS_FILE, updated);
  res.json({ ok: true, settings: updated });
});
app.get('/admin/users', requireAdmin, (req, res) => {
  res.json(loadJSON(USERS_FILE, {}));
});
app.post('/admin/users/:id', requireAdmin, (req, res) => {
  const uid = req.params.id;
  const allUsers = loadJSON(USERS_FILE, {});
  allUsers[uid] = { ...allUsers[uid], ...req.body };
  saveJSON(USERS_FILE, allUsers);
  res.json({ ok: true, user: allUsers[uid] });
});

// Simple admin basic page
app.get('/admin', requireAdmin, (req, res) => {
  const s = loadJSON(SETTINGS_FILE, defaultSettings);
  res.send(`
    <h2>Clean9ja Admin</h2>
    <p>Use POST /admin/settings with JSON (header x-admin-token:${ADMIN_SECRET})</p>
    <pre>${JSON.stringify(s, null, 2)}</pre>
  `);
});

// Health check for Railway
app.get('/_health', (req, res) => res.send('ok'));

// Start express server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Bot logic: message handling
bot.on('polling_error', (err) => {
  console.error('Polling error:', err && err.code ? `${err.code} ${err.response?.body || err.message}` : err);
});

bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id.toString();
    const text = (msg.text || '').trim();

    // ensure user exists
    const allUsers = loadJSON(USERS_FILE, {});
    if (!allUsers[chatId]) {
      allUsers[chatId] = { id: chatId, lang: settings.default_language, balance: 0, verified: false, awaiting_withdraw: false };
      saveJSON(USERS_FILE, allUsers);
    }
    const user = allUsers[chatId];

    // simple commands
    if (text === '/start' || text.toLowerCase() === 'hi' || text.toLowerCase() === 'hello') {
      await bot.sendMessage(chatId, message('welcome', user));
      return;
    }

    // request verification (phone) - flow uses mock twilio
    if (text.toLowerCase().startsWith('verify')) {
      // expect phone: verify +234xxxxxxxxx
      const parts = text.split(/\s+/);
      const phone = parts[1];
      if (!phone) return bot.sendMessage(chatId, 'Usage: verify <phone_number>');
      if (!settings.twilio_enabled) {
        // use mock OTP: generate and store
        const otp = mockTwilio.generateOTP(chatId);
        user.pending_otp = otp;
        saveJSON(USERS_FILE, allUsers);
        await bot.sendMessage(chatId, message('otp_sent', user, { phone }));
        await bot.sendMessage(chatId, `🔐 Mock OTP: ${otp} (for testing only)`);
        return;
      } else {
        // if twilio_enabled true but no credentials, return professional error
        const sent = await mockTwilio.sendOTP(phone); // mock wrapper that returns success/fail
        if (sent.success) {
          user.pending_otp = sent.otp;
          saveJSON(USERS_FILE, allUsers);
          return bot.sendMessage(chatId, message('otp_sent', user, { phone }));
        } else {
          return bot.sendMessage(chatId, message('otp_failed', user));
        }
      }
    }

    // OTP verification
    if (/^\d{4,6}$/.test(text)) {
      if (user.pending_otp && text === String(user.pending_otp)) {
        user.verified = true;
        delete user.pending_otp;
        saveJSON(USERS_FILE, allUsers);
        return bot.sendMessage(chatId, message('otp_verified', user));
      } else {
        return bot.sendMessage(chatId, '❌ Incorrect OTP. Please request a new one by sending: verify <phone>');
      }
    }

    // Withdraw
    if (text === '💰 Withdraw' || text.toLowerCase().includes('withdraw')) {
      if (!settings.withdrawals_enabled) return bot.sendMessage(chatId, message('withdrawal_disabled', user));
      if ((user.balance || 0) < settings.min_withdraw) return bot.sendMessage(chatId, message('min_withdraw', user, { min: settings.min_withdraw }));
      user.awaiting_withdraw = true;
      saveJSON(USERS_FILE, allUsers);
      return bot.sendMessage(chatId, message('withdrawal_requested', user));
    }

    // Scan commands (mock detection)
    if (text.toLowerCase().includes('scan online')) {
      if (!settings.online_scanning) return bot.sendMessage(chatId, 'Online scanning currently disabled by admin.');
      // pretend to scan; in real usage you'd hook image handlers
      return bot.sendMessage(chatId, message('scan_online', user));
    }
    if (text.toLowerCase().includes('scan offline')) {
      if (!settings.offline_scanning) return bot.sendMessage(chatId, 'Offline scanning disabled by admin.');
      return bot.sendMessage(chatId, message('scan_offline', user));
    }

    // Admin-only commands to toggle (if user id in settings.admins)
    if (text.startsWith('/admin')) {
      const isAdmin = settings.admins.includes(Number(chatId));
      if (!isAdmin) return bot.sendMessage(chatId, 'Unauthorized: admin only.');
      // parse admin commands: /admin set price 80
      const tokens = text.split(/\s+/);
      if (tokens[1] === 'set' && tokens[2] === 'price') {
        const p = Number(tokens[3]);
        if (isNaN(p)) return bot.sendMessage(chatId, 'Price must be a number.');
        settings.price_per_kg = p;
        saveJSON(SETTINGS_FILE, settings);
        return bot.sendMessage(chatId, `Price updated to ₦${p} per kg`);
      }
      return bot.sendMessage(chatId, 'Admin commands: /admin set price <n>');
    }

    // Fallback
    return bot.sendMessage(chatId, "I didn't understand that. Send /start or use the menu.");
  } catch (err) {
    console.error('Error handling message:', err);
    try { await bot.sendMessage(msg.chat.id, 'An internal error occurred. Admin has been notified.'); } catch(e){}
  }
});

// Graceful save on exit
process.on('SIGTERM', () => {
  console.info('SIGTERM received, saving files and exiting');
  saveJSON(USERS_FILE, loadJSON(USERS_FILE, {}));
  saveJSON(SETTINGS_FILE, loadJSON(SETTINGS_FILE, defaultSettings));
  process.exit(0);
});
