// bot.js
// Clean-Naija Bot - Node (CommonJS) ready for Node 18
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const twilio = require('twilio');

const PORT = process.env.PORT || 3000;

// --- Environment variables (required) ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || null;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID || null;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || null;
const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID || null;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_TELEGRAM_IDS || ''; // comma separated

// Helpful logs for missing vars (bot will not crash; will disable specific features gracefully)
if (!TELEGRAM_TOKEN) console.error('⚠️ TELEGRAM_TOKEN / BOT_TOKEN not set - the Telegram bot will not start polling.');
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SID) {
  console.warn('⚠️ Twilio environment variables missing. OTP sending or verification WILL FAIL until configured.');
}

// --- Twilio client (if credentials exist) ---
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  } catch (e) {
    console.error('⚠️ Failed to initialize Twilio client:', e.message);
    twilioClient = null;
  }
}

// --- Directories + data files setup ---
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// Initialize files if missing
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
if (!fs.existsSync(SETTINGS_FILE)) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    admin_ids: ADMIN_TELEGRAM_ID ? ADMIN_TELEGRAM_ID.split(',').map(s => s.trim()).filter(Boolean).map(Number) : [],
    features: {
      withdrawals_enabled: true,
      uploads_enabled: true,
      auto_admin_mode: true
    }
  }, null, 2));
}

// --- Helpers for data persistence ---
const loadUsers = () => {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to load users.json:', e);
    return [];
  }
};
const saveUsers = (data) => {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
};

const loadSettings = () => {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to load settings.json:', e);
    return { admin_ids: [], features: {} };
  }
};
const saveSettings = (s) => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));

const findUserByTelegram = (tgId) => loadUsers().find(u => u.telegram_id === tgId);
const findUserByPhone = (phone) => loadUsers().find(u => u.phone === phone);

// --- Multi-language support (basic) ---
const LANG_STRINGS = {
  en: {
    welcome: name => `👋 Hi ${name || 'there'}! Please verify your phone number to continue.`,
    ask_phone: 'Please send your contact (📱 Share My Number) or type your phone number manually (example: +2348012345678).',
    otp_sent: phone => `📨 Verification code sent to ${phone}. Please reply with the 6-digit code.`,
    otp_failed: '❌ Failed to send OTP. Please check Twilio credentials and the phone number format.',
    verified: '✅ Phone number verified successfully! You can now use /menu.',
    invalid_code: '❌ Invalid code. Try again.',
    need_verify: '⚠️ Please verify your phone first using /start.',
    main_menu: 'Main Menu:',
    scan_prompt: '📸 Send a photo of your waste or type the weight in KG:',
    recorded: (w, a) => `✅ Recorded ${w}kg waste.\nYou earned ₦${a.toFixed(2)}! 💸`,
    withdraw_min: '⚠️ Minimum withdrawal is ₦1000.',
    withdraw_received: '✅ Withdrawal request received. Admin will process it soon!',
    stats: (w, b) => `📈 Total Waste: ${w}kg\n💰 Balance: ₦${b.toFixed(2)}`,
    admin_panel: '🧰 Admin Panel:\nUse /users to list users.\nUse /approve <phone_or_tgId> or /reject <phone_or_tgId> to manage withdrawals.\nUse /feature <name> <on|off> to toggle features.',
    not_admin: '⛔ You are not an admin.',
    unknown_command: "I didn't understand that. Use /menu."
  },
  yo: {
    welcome: name => `👋 Bawo ${name || ''}! Jọwọ jẹrisi nomba foonu rẹ lati tẹsiwaju.`,
    ask_phone: 'Jọwọ pin olubasọrọ rẹ tabi kọ nomba foonu rẹ (e.g. +2348012345678).',
    otp_sent: phone => `📨 A ti ran koodu si ${phone}. Jọwọ fesi pẹlu koodu 6-digit.`,
    otp_failed: '❌ Kò ríranṣẹ OTP. Ṣayẹwo awọn akọọlẹ Twilio rẹ.',
    verified: '✅ A ti jẹrisi! Lo /menu bayi.',
    invalid_code: '❌ Koodu ko tọ. Gbiyanju lẹẹkansi.',
    need_verify: '⚠️ Jọwọ jẹrisi foonu rẹ pẹlu /start.',
    main_menu: 'Akojọ aṣayan:',
    scan_prompt: '📸 Fi fọto ranṣẹ tabi kọ iwọn ni KG:',
    recorded: (w, a) => `✅ A ṣe igbasilẹ ${w}kg.\nO gba ₦${a.toFixed(2)}! 💸`,
    withdraw_min: '⚠️ Ibeere yiyọ kere ju ₦1000 lọ.',
    withdraw_received: '✅ A gba ibeere yiyọ. Admin yoo ṣayẹwo.',
    stats: (w, b) => `📈 Igun apoti: ${w}kg\n💰 Iwọnyi: ₦${b.toFixed(2)}`,
    admin_panel: '🧰 Paneli Admin:\nLo /users /approve /reject /feature',
    not_admin: '⛔ O kii ṣe admin.',
    unknown_command: "Emi ko ye e. Lo /menu."
  },
  ha: {
    welcome: name => `👋 Sannu ${name || ''}! Don Allah tabbatar da wayarka kafin ci gaba.`,
    ask_phone: 'Aiko lamba ko raba lamba (e.g. +2348012345678).',
    otp_sent: phone => `📨 An tura lambar tabbatarwa zuwa ${phone}. A aiko da lambar ta 6-digit.`,
    otp_failed: '❌ Ba a aika OTP ba. Duba Twilio credentials.',
    verified: '✅ An tabbatar! Yi amfani da /menu yanzu.',
    invalid_code: '❌ Lambar bata dace ba. Gwada sake.',
    need_verify: '⚠️ Don Allah tabbatar da wayarka tare da /start.',
    main_menu: 'Babban Menu:',
    scan_prompt: '📸 Aiko hoto ko rubuta nauyi a KG:',
    recorded: (w, a) => `✅ An rubuta ${w}kg.\nKa samu ₦${a.toFixed(2)}! 💸`,
    withdraw_min: '⚠️ Mafi karancin cirewa ₦1000.',
    withdraw_received: '✅ An karbi buƙatar cirewa. Admin zai tantance.',
    stats: (w, b) => `📈 Jimlar Shara: ${w}kg\n💰 Adadin: ₦${b.toFixed(2)}`,
    admin_panel: '🧰 Admin Panel: /users /approve /reject /feature',
    not_admin: '⛔ Ba kai admin ba ne.',
    unknown_command: "Ban fahimta ba. Yi amfani da /menu."
  },
  ig: {
    welcome: name => `👋 Nnọọ ${name || ''}! Biko devee gị ekwentị tupu ịga n’ihu.`,
    ask_phone: 'Biko kesaa kọntakt (📱) ma ọ bụ dee nọmba gị (e.g. +2348012345678).',
    otp_sent: phone => `📨 Ezigbo! A zitere koodu na ${phone}. Zaa ya na koodu 6-digit.`,
    otp_failed: '❌ Ezighi ezi: e nweghị ike izipu OTP. Lelee Twilio.',
    verified: '✅ Edebanyere! Jiri /menu.',
    invalid_code: '❌ Koodu ezighi ezi.',
    need_verify: '⚠️ Biko debe ekwentị gị site na /start.',
    main_menu: 'Isi Ntụziaka:',
    scan_prompt: '📸 Zipu foto ma ọ bụ dee ibu na KG:',
    recorded: (w, a) => `✅ Edere ${w}kg.\nInweta ₦${a.toFixed(2)}! 💸`,
    withdraw_min: '⚠️ Withdraw kacha nta bụ ₦1000.',
    withdraw_received: '✅ E nwetara arịrịọ withdraw. Admin ga-eme ya.',
    stats: (w, b) => `📈 Total Waste: ${w}kg\n💰 Balance: ₦${b.toFixed(2)}`,
    admin_panel: '🧰 Admin Panel: /users /approve /reject /feature',
    not_admin: '⛔ Ị bụghị admin.',
    unknown_command: "Amaghị m nke ahụ. Jiri /menu."
  }
};

function langText(userLang = 'en', key, ...args) {
  const code = (userLang || 'en').slice(0,2).toLowerCase();
  const dict = LANG_STRINGS[code] || LANG_STRINGS.en;
  const value = dict[key];
  if (typeof value === 'function') return value(...args);
  return value || LANG_STRINGS.en[key] || '';
}

// --- Create bot (only if token present) ---
let bot = null;
if (TELEGRAM_TOKEN) {
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log('2025 Starting in POLLING mode.');
} else {
  console.warn('Telegram token missing — bot not started. Add TELEGRAM_TOKEN env var.');
}

// --- Express keep-alive ---
const app = express();
app.get('/', (req, res) => res.send('Clean-Naija Bot: alive'));
app.listen(PORT, () => console.log(`Express server listening on ${PORT}`));

// --- Utility ---
// price per kg (can become configurable)
const PRICE_PER_KG = 120;

// create or get user by telegram id
function ensureUser(tgId, from) {
  const users = loadUsers();
  let user = users.find(u => u.telegram_id === tgId);
  if (!user) {
    user = {
      telegram_id: tgId,
      first_name: from && from.first_name ? from.first_name : null,
      phone: null,
      verified: false,
      awaiting_otp: false,
      awaiting_waste: false,
      awaiting_withdraw: false,
      total_waste: 0,
      balance: 0,
      pending_withdrawals: [] // array of {amount, requested_at, details}
    };
    users.push(user);
    saveUsers(users);
  }
  return user;
}

// parse phone number string into E.164 if possible (default region NG)
function normalizePhone(raw) {
  if (!raw) return null;
  try {
    const p = parsePhoneNumberFromString(raw, 'NG');
    return p && p.isPossible() ? p.number : raw;
  } catch (e) {
    return raw;
  }
}

// send OTP via Twilio Verify
async function sendOTP(phone) {
  if (!twilioClient || !TWILIO_VERIFY_SID) throw new Error('Twilio not configured');
  return twilioClient.verify.v2.services(TWILIO_VERIFY_SID).verifications.create({
    to: phone,
    channel: 'sms'
  });
}

// check OTP via Twilio Verify
async function checkOTP(phone, code) {
  if (!twilioClient || !TWILIO_VERIFY_SID) throw new Error('Twilio not configured');
  return twilioClient.verify.v2.services(TWILIO_VERIFY_SID).verificationChecks.create({
    to: phone,
    code
  });
}

// --- Bot handlers ---
if (bot) {
  // Start command
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const user = ensureUser(chatId, msg.from);
    const userLang = msg.from && msg.from.language_code ? msg.from.language_code : 'en';

    // greet and ask phone
    bot.sendMessage(chatId, `${langText(userLang,'welcome', msg.from.first_name)}\n\n${langText(userLang,'ask_phone')}`, {
      reply_markup: {
        keyboard: [[{ text: "📱 Share My Number", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
  });

  // menu command
  bot.onText(/\/menu/, (msg) => {
    const chatId = msg.chat.id;
    const user = findUserByTelegram(chatId);
    const userLang = msg.from && msg.from.language_code ? msg.from.language_code : 'en';
    if (!user || !user.verified) {
      return bot.sendMessage(chatId, langText(userLang, 'need_verify'));
    }

    const settings = loadSettings();
    const buttons = [];
    if (settings.features.uploads_enabled) buttons.push([{ text: "♻️ Scan / Upload Waste" }]);
    buttons.push([{ text: "💰 Withdraw" }, { text: "📊 My Stats" }]);
    buttons.push([{ text: "📩 Contact Admin" }]);
    if (settings.admin_ids.includes(chatId)) buttons.push([{ text: "🛠 Admin Panel" }]);

    bot.sendMessage(chatId, langText(userLang, 'main_menu'), {
      reply_markup: { keyboard: buttons, resize_keyboard: true }
    });
  });

  // contact shared by user
  bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const user = ensureUser(chatId, msg.from);
    const userLang = msg.from && msg.from.language_code ? msg.from.language_code : 'en';
    if (!msg.contact || !msg.contact.phone_number) {
      return bot.sendMessage(chatId, langText(userLang, 'ask_phone'));
    }
    const phone = normalizePhone(msg.contact.phone_number);
    user.phone = phone;
    user.awaiting_otp = true;
    saveUsers(loadUsers());
    try {
      await sendOTP(phone);
      bot.sendMessage(chatId, langText(userLang, 'otp_sent', phone));
    } catch (e) {
      console.error('OTP send failed:', e && e.message ? e.message : e);
      bot.sendMessage(chatId, langText(userLang, 'otp_failed'));
    }
  });

  // handle photos, OTP codes, menu selections and messages
  bot.on('message', async (msg) => {
    // ignore service messages (contact handled above)
    if (!msg || !msg.chat) return;
    const chatId = msg.chat.id;
    const text = msg.text ? (msg.text+'').trim() : '';
    const userLang = msg.from && msg.from.language_code ? msg.from.language_code : 'en';

    // ignore messages that are commands (we handle some separately)
    if (text && text.startsWith('/')) return;

    let users = loadUsers();
    let user = users.find(u => u.telegram_id === chatId);
    if (!user) {
      user = ensureUser(chatId, msg.from);
      users = loadUsers();
    }

    // If user has photo(s)
    if (msg.photo && msg.photo.length > 0 && user.verified) {
      // Save the largest photo
      try {
        const photo = msg.photo[msg.photo.length - 1];
        const fileId = photo.file_id;
        const fileLink = await bot.getFileLink(fileId);
        const ext = path.extname(fileLink.split('?')[0]) || '.jpg';
        const filename = `upload_${chatId}_${Date.now()}${ext}`;
        const outPath = path.join(UPLOADS_DIR, filename);

        const response = await axios({ method: 'get', url: fileLink, responseType: 'stream' });
        const writer = fs.createWriteStream(outPath);
        response.data.pipe(writer);
        await new Promise((res, rej) => writer.on('finish', res).on('error', rej));

        // Simulated offline waste detection (no external API)
        const classes = ['Plastic', 'Paper', 'Metal', 'Organic', 'Glass'];
        const detected = classes[Math.floor(Math.random()*classes.length)];
        // weight estimate (0.2 - 5.0 kg)
        const weight = parseFloat((Math.random()*4.8 + 0.2).toFixed(2));
        const amount = weight * PRICE_PER_KG;

        user.total_waste = (user.total_waste || 0) + weight;
        user.balance = (user.balance || 0) + amount;
        saveUsers(users);

        bot.sendMessage(chatId,
          `🔎 Detected: ${detected}\n📦 Estimated weight: ${weight}kg\n💰 Earned: ₦${amount.toFixed(2)}\n\n${langText(userLang,'recorded', weight, amount)}`
        );

      } catch (e) {
        console.error('Photo handling failed:', e);
        bot.sendMessage(chatId, '⚠️ Failed to process image. Try again.');
      }
      return;
    }

    // If user awaiting OTP and message is 6 digits -> check OTP
    if (user.awaiting_otp && /^\d{4,6}$/.test(text)) {
      const code = text;
      if (!user.phone) return bot.sendMessage(chatId, langText(userLang,'ask_phone'));
      try {
        const res = await checkOTP(user.phone, code);
        if (res && res.status === 'approved') {
          user.verified = true;
          user.awaiting_otp = false;
          saveUsers(loadUsers());
          bot.sendMessage(chatId, langText(userLang,'verified'));
        } else {
          bot.sendMessage(chatId, langText(userLang,'invalid_code'));
        }
      } catch (e) {
        console.error('OTP verification error:', e && e.message ? e.message : e);
        bot.sendMessage(chatId, langText(userLang,'invalid_code'));
      }
      return;
    }

    // If message looks like a phone number and user not verified -> start verify
    if (!user.verified && text && (text.match(/\d/) && text.length >= 7)) {
      const phone = normalizePhone(text);
      user.phone = phone;
      user.awaiting_otp = true;
      saveUsers(loadUsers());
      try {
        await sendOTP(phone);
        bot.sendMessage(chatId, langText(userLang, 'otp_sent', phone));
      } catch (e) {
        console.error('OTP send failed (manual):', e && e.message ? e.message : e);
        bot.sendMessage(chatId, langText(userLang, 'otp_failed'));
      }
      return;
    }

    // Only verified users can access the rest
    if (!user.verified) {
      return bot.sendMessage(chatId, langText(userLang, 'need_verify'));
    }

    // User interactions
    const settings = loadSettings();

    if (text === "♻️ Scan / Upload Waste") {
      if (!settings.features.uploads_enabled) return bot.sendMessage(chatId, 'Uploads currently disabled by admin.');
      user.awaiting_waste = true;
      saveUsers(loadUsers());
      return bot.sendMessage(chatId, langText(userLang, 'scan_prompt'));
    }

    if (user.awaiting_waste && /^\d+(\.\d+)?$/.test(text)) {
      const weight = parseFloat(text);
      const amount = weight * PRICE_PER_KG;
      user.total_waste = (user.total_waste || 0) + weight;
      user.balance = (user.balance || 0) + amount;
      user.awaiting_waste = false;
      saveUsers(loadUsers());
      return bot.sendMessage(chatId, langText(userLang, 'recorded', weight, amount));
    }

    if (text === "💰 Withdraw") {
      if (!settings.features.withdrawals_enabled) return bot.sendMessage(chatId, 'Withdrawals are currently disabled by admin.');
      if (user.balance < 1000) return bot.sendMessage(chatId, langText(userLang,'withdraw_min'));
      user.awaiting_withdraw = true;
      saveUsers(loadUsers());
      return bot.sendMessage(chatId, `💳 Your balance is ₦${user.balance.toFixed(2)}.\nPlease send your account details (Account name, bank, account number).`);
    }

    if (user.awaiting_withdraw) {
      // save pending withdrawal
      const amount = user.balance;
      const details = text;
      const withdrawal = { amount, requested_at: new Date().toISOString(), details, status: 'pending', telegram_id: user.telegram_id, phone: user.phone };
      user.pending_withdrawals = user.pending_withdrawals || [];
      user.pending_withdrawals.push(withdrawal);
      user.awaiting_withdraw = false;
      // keep balance until admin approves (simulation)
      saveUsers(loadUsers());

      // notify admins
      const settings2 = loadSettings();
      settings2.admin_ids.forEach(adminId => {
        bot.sendMessage(adminId, `💰 New withdrawal request\nUser: ${user.phone || user.telegram_id}\nAmount: ₦${amount.toFixed(2)}\nDetails: ${details}\nCommands: /approve ${user.phone || user.telegram_id}  OR /reject ${user.phone || user.telegram_id}`);
      });

      return bot.sendMessage(chatId, langText(userLang, 'withdraw_received'));
    }

    if (text === "📊 My Stats") {
      return bot.sendMessage(chatId, langText(userLang, 'stats', user.total_waste || 0, user.balance || 0));
    }

    if (text === "📩 Contact Admin") {
      // forwards user's message to all admins (simulate)
      const settings3 = loadSettings();
      settings3.admin_ids.forEach(adminId => {
        bot.sendMessage(adminId, `📩 Contact from ${user.phone || user.telegram_id} (${user.first_name || 'unknown'}):\nYou can reply with /msg ${user.telegram_id} <text> to message them.`);
      });
      return bot.sendMessage(chatId, '✅ Your message was forwarded to admins.');
    }

    if (text === "🛠 Admin Panel" && settings.admin_ids.includes(chatId)) {
      return bot.sendMessage(chatId, langText(userLang, 'admin_panel'));
    }

    // fallback
    return bot.sendMessage(chatId, langText(userLang, 'unknown_command'));
  });

  // Admin-only commands
  bot.onText(/\/users/, (msg) => {
    const chatId = msg.chat.id;
    const settings = loadSettings();
    if (!settings.admin_ids.includes(chatId)) return bot.sendMessage(chatId, LANG_STRINGS.en.not_admin);
    const users = loadUsers();
    const list = users.map(u => `${u.phone || 'unknown'} - ₦${(u.balance||0).toFixed(2)} - verified:${u.verified}`).join('\n') || 'No users yet.';
    bot.sendMessage(chatId, `👥 Users:\n${list}`);
  });

  // approve / reject withdraw
  bot.onText(/\/approve (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const target = match[1].trim();
    const settings = loadSettings();
    if (!settings.admin_ids.includes(chatId)) return bot.sendMessage(chatId, LANG_STRINGS.en.not_admin);

    let users = loadUsers();
    let user = users.find(u => String(u.phone) === target || String(u.telegram_id) === target || (u.phone && u.phone.endsWith(target)));
    if (!user) return bot.sendMessage(chatId, 'User not found');

    // find pending withdrawal
    const pw = (user.pending_withdrawals || []).find(w => w.status === 'pending');
    if (!pw) return bot.sendMessage(chatId, 'No pending withdrawal found for this user.');
    pw.status = 'approved';
    pw.processed_by = chatId;
    pw.processed_at = new Date().toISOString();

    // simulate payout: clear balance
    user.balance = 0;
    saveUsers(users);

    // notify user
    bot.sendMessage(user.telegram_id, `✅ Your withdrawal of ₦${pw.amount.toFixed(2)} has been approved by admin.`);
    bot.sendMessage(chatId, `✅ Approved and paid: ₦${pw.amount.toFixed(2)}`);
  });

  bot.onText(/\/reject (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const target = match[1].trim();
    const settings = loadSettings();
    if (!settings.admin_ids.includes(chatId)) return bot.sendMessage(chatId, LANG_STRINGS.en.not_admin);

    let users = loadUsers();
    let user = users.find(u => String(u.phone) === target || String(u.telegram_id) === target || (u.phone && u.phone.endsWith(target)));
    if (!user) return bot.sendMessage(chatId, 'User not found');

    const pw = (user.pending_withdrawals || []).find(w => w.status === 'pending');
    if (!pw) return bot.sendMessage(chatId, 'No pending withdrawal found for this user.');
    pw.status = 'rejected';
    pw.processed_by = chatId;
    pw.processed_at = new Date().toISOString();
    saveUsers(users);

    bot.sendMessage(user.telegram_id, `❌ Your withdrawal request of ₦${pw.amount.toFixed(2)} has been rejected by admin.`);
    bot.sendMessage(chatId, `❌ Rejected withdrawal of ₦${pw.amount.toFixed(2)}`);
  });

  // toggle feature
  bot.onText(/\/feature (.+) (on|off)/i, (msg, match) => {
    const chatId = msg.chat.id;
    const settings = loadSettings();
    if (!settings.admin_ids.includes(chatId)) return bot.sendMessage(chatId, LANG_STRINGS.en.not_admin);
    const feature = match[1].trim();
    const value = match[2].toLowerCase() === 'on';
    if (!settings.features.hasOwnProperty(feature)) return bot.sendMessage(chatId, `Feature '${feature}' not found.`);
    settings.features[feature] = value;
    saveSettings(settings);
    bot.sendMessage(chatId, `Feature ${feature} set to ${value ? 'ON' : 'OFF'}`);
  });

  // admin send message to user: /msg <tgId> <text>
  bot.onText(/\/msg (\d+)\s+([\s\S]+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const settings = loadSettings();
    if (!settings.admin_ids.includes(chatId)) return bot.sendMessage(chatId, LANG_STRINGS.en.not_admin);
    const targetId = parseInt(match[1], 10);
    const text = match[2];
    bot.sendMessage(targetId, `📣 Message from Admin:\n${text}`).then(() => {
      bot.sendMessage(chatId, 'Message sent.');
    }).catch((e) => {
      bot.sendMessage(chatId, `Failed to send message: ${e.message || e}`);
    });
  });

  // Add admin via env if present and not existed
  const settings = loadSettings();
  const adminIdsFromEnv = ADMIN_TELEGRAM_ID ? ADMIN_TELEGRAM_ID.split(',').map(s => Number(s.trim())).filter(Boolean) : [];
  const missingAdmins = adminIdsFromEnv.filter(id => !settings.admin_ids.includes(id));
  if (missingAdmins.length) {
    settings.admin_ids = Array.from(new Set([...(settings.admin_ids || []), ...adminIdsFromEnv]));
    saveSettings(settings);
  }

  bot.on("polling_error", (err) => {
    console.error("Polling error:", err && err.code ? JSON.stringify(err) : err);
  });

  console.log('🤖 Bot started successfully...');
}

// If bot not started (no TELEGRAM_TOKEN) still keep process alive; express is running.
