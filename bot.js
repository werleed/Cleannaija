// bot.js
require('dotenv').config();

const fs = require('fs');
const fsExtra = require('fs-extra');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// --- Config from env ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID ? parseInt(process.env.ADMIN_TELEGRAM_ID, 10) : null;

// Twilio Verify (we use REST via axios to avoid twilio lib version conflicts)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID;

// Bot mode: "polling" (default) or "webhook"
const BOT_MODE = (process.env.BOT_MODE || 'polling').toLowerCase();
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL; // required for webhook mode

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const KEEP_ALIVE = process.env.KEEP_ALIVE === 'true' || false;
const KEEP_ALIVE_INTERVAL_MS = parseInt(process.env.KEEP_ALIVE_INTERVAL_MS || '240000', 10); // default 4 minutes

if (!TELEGRAM_TOKEN) {
  console.error('FATAL: TELEGRAM_TOKEN or BOT_TOKEN missing in env.');
  process.exit(1);
}

// --- Files & folders ---
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fsExtra.ensureDirSync(DATA_DIR);
fsExtra.ensureDirSync(UPLOADS_DIR);

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');
if (!fs.existsSync(SETTINGS_FILE)) {
  const defaultSettings = {
    verification_enabled: true,
    withdrawals_enabled: true,
    language_default: 'en'
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2), 'utf8');
}

// --- Helpers for storage ---
const loadJSON = (p) => {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('loadJSON error', p, e && e.message);
    return {};
  }
};
const saveJSON = (p, obj) => {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
};

const loadUsers = () => {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8') || '[]';
    return JSON.parse(raw);
  } catch (e) {
    console.error('loadUsers error', e && e.message);
    return [];
  }
};
const saveUsers = (arr) => fs.writeFileSync(USERS_FILE, JSON.stringify(arr, null, 2), 'utf8');

// --- Twilio Verify (REST via axios) ---
const twilioEnabled = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_VERIFY_SID);
async function sendTwilioVerification(toPhone) {
  if (!twilioEnabled) throw new Error('Twilio not configured');
  const url = `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SID}/Verifications`;
  const auth = { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN };
  const data = new URLSearchParams({ To: toPhone, Channel: 'sms' }).toString();
  const res = await axios.post(url, data, {
    auth,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000
  });
  return res.data;
}
async function checkTwilioVerification(toPhone, code) {
  if (!twilioEnabled) throw new Error('Twilio not configured');
  const url = `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SID}/VerificationCheck`;
  const auth = { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN };
  const data = new URLSearchParams({ To: toPhone, Code: code }).toString();
  const res = await axios.post(url, data, {
    auth,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000
  });
  return res.data;
}

// --- Multi-language messages (en, fr, ha, yo, ak) ---
const MESSAGES = {
  en: {
    welcome_unverified: (name) => `👋 Welcome ${name || ''}!\nPlease verify your phone number first. Share contact or type your phone number.`,
    otp_sent: (phone) => `📨 Verification code sent to ${phone}. Reply with the 4-6 digit code.`,
    otp_failed: `❌ Failed to send OTP. Admin must configure Twilio.`,
    verified_ok: `✅ Phone number verified successfully! Use /menu to continue.`,
    already_verified: `✅ You're already verified! Use /menu to continue.`,
    need_verify: `⚠️ Please verify your phone first using /start`,
    main_menu: `Main Menu:`,
    recorded: (kg, naira) => `✅ Recorded ${kg}kg waste.\nYou earned ₦${naira.toFixed(2)}.`,
    min_withdraw: `⚠️ Minimum withdrawal is ₦1000.`,
    withdraw_received: `✅ Withdrawal request received. Admin will process it soon.`,
    stats: (total, balance) => `📈 Total Waste: ${total}kg\n💰 Balance: ₦${balance.toFixed(2)}`,
    detected_country: (c) => `🌍 Detected: ${c}`
  },
  fr: { /* ...short French translations (same keys) */ },
  ha: { /* ...Hausa translations */ },
  yo: { /* ...Yoruba translations */ },
  ak: { /* ...Akan/Twi translations */ }
};

// Provide minimal fallbacks where keys missing
for (const k of ['fr','ha','yo','ak']) {
  if (!MESSAGES[k]) MESSAGES[k] = MESSAGES.en;
}

const langFor = (user) => (user && user.language) || loadJSON(SETTINGS_FILE).language_default || 'en';
const message = (key, user, ...args) => {
  const lang = langFor(user);
  const m = (MESSAGES[lang] && MESSAGES[lang][key]) || MESSAGES.en[key];
  if (typeof m === 'function') return m(...args);
  return m || '';
};

// --- Detect country helpers ---
function detectCountryFromPhone(phone) {
  if (!phone) return null;
  const p = String(phone).replace(/\s+/g, '');
  if (p.startsWith('+234') || p.startsWith('234')) return { code: 'NG', name: 'Nigeria 🇳🇬' };
  if (p.startsWith('+233') || p.startsWith('233')) return { code: 'GH', name: 'Ghana 🇬🇭' };
  if (p.startsWith('+1')) return { code: 'US', name: 'United States 🇺🇸' };
  return null;
}
function detectCountryFallback(from) {
  if (!from) return null;
  const lang = (from.language_code || '').toLowerCase();
  if (lang.startsWith('fr')) return { code: 'FR', name: 'Francophone' };
  if (lang.startsWith('en')) return { code: 'EN', name: 'English' };
  return null;
}

// --- Express app (health + webhook path for Telegram if needed) ---
const app = express();
app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.get('/', (req, res) => res.send('🤖 Bot is live'));

// --- Telegram bot init ---
let bot;
try {
  if (BOT_MODE === 'webhook') {
    bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
    if (!TELEGRAM_WEBHOOK_URL) {
      console.warn('WEBHOOK mode set but TELEGRAM_WEBHOOK_URL not provided. Falling back to polling.');
      bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
    } else {
      // Set webhook
      const webhookPath = '/telegram-webhook';
      const webhookUrl = TELEGRAM_WEBHOOK_URL;
      app.post(webhookPath, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
      });
      (async () => {
        try {
          await bot.setWebHook(webhookUrl + webhookPath);
          console.log('Webhook set to', webhookUrl + webhookPath);
        } catch (e) {
          console.error('Failed to set webhook, falling back to polling:', e && e.message);
          bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
        }
      })();
    }
  } else {
    bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  }
} catch (e) {
  console.error('Failed to init Telegram bot:', e && e.message);
  process.exit(1);
}

bot.on('polling_error', (err) => {
  console.error('Polling error:', err && err.toString ? err.toString() : err);
  // If unauthorized token, exit to let deploy indicate invalid token
  if (err && err.code === 'ETELEGRAM' && /Unauthorized/i.test(err.toString())) {
    console.error('Unauthorized: TELEGRAM_TOKEN invalid. Exiting.');
    process.exit(1);
  }
});

// --- Startup log ---
console.log(new Date().getFullYear(), `Starting in ${BOT_MODE.toUpperCase()} mode.`);
console.log('🤖 Bot started successfully (POLLING mode if not webhook)...');

// --- /start handler ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  let users = loadUsers();
  let user = users.find(u => u.telegram_id === chatId);
  if (!user) {
    user = {
      telegram_id: chatId,
      verified: false,
      phone: null,
      balance: 0,
      total_waste: 0,
      awaiting_otp: false,
      awaiting_waste: false,
      awaiting_withdraw: false,
      language: loadJSON(SETTINGS_FILE).language_default || 'en'
    };
    users.push(user);
    saveUsers(users);
  }

  const country = detectCountryFromPhone(user.phone) || detectCountryFallback(msg.from) || null;
  if (country) bot.sendMessage(chatId, message('detected_country', user, country.name));

  if (!user.verified && loadJSON(SETTINGS_FILE).verification_enabled) {
    bot.sendMessage(chatId, message('welcome_unverified', user, msg.from.first_name), {
      reply_markup: {
        keyboard: [[{ text: "📱 Share My Number", request_contact: true }], [{ text: "Type phone number" }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
    return;
  }
  bot.sendMessage(chatId, message('already_verified', user));
});

// --- contact share (user shares phone) ---
bot.on('contact', async (msg) => {
  const chatId = msg.chat.id;
  const phone = msg.contact && msg.contact.phone_number;
  if (!phone) return bot.sendMessage(chatId, "Invalid contact.");

  const users = loadUsers();
  const user = users.find(u => u.telegram_id === chatId);
  if (!user) return bot.sendMessage(chatId, "Please send /start first.");

  user.phone = phone;
  user.awaiting_otp = true;
  saveUsers(users);

  if (!twilioEnabled) {
    bot.sendMessage(chatId, message('otp_failed', user));
    console.error('Twilio not configured - cannot send OTP.');
    return;
  }
  try {
    await sendTwilioVerification(phone);
    bot.sendMessage(chatId, message('otp_sent', user, phone));
  } catch (err) {
    console.error('Twilio send error', err && err.message ? err.message : err);
    bot.sendMessage(chatId, `${message('otp_failed', user)}\n${err && err.message ? err.message : ''}`);
  }
});

// --- main message handler ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // ignore contact event here (handled above)
  if (msg.contact) return;

  let users = loadUsers();
  let user = users.find(u => u.telegram_id === chatId);
  if (!user) {
    user = {
      telegram_id: chatId,
      verified: false,
      phone: null,
      balance: 0,
      total_waste: 0,
      awaiting_otp: false,
      awaiting_waste: false,
      awaiting_withdraw: false,
      language: loadJSON(SETTINGS_FILE).language_default || 'en'
    };
    users.push(user);
    saveUsers(users);
  }

  // OTP entry (4-6 digits)
  if (user.awaiting_otp && /^\d{4,6}$/.test(text)) {
    if (!twilioEnabled) {
      bot.sendMessage(chatId, message('otp_failed', user));
      return;
    }
    try {
      const check = await checkTwilioVerification(user.phone, text);
      if (check && check.status === 'approved') {
        user.verified = true;
        user.awaiting_otp = false;
        saveUsers(users);
        return bot.sendMessage(chatId, message('verified_ok', user));
      } else {
        return bot.sendMessage(chatId, '❌ Invalid code. Try again.');
      }
    } catch (err) {
      console.error('Twilio check error', err && err.message ? err.message : err);
      return bot.sendMessage(chatId, '⚠️ Verification failed. Please try again later.');
    }
  }

  // If not verified and verification is enabled, accept manual phone input
  if (!user.verified && loadJSON(SETTINGS_FILE).verification_enabled && /^\+?\d{7,15}$/.test(text)) {
    user.phone = text;
    user.awaiting_otp = true;
    saveUsers(users);
    if (!twilioEnabled) {
      bot.sendMessage(chatId, message('otp_failed', user));
      return;
    }
    try {
      await sendTwilioVerification(text);
      bot.sendMessage(chatId, message('otp_sent', user, text));
    } catch (err) {
      console.error('Twilio send error (manual)', err && err.message ? err.message : err);
      bot.sendMessage(chatId, `${message('otp_failed', user)}\n${err && err.message ? err.message : ''}`);
    }
    return;
  }

  // Unless verified, block other flows
  if (!user.verified && loadJSON(SETTINGS_FILE).verification_enabled) {
    return bot.sendMessage(chatId, message('need_verify', user));
  }

  // Photo upload (save)
  if (msg.photo && msg.photo.length) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    try {
      const fileUrl = await bot.getFileLink(fileId);
      const resp = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 20000 });
      const filename = `upload_${chatId}_${Date.now()}.jpg`;
      const fullPath = path.join(UPLOADS_DIR, filename);
      fs.writeFileSync(fullPath, resp.data);
      user.awaiting_waste = true;
      user.last_upload = filename;
      saveUsers(users);
      return bot.sendMessage(chatId, `📸 Photo saved as ${filename}. Please reply with weight in KG (e.g. 2.5).`);
    } catch (err) {
      console.error('Save photo error', err && err.message ? err.message : err);
      return bot.sendMessage(chatId, '❌ Failed to process photo. Send weight manually.');
    }
  }

  // If awaiting weight
  if (user.awaiting_waste && /^\d+(\.\d+)?$/.test(text)) {
    const weight = parseFloat(text);
    const amount = weight * 120; // price simulation
    user.total_waste = (user.total_waste || 0) + weight;
    user.balance = (user.balance || 0) + amount;
    user.awaiting_waste = false;
    saveUsers(users);
    return bot.sendMessage(chatId, message('recorded', user, weight, amount));
  }

  // /menu
  if (text === '/menu' || text.toLowerCase() === 'menu') {
    const buttons = [
      [{ text: "♻️ Scan Waste" }],
      [{ text: "💰 Withdraw" }],
      [{ text: "📊 My Stats" }],
      [{ text: "🔁 Change Language" }]
    ];
    if (ADMIN_TELEGRAM_ID && ADMIN_TELEGRAM_ID === chatId) buttons.push([{ text: "🛠 Admin Panel" }]);
    return bot.sendMessage(chatId, message('main_menu', user), { reply_markup: { keyboard: buttons, resize_keyboard: true } });
  }

  if (text === "♻️ Scan Waste") {
    user.awaiting_waste = true; saveUsers(users);
    return bot.sendMessage(chatId, "📸 Send photo of waste or type the weight in KG (e.g. 1.5).");
  }

  if (text === "💰 Withdraw") {
    if (!loadJSON(SETTINGS_FILE).withdrawals_enabled) return bot.sendMessage(chatId, 'Withdrawals disabled by admin.');
    if ((user.balance || 0) < 1000) return bot.sendMessage(chatId, message('min_withdraw', user));
    user.awaiting_withdraw = true; saveUsers(users);
    return bot.sendMessage(chatId, `💳 Balance ₦${(user.balance||0).toFixed(2)}\nSend your account info (account number / bank).`);
  }

  if (user.awaiting_withdraw) {
    user.awaiting_withdraw = false;
    user.pending_withdrawal = {
      amount: user.balance,
      info: text,
      requested_at: new Date().toISOString(),
      status: 'pending'
    };
    saveUsers(users);
    bot.sendMessage(chatId, message('withdraw_received', user));
    if (ADMIN_TELEGRAM_ID) {
      bot.sendMessage(ADMIN_TELEGRAM_ID, `💰 New withdrawal request\nUser: ${user.phone || user.telegram_id}\nAmount: ₦${user.balance}\nDetails: ${text}\nApprove: /approve ${user.telegram_id}\nReject: /reject ${user.telegram_id}`);
    }
    return;
  }

  if (text === "📊 My Stats") return bot.sendMessage(chatId, message('stats', user, user.total_waste || 0, user.balance || 0));

  // Admin panel quick menu
  if (text === "🛠 Admin Panel" && ADMIN_TELEGRAM_ID && ADMIN_TELEGRAM_ID === chatId) {
    return bot.sendMessage(chatId, "Admin Commands:\n/approve <userId>\n/reject <userId>\n/broadcast <msg>\n/toggle_verification\n/toggle_withdrawals\n/users");
  }

  // /users admin
  if (text.startsWith('/users') && ADMIN_TELEGRAM_ID && ADMIN_TELEGRAM_ID === chatId) {
    const all = loadUsers();
    const list = all.map(u => `${u.telegram_id} | ${u.phone || 'nophone'} | ₦${(u.balance||0).toFixed(2)} | verified:${u.verified}`).slice(0,200).join('\n');
    return bot.sendMessage(chatId, `👥 Users:\n${list || 'No users yet.'}`);
  }

  // /approve
  if (text.startsWith('/approve') && ADMIN_TELEGRAM_ID && ADMIN_TELEGRAM_ID === chatId) {
    const parts = text.split(/\s+/);
    const uid = parts[1];
    if (!uid) return bot.sendMessage(chatId, 'Usage: /approve <telegramId>');
    let all = loadUsers();
    const u = all.find(x => String(x.telegram_id) === String(uid));
    if (!u || !u.pending_withdrawal) return bot.sendMessage(chatId, 'No pending withdrawal.');
    u.pending_withdrawal.status = 'approved';
    u.balance = 0;
    saveUsers(all);
    bot.sendMessage(chatId, `✅ Withdrawal for ${uid} approved.`);
    bot.sendMessage(u.telegram_id, `💸 Your withdrawal for ₦${u.pending_withdrawal.amount} has been APPROVED by admin.`);
    return;
  }

  // /reject
  if (text.startsWith('/reject') && ADMIN_TELEGRAM_ID && ADMIN_TELEGRAM_ID === chatId) {
    const parts = text.split(/\s+/);
    const uid = parts[1];
    if (!uid) return bot.sendMessage(chatId, 'Usage: /reject <telegramId>');
    let all = loadUsers();
    const u = all.find(x => String(x.telegram_id) === String(uid));
    if (!u || !u.pending_withdrawal) return bot.sendMessage(chatId, 'No pending withdrawal.');
    u.pending_withdrawal.status = 'rejected';
    saveUsers(all);
    bot.sendMessage(chatId, `❌ Withdrawal for ${uid} rejected.`);
    bot.sendMessage(u.telegram_id, `❌ Your withdrawal for ₦${u.pending_withdrawal.amount} has been REJECTED by admin.`);
    return;
  }

  // /broadcast
  if (text.startsWith('/broadcast') && ADMIN_TELEGRAM_ID && ADMIN_TELEGRAM_ID === chatId) {
    const bmsg = text.replace('/broadcast', '').trim();
    if (!bmsg) return bot.sendMessage(chatId, 'Usage: /broadcast <message>');
    const all = loadUsers();
    bot.sendMessage(chatId, `Sending broadcast to ${all.length} users...`);
    for (const u of all) {
      if (u.verified) {
        try {
          await bot.sendMessage(u.telegram_id, `📢 Broadcast:\n\n${bmsg}`);
        } catch (e) {
          console.error('Broadcast send failed to', u.telegram_id, e && e.message);
        }
      }
    }
    return;
  }

  // toggle verification
  if (text === '/toggle_verification' && ADMIN_TELEGRAM_ID && ADMIN_TELEGRAM_ID === chatId) {
    const s = loadJSON(SETTINGS_FILE);
    s.verification_enabled = !s.verification_enabled; saveJSON(SETTINGS_FILE, s);
    return bot.sendMessage(chatId, `Verification: ${s.verification_enabled}`);
  }

  // toggle withdrawals
  if (text === '/toggle_withdrawals' && ADMIN_TELEGRAM_ID && ADMIN_TELEGRAM_ID === chatId) {
    const s = loadJSON(SETTINGS_FILE);
    s.withdrawals_enabled = !s.withdrawals_enabled; saveJSON(SETTINGS_FILE, s);
    return bot.sendMessage(chatId, `Withdrawals: ${s.withdrawals_enabled}`);
  }

  // change language
  if (text === '🔁 Change Language') {
    const keyboards = [['English'], ['Hausa'], ['Yoruba'], ['French'], ['Akan']];
    return bot.sendMessage(chatId, 'Choose language:', { reply_markup: { keyboard: keyboards.map(k => k.map(t => ({ text: t }))), one_time_keyboard: true }});
  }
  if (['English','Hausa','Yoruba','French','Akan'].includes(text)) {
    const map = { English: 'en', Hausa: 'ha', Yoruba: 'yo', French: 'fr', Akan: 'ak' };
    user.language = map[text] || 'en';
    saveUsers(users);
    return bot.sendMessage(chatId, `Language set to ${text}.`);
  }

  // default: echo or help
  return bot.sendMessage(chatId, "I didn't understand that. Type /menu to see options.");
});

// --- Start express server ---
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// --- Keep alive pings (optional) ---
if (KEEP_ALIVE) {
  setInterval(() => {
    axios.get(`http://localhost:${PORT}/health`, { timeout: 5000 })
      .then(() => console.log('✅ Keep-alive ping sent'))
      .catch((err) => console.log('⚠️ Keep-alive failed', err && err.message ? err.message : err));
  }, KEEP_ALIVE_INTERVAL_MS);
}
