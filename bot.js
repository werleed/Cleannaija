// bot.js
require('dotenv').config();

const fs = require('fs');
const fsExtra = require('fs-extra');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const twilio = require('twilio');
const axios = require('axios');

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
  console.warn('⚠️ Twilio credentials missing — OTP features will not work until provided.');
}

// --- Paths and ensure dirs/files ---
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

// --- Storage helpers ---
const loadJSON = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8') || 'null') || {};
  } catch (e) {
    console.error('Failed to read JSON', p, e);
    return {};
  }
};
const saveJSON = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');

const loadUsers = () => {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '[]');
  } catch (e) {
    console.error('loadUsers error', e);
    return [];
  }
};
const saveUsers = (arr) => fs.writeFileSync(USERS_FILE, JSON.stringify(arr, null, 2), 'utf8');

// --- Twilio client (safe init) ---
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  } catch (e) {
    console.error('Failed to init Twilio client', e);
    twilioClient = null;
  }
}

// --- Telegram bot (polling) ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// --- Multi-language messages (basic translations) ---
// Languages: en, fr, ha (Hausa), yo (Yoruba), ak (Akan/Twi)
const MESSAGES = {
  en: {
    welcome_unverified: (name) => `👋 Welcome ${name || ''}!\nPlease verify your phone number first.\nYou can share your contact or type your phone number.`,
    otp_sent: (phone) => `📨 Verification code sent to ${phone}. Reply with the 4-6 digit code.`,
    otp_failed: `❌ Failed to send OTP. Please check Twilio credentials or try again later.`,
    verified_ok: `✅ Phone number verified successfully! Use /menu to continue.`,
    already_verified: `✅ You're already verified! Use /menu to continue.`,
    need_verify: `⚠️ Please verify your phone first using /start`,
    main_menu: `Main Menu:`,
    recorded: (kg, naira) => `✅ Recorded ${kg}kg waste.\nYou earned ₦${naira.toFixed(2)}! 💸`,
    min_withdraw: `⚠️ Minimum withdrawal is ₦1000.`,
    withdraw_received: `✅ Withdrawal request received. Admin will process it soon!`,
    stats: (total, balance) => `📈 Total Waste: ${total}kg\n💰 Balance: ₦${balance.toFixed(2)}`,
    ai_reply: (name) => `Hi ${name || ''}! 👋 I can help you scan waste, check your balance, or withdraw earnings. Type /menu to see options.`,
    detected_country: (c) => `🌍 Detected country: ${c}`
  },
  fr: {
    welcome_unverified: (name) => `👋 Bienvenue ${name || ''} !\nVeuillez vérifier votre numéro de téléphone d'abord.`,
    otp_sent: (phone) => `📨 Code envoyé à ${phone}. Répondez avec le code.`,
    otp_failed: `❌ Échec de l'envoi de l'OTP.`,
    verified_ok: `✅ Téléphone vérifié ! Utilisez /menu pour continuer.`,
    already_verified: `✅ Déjà vérifié ! Utilisez /menu.`,
    need_verify: `⚠️ Veuillez vérifier votre téléphone avec /start`,
    main_menu: `Menu Principal:`,
    recorded: (kg, naira) => `✅ ${kg}kg enregistré.\nVous avez gagné ₦${naira.toFixed(2)} !`,
    min_withdraw: `⚠️ Retrait minimum ₦1000.`,
    withdraw_received: `✅ Demande de retrait reçue.`,
    stats: (total, balance) => `📈 Total: ${total}kg\n💰 Solde: ₦${balance.toFixed(2)}`,
    ai_reply: (name) => `Salut ${name || ''} ! Je peux vous aider à scanner des déchets, vérifier le solde ou retirer des fonds. /menu`,
    detected_country: (c) => `🌍 Pays détecté : ${c}`
  },
  ha: {
    welcome_unverified: (name) => `👋 Barka da zuwa ${name || ''}!\nDa fatan za a tabbatar da lambar wayarka.`,
    otp_sent: (phone) => `📨 An aika lambar tabbatarwa zuwa ${phone}.`,
    otp_failed: `❌ Aika OTP ya gagara.`,
    verified_ok: `✅ An tabbatar da wayarka! Yi amfani da /menu.`,
    already_verified: `✅ An riga an tabbatar!`,
    need_verify: `⚠️ Da fatan za a tabbatar da wayarka da /start`,
    main_menu: `Babban Menu:`,
    recorded: (kg, naira) => `✅ An adana ${kg}kg.\nKa samu ₦${naira.toFixed(2)}!`,
    min_withdraw: `⚠️ Akalla ₦1000 ne za a iya cirewa.`,
    withdraw_received: `✅ An karbi bukatar cire kudi.`,
    stats: (total, balance) => `📈 Jimlar Shara: ${total}kg\n💰 Ma'auni: ₦${balance.toFixed(2)}`,
    ai_reply: (name) => `Sannu ${name || ''}! Zan iya taimaka maka wajen duba /menu.`,
    detected_country: (c) => `🌍 Kasar da aka gano: ${c}`
  },
  yo: {
    welcome_unverified: (name) => `👋 Kaabo ${name || ''}!\nJowo jẹrisi nọmba foonu rẹ kọ́kọ́.`,
    otp_sent: (phone) => `📨 A fi koodu ranṣẹ si ${phone}.`,
    otp_failed: `❌ Koodu OTP ko ṣiṣẹ.`,
    verified_ok: `✅ A ti jẹrisi foonu! Lo /menu.`,
    already_verified: `✅ A ti jẹrisi rẹ tẹlẹ!`,
    need_verify: `⚠️ Jọwọ jẹrisi foonu rẹ pẹlu /start`,
    main_menu: `Ibi Akojọ:`,
    recorded: (kg, naira) => `✅ A gba ${kg}kg.\nO jo'owo ₦${naira.toFixed(2)}!`,
    min_withdraw: `⚠️ O kere ju ₦1000 lati yọkuro.`,
    withdraw_received: `✅ A gba ibeere yiyọkuro.`,
    stats: (total, balance) => `📈 Apapọ: ${total}kg\n💰 Iṣura: ₦${balance.toFixed(2)}`,
    ai_reply: (name) => `Bawo ${name || ''}! Mo le ran o lowo. /menu`,
    detected_country: (c) => `🌍 Orilẹ-ede to rii: ${c}`
  },
  ak: { // Akan / Twi (basic)
    welcome_unverified: (name) => `👋 Akwaaba ${name || ''}!\nMepa wo kyɛw, kyerɛw wo phone.`,
    otp_sent: (phone) => `📨 Code somaa kɔ ${phone}.`,
    otp_failed: `❌ OTP sending failed.`,
    verified_ok: `✅ Phone aye! Fa /menu so.`,
    already_verified: `✅ Wo ho akyerew dada!`,
    need_verify: `⚠️ Fa /start na yɛ verification`,
    main_menu: `Main Menu:`,
    recorded: (kg, naira) => `✅ ${kg}kg akyerɛw.\nW'anya ₦${naira.toFixed(2)}!`,
    min_withdraw: `⚠️ Minimum withdrawal ₦1000.`,
    withdraw_received: `✅ Withdrawal request adɔ.`,
    stats: (total, balance) => `📈 Total: ${total}kg\n💰 Balance: ₦${balance.toFixed(2)}`,
    ai_reply: (name) => `Hi ${name || ''}! Me betumi aboa wo. /menu`,
    detected_country: (c) => `🌍 Country detected: ${c}`
  }
};

const langFor = (user) => (user && user.language) || loadJSON(SETTINGS_FILE).language_default || 'en';
const message = (key, user, ...args) => {
  const lang = langFor(user);
  const msg = (MESSAGES[lang] && MESSAGES[lang][key]) || MESSAGES['en'][key];
  if (typeof msg === 'function') return msg(...args);
  return msg || '';
};

// --- Startup logs ---
console.log(new Date().getFullYear(), 'Starting in POLLING mode.');
console.log('🤖 Bot started successfully...');

// --- Helper: detect country from phone or telegram language_code ---
function detectCountryFromPhone(phone) {
  if (!phone) return null;
  // Normalize + and no spaces
  const p = String(phone).replace(/\s+/g, '');
  if (p.startsWith('+234') || p.startsWith('234')) return { code: 'NG', name: 'Nigeria 🇳🇬' };
  if (p.startsWith('+233') || p.startsWith('233')) return { code: 'GH', name: 'Ghana 🇬🇭' };
  if (p.startsWith('+1')) return { code: 'US', name: 'United States 🇺🇸' };
  if (p.startsWith('+44')) return { code: 'GB', name: 'United Kingdom 🇬🇧' };
  return null;
}
function detectCountryFallback(from) {
  // from.language_code like 'en', 'fr', or 'en-gb'
  if (!from) return null;
  const lang = (from.language_code || '').toLowerCase();
  if (lang.startsWith('fr')) return { code: 'FR', name: 'France/Francophone' };
  if (lang.startsWith('en')) return { code: 'EN', name: 'English' };
  return null;
}

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

  // Country detection from previous phone or from msg.from
  const country = detectCountryFromPhone(user.phone) || detectCountryFallback(msg.from) || null;
  if (country) {
    bot.sendMessage(chatId, message('detected_country', user, country.name));
  }

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

// --- contact share handler (user shares phone) ---
bot.on('contact', async (msg) => {
  const chatId = msg.chat.id;
  const phone = msg.contact && msg.contact.phone_number;
  if (!phone) return bot.sendMessage(chatId, "Invalid contact received.");

  const users = loadUsers();
  const user = users.find(u => u.telegram_id === chatId);
  if (!user) return bot.sendMessage(chatId, "Please /start first.");

  user.phone = phone;
  user.awaiting_otp = true;
  saveUsers(users);

  // send OTP
  if (!twilioClient) {
    bot.sendMessage(chatId, message('otp_failed', user));
    console.error('Twilio client not initialized - cannot send OTP.');
    return;
  }

  try {
    const resp = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
      .verifications.create({ to: phone, channel: 'sms' });
    console.log('Twilio verification create response:', resp && resp.sid);
    bot.sendMessage(chatId, message('otp_sent', user, phone));
  } catch (err) {
    console.error('Twilio send OTP error:', err && err.message ? err.message : err);
    bot.sendMessage(chatId, `${message('otp_failed', user)}\n\n(${err && err.message ? err.message : 'unknown error'})`);
  }
});

// --- message handler: OTP, menu actions & flows ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  // ignore contact messages here (handled earlier)
  if (msg.contact) return;

  let users = loadUsers();
  let user = users.find(u => u.telegram_id === chatId);

  // Create default user if missing
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

  // If expecting OTP and message looks like 4-6 digits
  if (user.awaiting_otp && /^\d{4,6}$/.test(text)) {
    if (!twilioClient) {
      bot.sendMessage(chatId, message('otp_failed', user));
      return;
    }
    try {
      const check = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
        .verificationChecks.create({ to: user.phone, code: text });
      console.log('verificationChecks result:', check && check.status);
      if (check && check.status === 'approved') {
        user.verified = true;
        user.awaiting_otp = false;
        saveUsers(users);
        bot.sendMessage(chatId, message('verified_ok', user));
      } else {
        bot.sendMessage(chatId, "❌ Invalid code. Try again.");
      }
    } catch (err) {
      console.error('Twilio verify error:', err && err.message ? err.message : err);
      bot.sendMessage(chatId, "⚠️ Verification failed. Please try again later.");
    }
    return;
  }

  // If user is sending a phone number manually (very simple check)
  if (!user.verified && loadJSON(SETTINGS_FILE).verification_enabled && /^\+?\d{7,15}$/.test(text)) {
    user.phone = text;
    user.awaiting_otp = true;
    saveUsers(users);

    if (!twilioClient) {
      bot.sendMessage(chatId, message('otp_failed', user));
      return;
    }
    try {
      const resp = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
        .verifications.create({ to: text, channel: 'sms' });
      console.log('Twilio verification create response (manual):', resp && resp.sid);
      bot.sendMessage(chatId, message('otp_sent', user, text));
    } catch (err) {
      console.error('Twilio send OTP error:', err && err.message ? err.message : err);
      bot.sendMessage(chatId, `${message('otp_failed', user)}\n\n(${err && err.message ? err.message : 'unknown error'})`);
    }
    return;
  }

  // Accept only verified users for the rest of flows
  if (!user.verified && loadJSON(SETTINGS_FILE).verification_enabled) {
    return bot.sendMessage(chatId, message('need_verify', user));
  }

  // Handle uploads (photos)
  if (msg.photo && msg.photo.length) {
    // Save highest resolution photo
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    try {
      const filePath = await bot.getFileLink(fileId);
      // fetch and save file to uploads using axios
      const response = await axios.get(filePath, { responseType: 'arraybuffer', timeout: 20000 });
      const filename = `upload_${chatId}_${Date.now()}.jpg`;
      const fullPath = path.join(UPLOADS_DIR, filename);
      fs.writeFileSync(fullPath, response.data);
      user.awaiting_waste = true;
      user.last_upload = filename;
      saveUsers(users);
      bot.sendMessage(chatId, `📸 Photo saved as ${filename}. Please reply with the weight in KG (e.g. 2.5).`);
    } catch (err) {
      console.error('Failed to save image', err && err.message ? err.message : err);
      bot.sendMessage(chatId, "❌ Failed to process the photo. Please try again or send weight manually.");
    }
    return;
  }

  // If expecting weight input after upload or scan
  if (user.awaiting_waste && /^\d+(\.\d+)?$/.test(text)) {
    const weight = parseFloat(text);
    const amount = weight * 120; // simulation ₦120 per kg
    user.total_waste = (user.total_waste || 0) + weight;
    user.balance = (user.balance || 0) + amount;
    user.awaiting_waste = false;
    saveUsers(users);
    bot.sendMessage(chatId, message('recorded', user, weight, amount));
    return;
  }

  // Menu commands & quick buttons
  if (text === '/menu' || text.toLowerCase() === 'menu') {
    const buttons = [
      [{ text: "♻️ Scan Waste" }],
      [{ text: "💰 Withdraw" }],
      [{ text: "📊 My Stats" }],
      [{ text: "🔁 Change Language" }]
    ];
    // Admin button (kept as a menu option but admin still uses commands)
    if (ADMIN_TELEGRAM_ID && ADMIN_TELEGRAM_ID === chatId) {
      buttons.push([{ text: "🛠 Admin Panel" }]);
    }
    return bot.sendMessage(chatId, message('main_menu', user), {
      reply_markup: { keyboard: buttons, resize_keyboard: true }
    });
  }

  // User chooses Scan Waste
  if (text === "♻️ Scan Waste") {
    user.awaiting_waste = true;
    saveUsers(users);
    return bot.sendMessage(chatId, "📸 Send a photo of your waste or type the weight in KG (e.g. 1.5).");
  }

  // Withdraw
  if (text === "💰 Withdraw") {
    if (!loadJSON(SETTINGS_FILE).withdrawals_enabled) {
      return bot.sendMessage(chatId, "Withdrawals are temporarily disabled by admin.");
    }
    if ((user.balance || 0) < 1000) {
      return bot.sendMessage(chatId, message('min_withdraw', user));
    }
    user.awaiting_withdraw = true;
    saveUsers(users);
    return bot.sendMessage(chatId, `💳 Your balance is ₦${(user.balance || 0).toFixed(2)}.\nPlease send your payout details (account number / bank).`);
  }

  // Handle withdrawal details
  if (user.awaiting_withdraw) {
    user.awaiting_withdraw = false;
    const payoutInfo = text;
    // Store pending request in user object
    user.pending_withdrawal = {
      amount: user.balance,
      info: payoutInfo,
      requested_at: new Date().toISOString(),
      status: 'pending'
    };
    saveUsers(users);
    bot.sendMessage(chatId, message('withdraw_received', user));
    // notify admin(s)
    if (ADMIN_TELEGRAM_ID) {
      bot.sendMessage(ADMIN_TELEGRAM_ID, `💰 New withdrawal request:\nUser: ${user.phone || user.telegram_id}\nAmount: ₦${user.balance}\nDetails: ${payoutInfo}\nTo /approve or /reject use: /approve ${user.telegram_id} or /reject ${user.telegram_id}`);
    }
    return;
  }

  // My Stats
  if (text === "📊 My Stats") {
    return bot.sendMessage(chatId, message('stats', user, user.total_waste || 0, user.balance || 0));
  }

  // Admin Panel (simple)
  if (text === "🛠 Admin Panel" && ADMIN_TELEGRAM_ID && ADMIN_TELEGRAM_ID === chatId) {
    return bot.sendMessage(chatId, "🧰 Admin Panel:\n/approve <userId> - approve withdrawal\n/reject <userId> - reject withdrawal\n/broadcast <msg> - message all verified users\n/toggle_verification - toggle verification system\n/toggle_withdrawals - toggle withdrawals system\n/users - list users");
  }

  // /users - admin only
  if (text.startsWith('/users') && ADMIN_TELEGRAM_ID && ADMIN_TELEGRAM_ID === chatId) {
    const all = loadUsers();
    const list = all.map(u => `${u.telegram_id} | ${u.phone || 'nophone'} | ₦${(u.balance||0).toFixed(2)} | verified:${u.verified}`).slice(0,200).join('\n');
    return bot.sendMessage(chatId, `👥 Users:\n${list || 'No users yet.'}`);
  }

  // /approve <id>
  if (text.startsWith('/approve') && ADMIN_TELEGRAM_ID && ADMIN_TELEGRAM_ID === chatId) {
    const parts = text.split(/\s+/);
    const uid = parts[1];
    if (!uid) return bot.sendMessage(chatId, 'Usage: /approve <telegramId>');
    let all = loadUsers();
    const u = all.find(x => String(x.telegram_id) === String(uid));
    if (!u || !u.pending_withdrawal) return bot.sendMessage(chatId, 'No pending withdrawal for that user.');
    u.pending_withdrawal.status = 'approved';
    u.balance = 0;
    saveUsers(all);
    bot.sendMessage(chatId, `✅ Withdrawal for ${uid} approved.`);
    bot.sendMessage(u.telegram_id, `💸 Your withdrawal for ₦${u.pending_withdrawal.amount} has been APPROVED by admin.`);
    return;
  }

  // /reject <id>
  if (text.startsWith('/reject') && ADMIN_TELEGRAM_ID && ADMIN_TELEGRAM_ID === chatId) {
    const parts = text.split(/\s+/);
    const uid = parts[1];
    if (!uid) return bot.sendMessage(chatId, 'Usage: /reject <telegramId>');
    let all = loadUsers();
    const u = all.find(x => String(x.telegram_id) === String(uid));
    if (!u || !u.pending_withdrawal) return bot.sendMessage(chatId, 'No pending withdrawal for that user.');
    u.pending_withdrawal.status = 'rejected';
    saveUsers(all);
    bot.sendMessage(chatId, `❌ Withdrawal for ${uid} rejected.`);
    bot.sendMessage(u.telegram_id, `❌ Your withdrawal for ₦${u.pending_withdrawal.amount} has been REJECTED by admin.`);
    return;
  }

  // /broadcast message
  if (text.startsWith('/broadcast') && ADMIN_TELEGRAM_ID && ADMIN_TELEGRAM_ID === chatId) {
    const bmsg = text.replace('/broadcast', '').trim();
    if (!bmsg) return bot.sendMessage(chatId, 'Usage: /broadcast <message>');
    const all = loadUsers().filter(u => u.verified);
    let success = 0;
    for (const u of all) {
      try {
        await bot.sendMessage(u.telegram_id, `📢 Broadcast from Admin:\n\n${bmsg}`);
        success++;
      } catch (e) {
        console.error('Broadcast send failed to', u.telegram_id, e && e.message ? e.message : e);
      }
    }
    return bot.sendMessage(chatId, `Broadcast sent to ${success}/${all.length} verified users.`);
  }

  // toggles
  if (text === '/toggle_verification' && ADMIN_TELEGRAM_ID && ADMIN_TELEGRAM_ID === chatId) {
    let settings = loadJSON(SETTINGS_FILE);
    settings.verification_enabled = !settings.verification_enabled;
    saveJSON(SETTINGS_FILE, settings);
    return bot.sendMessage(chatId, `Verification toggled: ${settings.verification_enabled}`);
  }
  if (text === '/toggle_withdrawals' && ADMIN_TELEGRAM_ID && ADMIN_TELEGRAM_ID === chatId) {
    let settings = loadJSON(SETTINGS_FILE);
    settings.withdrawals_enabled = !settings.withdrawals_enabled;
    saveJSON(SETTINGS_FILE, settings);
    return bot.sendMessage(chatId, `Withdrawals toggled: ${settings.withdrawals_enabled}`);
  }

  // change language simple flow
  if (text === '🔁 Change Language') {
    return bot.sendMessage(chatId, 'Select language:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'English', callback_data: 'lang_en' }],
          [{ text: 'Français', callback_data: 'lang_fr' }],
          [{ text: 'Hausa', callback_data: 'lang_ha' }],
          [{ text: 'Yoruba', callback_data: 'lang_yo' }],
          [{ text: 'Akan (Twi)', callback_data: 'lang_ak' }]
        ]
      }
    });
  }

  // AI-like friendly fallback for casual/unknown messages
  // keep it simple and helpful (no external AI calls)
  const lowered = text.toLowerCase();
  if (['hi', 'hello', 'hey', 'hola', 'bonjour', 'sannu'].includes(lowered) || lowered.includes('how are')) {
    return bot.sendMessage(chatId, message('ai_reply', user, msg.from && msg.from.first_name));
  }

  // otherwise ignore silently (or you can send a polite fallback)
  return; // no reply for other messages by default
});

// callback queries for inline buttons (language selection)
bot.on('callback_query', (q) => {
  const chatId = q.from.id;
  const data = q.data;
  let users = loadUsers();
  const user = users.find(u => u.telegram_id === chatId);
  if (!user) {
    bot.answerCallbackQuery(q.id, { text: 'User not found' });
    return;
  }

  if (data && data.startsWith('lang_')) {
    const lng = data.split('_')[1];
    user.language = lng;
    saveUsers(users);
    bot.answerCallbackQuery(q.id, { text: `Language set to ${lng}` });
    bot.sendMessage(chatId, `Language updated.`);
  } else {
    bot.answerCallbackQuery(q.id, { text: 'Unknown action' });
  }
});

// --- Express server for health / keep-alive (Railway) ---
const app = express();
app.get('/', (req, res) => res.send('🤖 Bot is live and healthy!'));
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // Periodic self-ping to keep container alive on Railway
  setInterval(() => {
    axios.get(`http://localhost:${PORT}/health`, { timeout: 5000 })
      .then(() => console.log('✅ Keep-alive ping sent'))
      .catch((err) => console.log('⚠️ Keep-alive failed:', err && err.message ? err.message : err));
  }, 240000); // every 4 minutes
});

// --- graceful shutdown ---
const shutDown = async () => {
  console.log('Shutting down...');
  try {
    await bot.stopPolling();
  } catch (e) { /* ignore */ }
  try { server.close(); } catch (e) { /* ignore */ }
  process.exit(0);
};
process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);

// --- global error handlers ---
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
