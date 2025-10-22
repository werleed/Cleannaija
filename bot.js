
// bot.js
// Clean-Naija Bot - Node.js (CommonJS)
// Requirements: node-telegram-bot-api, twilio, dotenv, fs-extra, axios
// Auto-creates data files/folders and uses polling by default.

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const twilio = require('twilio');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');

// -------------------- Configuration & env helpers --------------------
const getEnv = (names, fallback = undefined) => {
  for (const n of names) {
    if (process.env[n]) return process.env[n];
  }
  return fallback;
};

// token mapping (accept BOT_TOKEN or TELEGRAM_TOKEN)
const TELEGRAM_TOKEN = getEnv(['TELEGRAM_TOKEN', 'BOT_TOKEN']);
const TWILIO_ACCOUNT_SID = getEnv(['TWILIO_ACCOUNT_SID', 'TWILIO_SID']);
const TWILIO_AUTH_TOKEN = getEnv(['TWILIO_AUTH_TOKEN', 'TWILIO_AUTH']);
const TWILIO_VERIFY_SID = getEnv(['TWILIO_VERIFY_SID', 'TWILIO_SID_VERIFY', 'TWILIO_VERIFY']);
const ADMIN_IDS_RAW = getEnv(['ADMIN_TELEGRAM_ID', 'ADMIN_IDS', 'ADMINS'], '');
const LANGUAGE = process.env.LANGUAGE || 'en';
const MIN_WITHDRAWAL = parseFloat(process.env.MIN_WITHDRAWAL || '1000') || 1000;
const ADMIN_ENABLE_WITHDRAWALS = (process.env.ADMIN_ENABLE_WITHDRAWALS || 'true').toLowerCase() === 'true';
const ADMIN_ENABLE_SCANNING = (process.env.ADMIN_ENABLE_SCANNING || 'true').toLowerCase() === 'true';

// Validate critical env
const missing = [];
if (!TELEGRAM_TOKEN) missing.push('TELEGRAM_TOKEN (or BOT_TOKEN)');
if (!TWILIO_ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID');
if (!TWILIO_AUTH_TOKEN) missing.push('TWILIO_AUTH_TOKEN');
if (!TWILIO_VERIFY_SID) missing.push('TWILIO_VERIFY_SID');
if (missing.length) {
  console.error('❌ Missing required environment variables:', missing.join(', '));
  console.error('Please set them in Railway (or your host) and restart.');
  process.exit(1);
}

const ADMIN_IDS = ADMIN_IDS_RAW ? ADMIN_IDS_RAW.split(',').map(x => parseInt(x.trim())).filter(Boolean) : [];

// -------------------- Twilio client --------------------
let twilioClient;
try {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} catch (e) {
  console.error('❌ Failed to initialize Twilio client:', e && e.message);
  process.exit(1);
}

// -------------------- Files & directories --------------------
const ROOT = path.join(__dirname);
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// auto-create
fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(UPLOADS_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');

// -------------------- Simple i18n --------------------
const MESSAGES = {
  en: {
    welcome: (name) => `👋 Hi ${name || 'there'} — welcome to Clean Naija!\nPlease verify your phone number first (we'll send an SMS code).`,
    send_contact_or_phone: 'You can share your contact with the button or type your phone number (in international format, e.g. +2348012345678).',
    otp_sent: (phone) => `📨 A verification code was sent to ${phone}. Please reply with the 6-digit code.`,
    otp_failed: '❌ Failed to send OTP. Please check Twilio credentials and that the phone number is properly formatted (+countrycode...).',
    otp_verified: '✅ Phone verified! Use /menu to continue.',
    invalid_code: '❌ Invalid code. Try again.',
    require_verify: '⚠️ Please verify your phone first using /start.',
    main_menu: 'Main Menu:',
    ask_photo_or_weight: '📸 Send a photo of your waste, or type the weight in KG (e.g. "2.5").',
    recorded_waste: (w, amount) => `✅ Recorded ${w}kg waste. You earned ₦${amount.toFixed(2)}.`,
    min_withdrawal: (min) => `⚠️ Minimum withdrawal is ₦${min}.`,
    withdraw_received: '✅ Withdrawal request received and sent to admins for approval.',
    stats: (total_waste, bal) => `📈 Total Waste: ${total_waste}kg\n💰 Balance: ₦${bal.toFixed(2)}`,
    admin_notify_withdrawal: (phone, amount, userId) => `💰 Withdrawal request from ${phone || 'unknown'} Amount: ₦${amount.toFixed(2)}\nUserId: ${userId}`,
    admin_actions: '🧰 Admin Panel:\nUse /users or /reset',
  }
};
const t = (k, ...args) => {
  const msg = (MESSAGES[LANGUAGE] || MESSAGES.en)[k];
  if (!msg) return '';
  return typeof msg === 'function' ? msg(...args) : msg;
};

// -------------------- User storage helpers --------------------
const loadUsers = () => {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '[]');
  } catch (e) {
    console.error('Failed to read users file, recreating:', e && e.message);
    fs.writeFileSync(USERS_FILE, '[]');
    return [];
  }
};
const saveUsers = (u) => fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2));
const findUser = (telegramId) => loadUsers().find(x => x.telegram_id === telegramId);

// -------------------- Telegram bot initialize (polling) --------------------
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on('polling_error', (err) => {
  console.error('Polling error:', err && err.toString ? err.toString() : err);
});

// -------------------- Utility: normalize phone (basic) --------------------
function normalizePhone(raw) {
  if (!raw) return null;
  let s = raw.trim();
  // if user sends telegram contact, sometimes it includes spaces
  s = s.replace(/[\s()-]/g, '');
  // if starts with 0 and looks like local NG number, attempt add +234
  if (/^0\d{9,11}$/.test(s) && !s.startsWith('+')) {
    // default to +234 for Nigerian local numbers
    s = '+234' + s.slice(1);
  }
  if (!s.startsWith('+')) {
    // try to detect if user omitted plus
    if (/^\d{10,15}$/.test(s)) s = '+' + s;
  }
  return s;
}

// -------------------- Start handler --------------------
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  let users = loadUsers();
  let user = users.find(u => u.telegram_id === chatId);
  if (!user) {
    user = {
      telegram_id: chatId,
      verified: false,
      phone: null,
      balance: 0,
      total_waste: 0
    };
    users.push(user);
    saveUsers(users);
  }

  const name = (msg.from && (msg.from.first_name || msg.from.username)) || 'Friend';
  if (!user.verified) {
    // ask for contact or phone
    return bot.sendMessage(chatId, `${t('welcome', name)}\n\n${t('send_contact_or_phone')}`, {
      reply_markup: {
        keyboard: [[{ text: "📱 Share My Number", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
  }

  return bot.sendMessage(chatId, `✅ Welcome back ${name}! Use /menu to continue.`);
});

// -------------------- Contact share handling --------------------
bot.on('contact', async (msg) => {
  const chatId = msg.chat.id;
  const contact = msg.contact;
  if (!contact || !contact.phone_number) return;
  const phone = normalizePhone(contact.phone_number);
  if (!phone) return bot.sendMessage(chatId, '❌ Could not parse phone number.');

  let users = loadUsers();
  let user = users.find(u => u.telegram_id === chatId);
  if (!user) {
    user = { telegram_id: chatId, verified: false, phone, balance: 0, total_waste: 0 };
    users.push(user);
  } else {
    user.phone = phone;
  }
  saveUsers(users);

  // Send OTP
  try {
    console.log(`Sending verification to ${phone}`);
    const res = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
      .verifications.create({ to: phone, channel: 'sms' });
    console.log('Twilio responded:', res && res.status);
    user.awaiting_otp = true;
    saveUsers(users);
    bot.sendMessage(chatId, t('otp_sent', phone));
  } catch (err) {
    console.error('Twilio send OTP failed:', err && err.message, err && err.code, JSON.stringify(err && err.more || {}));
    bot.sendMessage(chatId, t('otp_failed'));
  }
});

// -------------------- Manual phone typed by user (during /start) --------------------
bot.on('message', async (msg) => {
  // the message handler also handles OTP codes and menus; separate flow
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // ignore messages that are contact events (already handled)
  if (msg.contact) return;

  // OTP check: if user awaiting otp and sent 6 digits
  let users = loadUsers();
  let user = users.find(u => u.telegram_id === chatId);

  // If user types a phone number when unverified and not a command
  if (user && !user.verified && /^\+?\d[\d\s()-]{7,}\d$/.test(text) && text.length < 30 && !/\/\w+/.test(text)) {
    const phone = normalizePhone(text);
    if (!phone) return bot.sendMessage(chatId, '❌ Could not parse phone number. Use international format (e.g. +2348012345678).');

    user.phone = phone;
    saveUsers(users);
    try {
      console.log(`Sending verification to ${phone}`);
      const res = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
        .verifications.create({ to: phone, channel: 'sms' });
      console.log('Twilio responded:', res && res.status);
      user.awaiting_otp = true;
      saveUsers(users);
      return bot.sendMessage(chatId, t('otp_sent', phone));
    } catch (err) {
      console.error('Twilio send OTP failed:', err && err.message);
      return bot.sendMessage(chatId, t('otp_failed'));
    }
  }

  // OTP code handling (6 digits)
  if (user && user.awaiting_otp && /^\d{4,8}$/.test(text)) { // allow 4-8 to be flexible
    try {
      const check = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
        .verificationChecks.create({ to: user.phone, code: text });
      console.log('Twilio check result:', check && check.status);
      if (check.status === 'approved') {
        user.verified = true;
        delete user.awaiting_otp;
        saveUsers(users);
        return bot.sendMessage(chatId, t('otp_verified'));
      } else {
        return bot.sendMessage(chatId, t('invalid_code'));
      }
    } catch (err) {
      console.error('Twilio verification check error:', err && err.message);
      return bot.sendMessage(chatId, '⚠️ Verification failed. Please try again or request a new code.');
    }
  }

  // Other message handling only for verified users (menu / actions)
  if (!user || !user.verified) return; // do nothing unless verified

  // The rest of message handlers are in another on('message') below to avoid duplicate logic
});

// -------------------- Menu command --------------------
bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  const user = findUser(chatId);
  if (!user || !user.verified) return bot.sendMessage(chatId, t('require_verify'));

  const buttons = [
    [{ text: "♻️ Scan Waste" }],
    [{ text: "💰 Withdraw" }],
    [{ text: "📊 My Stats" }]
  ];
  if (ADMIN_IDS.includes(chatId)) buttons.push([{ text: "🛠 Admin Panel" }]);
  bot.sendMessage(chatId, t('main_menu'), { reply_markup: { keyboard: buttons, resize_keyboard: true }});
});

// -------------------- Primary user actions (scan/upload/withdraw) --------------------
bot.on('message', async (msg) => {
  // ignore contact event & commands handled previously
  if (msg.contact) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const users = loadUsers();
  const user = users.find(u => u.telegram_id === chatId);
  if (!user || !user.verified) return;

  // Photo upload handling
  if (msg.photo && ADMIN_ENABLE_SCANNING) {
    // Save the largest photo
    const photos = msg.photo;
    const file = photos[photos.length - 1];
    try {
      const fileLink = await bot.getFileLink(file.file_id);
      // download to uploads dir
      const destName = `${chatId}_${Date.now()}.jpg`;
      const destPath = path.join(UPLOADS_DIR, destName);
      const writer = fs.createWriteStream(destPath);
      const resp = await axios({ url: fileLink, method: 'GET', responseType: 'stream' });
      resp.data.pipe(writer);
      await new Promise((res, rej) => writer.on('finish', res).on('error', rej));
      // mark awaiting weight
      user.awaiting_waste = { photo: destName };
      saveUsers(users);
      return bot.sendMessage(chatId, '📸 Photo received. Please reply with the weight in KG (e.g. 2.5).');
    } catch (e) {
      console.error('Photo save error:', e && e.message);
      return bot.sendMessage(chatId, '❌ Failed to process photo. Try again or type the weight.');
    }
  }

  // If waiting for waste weight
  if (user.awaiting_waste && /^\d+(\.\d+)?$/.test(text)) {
    const weight = parseFloat(text);
    const amount = weight * 120; // simulation rate
    user.total_waste = (user.total_waste || 0) + weight;
    user.balance = (user.balance || 0) + amount;
    delete user.awaiting_waste;
    saveUsers(users);
    return bot.sendMessage(chatId, t('recorded_waste', weight, amount));
  }

  // Menu buttons
  if (text === "♻️ Scan Waste") {
    if (!ADMIN_ENABLE_SCANNING) return bot.sendMessage(chatId, '♻️ Scanning is temporarily disabled by Admin.');
    user.awaiting_waste = true;
    saveUsers(users);
    return bot.sendMessage(chatId, t('ask_photo_or_weight'), {
      reply_markup: { remove_keyboard: true }
    });
  }

  if (text === "💰 Withdraw") {
    if (!ADMIN_ENABLE_WITHDRAWALS) return bot.sendMessage(chatId, '💰 Withdrawals are disabled by Admin at the moment.');
    if ((user.balance || 0) < MIN_WITHDRAWAL) {
      return bot.sendMessage(chatId, t('min_withdrawal', MIN_WITHDRAWAL));
    }
    user.awaiting_withdraw = true;
    saveUsers(users);
    return bot.sendMessage(chatId, `💳 Your balance: ₦${(user.balance || 0).toFixed(2)}.\nPlease send account details (account number + bank) to request a withdrawal.`);
  }

  if (user.awaiting_withdraw && text && text.length > 3) {
    // create withdrawal ticket and notify admins with inline buttons
    const amount = user.balance || 0;
    const withdrawTicket = {
      id: `w_${Date.now()}`,
      user_id: user.telegram_id,
      phone: user.phone,
      amount,
      account_details: text,
      status: 'pending'
    };
    // save to data file: withdrawals.json
    const withdrawsFile = path.join(DATA_DIR, 'withdrawals.json');
    let withdraws = [];
    try { withdraws = fs.existsSync(withdrawsFile) ? JSON.parse(fs.readFileSync(withdrawsFile,'utf8')||'[]') : []; } catch (e) { withdraws = []; }
    withdraws.push(withdrawTicket);
    fs.writeFileSync(withdrawsFile, JSON.stringify(withdraws, null, 2));

    delete user.awaiting_withdraw;
    saveUsers(users);

    // Notify admins with approve/reject inline buttons
    ADMIN_IDS.forEach(adminId => {
      bot.sendMessage(adminId, t('admin_notify_withdrawal', user.phone, amount, user.telegram_id), {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Approve', callback_data: `approve_${withdrawTicket.id}` }, { text: '❌ Reject', callback_data: `reject_${withdrawTicket.id}` }]
          ]
        }
      }).catch(err => console.error('Failed to notify admin', err && err.message));
    });

    bot.sendMessage(chatId, t('withdraw_received'));
    return;
  }

  if (text === "📊 My Stats") {
    return bot.sendMessage(chatId, t('stats', user.total_waste || 0, user.balance || 0));
  }

  if (text === "🛠 Admin Panel" && ADMIN_IDS.includes(chatId)) {
    return bot.sendMessage(chatId, t('admin_actions'));
  }

});

// -------------------- Admin inline callback handler (approve/reject) --------------------
bot.on('callback_query', async (callbackQuery) => {
  const data = callbackQuery.data;
  const fromId = callbackQuery.from.id;
  if (!ADMIN_IDS.includes(fromId)) {
    return bot.answerCallbackQuery(callbackQuery.id, { text: 'Unauthorized' });
  }

  if (!data) return bot.answerCallbackQuery(callbackQuery.id, { text: 'No action' });

  if (data.startsWith('approve_') || data.startsWith('reject_')) {
    const [action, ticketId] = data.split('_');
    const withdrawsFile = path.join(DATA_DIR, 'withdrawals.json');
    let withdraws = [];
    try { withdraws = fs.existsSync(withdrawsFile) ? JSON.parse(fs.readFileSync(withdrawsFile,'utf8')||'[]') : []; } catch (e) { withdraws = []; }
    const ticket = withdraws.find(w => w.id === `${ticketId ? ticketId : ''}` || w.id === ticketId);
    // note: earlier we stored id like 'w_12345', callback data has 'approve_w_12345' => adjust:
    const fullId = ticketId || '';
    const ticketExact = withdraws.find(w => w.id === fullId || w.id === `w_${fullId}`);
    const found = ticketExact || ticket;
    if (!found) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Ticket not found' });
      return;
    }

    if (action === 'approve') {
      // mark processed -> remove from list
      found.status = 'approved';
      fs.writeFileSync(withdrawsFile, JSON.stringify(withdraws.map(w => w.id === found.id ? found : w), null, 2));
      // notify user
      bot.sendMessage(found.user_id, `✅ Your withdrawal request of ₦${found.amount.toFixed(2)} was APPROVED by admin. It will be processed soon.`);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Approved' });
    } else {
      found.status = 'rejected';
      fs.writeFileSync(withdrawsFile, JSON.stringify(withdraws.map(w => w.id === found.id ? found : w), null, 2));
      bot.sendMessage(found.user_id, `❌ Your withdrawal request of ₦${found.amount.toFixed(2)} was REJECTED by admin. Contact support.`);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Rejected' });
    }
  } else {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Unknown action' });
  }
});

// -------------------- Admin commands --------------------
bot.onText(/\/users/, (msg) => {
  if (!ADMIN_IDS.includes(msg.chat.id)) return bot.sendMessage(msg.chat.id, 'Unauthorized');
  const users = loadUsers();
  if (!users.length) return bot.sendMessage(msg.chat.id, 'No users yet.');
  const list = users.map(u => `${u.telegram_id} | ${u.phone || 'unknown'} | verified:${!!u.verified} | ₦${(u.balance||0).toFixed(2)}`).join('\n');
  bot.sendMessage(msg.chat.id, `👥 Users:\n${list}`);
});

bot.onText(/\/reset/, (msg) => {
  if (!ADMIN_IDS.includes(msg.chat.id)) return bot.sendMessage(msg.chat.id, 'Unauthorized');
  fs.writeFileSync(USERS_FILE, '[]');
  const withdrawsFile = path.join(DATA_DIR, 'withdrawals.json');
  if (fs.existsSync(withdrawsFile)) fs.unlinkSync(withdrawsFile);
  bot.sendMessage(msg.chat.id, '🧹 All user data and withdrawal tickets reset.');
});

// -------------------- Graceful start message --------------------
console.log('🤖 Bot started successfully...');
// Keep process alive (node will stay running with polling active)
