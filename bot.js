
// bot.js - Clean Naija Bot (CommonJS)
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');
const twilio = require('twilio');

// === Config & environment ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID;
const ADMIN_ENV = process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_TELEGRAM; // legacy names

// Parse admin IDs (comma-separated)
const ADMINS = (ADMIN_ENV || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => Number(s))
  .filter(n => !Number.isNaN(n));

// === Safety checks (clear messaging, avoid crashing with obscure errors) ===
const missing = [];
if (!TELEGRAM_TOKEN) missing.push('TELEGRAM_TOKEN or BOT_TOKEN');
if (!TWILIO_ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID');
if (!TWILIO_AUTH_TOKEN) missing.push('TWILIO_AUTH_TOKEN');
if (!TWILIO_VERIFY_SID) missing.push('TWILIO_VERIFY_SID');
if (!ADMINS.length) missing.push('ADMIN_TELEGRAM_ID (at least one admin)');

if (missing.length) {
  console.error('❌ Missing environment variables:');
  missing.forEach(m => console.error('  •', m));
  console.error('\nPlease add them to Railway / your environment and restart the container.');
  console.error('Examples (Railway): TELEGRAM_TOKEN, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID, ADMIN_TELEGRAM_ID');
  // exit so the bot doesn't spin with hard-to-understand errors (you'll see this in logs)
  process.exit(1);
}

// === Twilio client ===
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// === Data paths & auto-create ===
const ROOT = path.join(__dirname);
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// ensure directories & files exist
fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(UPLOADS_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeJsonSync(USERS_FILE, []);

// helper to read & write users
const loadUsers = () => {
  try { return fs.readJsonSync(USERS_FILE); }
  catch (e) { return []; }
};
const saveUsers = (u) => fs.writeJsonSync(USERS_FILE, u, { spaces: 2 });
const findUser = (telegramId) => loadUsers().find(x => x.telegram_id === telegramId);

// === Languages ===
const LANGS = ['en','ha','yo','ig']; // english, hausa, yoruba, igbo
const M = {
  en: {
    start_welcome: name => `👋 Welcome ${name || ''}!\nPlease verify your phone number before using the bot.\nYou can either:\n1️⃣ Send your Telegram contact\n2️⃣ Or type your phone number manually`,
    send_contact_button: '📱 Share My Number',
    otp_sent: phone => `📨 Verification code sent to ${phone}. Please reply with the 6-digit code.`,
    otp_success: '✅ Phone number verified successfully! Type /menu to start.',
    otp_fail: '❌ Invalid code. Try again.',
    otp_error: '⚠️ Verification failed. Please try again later.',
    already_verified: '✅ You’re already verified! Use /menu to continue.',
    menu_prompt: 'Main Menu:',
    ask_photo_or_weight: '📸 Send a photo of your waste (upload) or type the weight in KG:',
    weight_recorded: (w, amount) => `✅ Recorded ${w}kg waste.\nYou earned ₦${amount.toFixed(2)}! 💸`,
    min_withdraw: '⚠️ Minimum withdrawal is ₦1000.',
    withdraw_received: '✅ Withdrawal request received. Admin will process it soon!',
    stats: (w, bal) => `📈 Total Waste: ${w}kg\n💰 Balance: ₦${bal.toFixed(2)}`,
    admin_panel: '🧰 Admin Panel:\n/users - View users\n/approve <phone> - Approve withdrawal\n/reset - Reset all data\n/broadcast <msg> - Broadcast message\n/uploads - List uploads',
    not_admin: '⚠️ You are not an admin.',
    bad_number: '⚠️ Please send a valid phone number including country code. e.g. +23480xxxxxxx',
    upload_saved: filename => `✅ Photo received and saved as ${filename}. Please send weight in KG to complete scan.`,
    set_lang: lang => `Language set to ${lang}.`,
    unknown_cmd: 'I did not understand that. Use /menu.'
  },
  ha: { /* Hausa translations (placeholders) */
    start_welcome: name => `Sannu ${name || ''}! Don Allah tabbatar da lambar wayarka...`,
    send_contact_button: '📱 Raba Lambata',
    otp_sent: phone => `An tura lambar tabbatarwa zuwa ${phone}.`,
    otp_success: '✅ An tabbatar da lambar wayarka!',
    otp_fail: '❌ Lambar bata dace ba.',
    otp_error: '⚠️ Kuskure wajen tabbatarwa. Gwada daga baya.',
    already_verified: '✅ An riga an tabbatar da kai! Yi amfani da /menu.',
    menu_prompt: 'Babban Zaɓi:',
    ask_photo_or_weight: '📸 Aika hoto ko rubuta nauyi a KG:',
    weight_recorded: (w, amount) => `✅ An rubuta ${w}kg.\nKa samu ₦${amount.toFixed(2)}! 💸`,
    min_withdraw: '⚠️ Mafi ƙarancin cirewa ₦1000.',
    withdraw_received: '✅ An karɓi buƙatar cire kuɗi. Admin zai duba.',
    stats: (w, bal) => `📈 Jimillar Shara: ${w}kg\n💰 Balans: ₦${bal.toFixed(2)}`,
    admin_panel: '🧰 Tsarin Admin:\n/users - Duba masu amfani\n/approve <phone> - Amince cirewa\n/reset - Share duk bayanai\n/broadcast <msg> - Aika sako\n/uploads - Duba uploads',
    not_admin: '⚠️ Ba kai admin bane.',
    bad_number: '⚠️ Rubuta lambobin da suka dace, misali +23480xxxxxxx',
    upload_saved: filename => `✅ An ajiye hoto: ${filename}. Aika nauyi don kammala.`,
    set_lang: lang => `An saita harshe zuwa ${lang}.`,
    unknown_cmd: 'Ban gane ba. Yi amfani da /menu.'
  },
  yo: {
    start_welcome: name => `Báwo ${name || ''}! Jọwọ jẹrisi nọmba foonu rẹ...`,
    send_contact_button: '📱 Pin Nọmbà mi',
    otp_sent: phone => `A ti ran koodu si ${phone}.`,
    otp_success: '✅ A ti jẹrisi nọmba foonu rẹ!',
    otp_fail: '❌ Koodu ko tọ.',
    otp_error: '⚠️ Aṣiṣe ninu ìfọwọsi. Gbiyanju lẹẹkansi.',
    already_verified: '✅ O ti jẹrisi! Lo /menu.',
    menu_prompt: 'Akoko Akojọ:',
    ask_photo_or_weight: '📸 Fi fọto ranṣẹ tabi kọ iwuwo ni KG:',
    weight_recorded: (w, amount) => `✅ A gba ${w}kg.\nO gba ₦${amount.toFixed(2)}! 💸`,
    min_withdraw: '⚠️ Iwọn yiyọ kere ju ₦1000.',
    withdraw_received: '✅ A gba ìbéèrè yiyọ. Admin yoo ṣe ilana.',
    stats: (w, bal) => `📈 Lapapọ Ilẹ: ${w}kg\n💰 Iwontunwonsi: ₦${bal.toFixed(2)}`,
    admin_panel: '🧰 Panel Admin:\n/users - Wo awọn olumulo\n/approve <phone> - Fọwọsi yiyọ\n/reset - Tún data ṣe\n/broadcast <msg> - Gbero ifiranṣẹ\n/uploads - Wo awọn uploads',
    not_admin: '⚠️ Iwọ kii ṣe admin.',
    bad_number: '⚠️ Jọwọ fi nọmba to pe pẹlu +234...',
    upload_saved: filename => `✅ A fi fọto pamọ gẹgẹbi ${filename}. Jowo fi iwuwo ranṣẹ.`,
    set_lang: lang => `A ṣeto ede si ${lang}.`,
    unknown_cmd: 'Mi o ye e. Lo /menu.'
  },
  ig: {
    start_welcome: name => `Nnọọ ${name || ''}! Biko jide nọmba ekwentị gị...`,
    send_contact_button: '📱 Kekọọ Nọmba m',
    otp_sent: phone => `Ezigbo! E zigara koodu na ${phone}.`,
    otp_success: '✅ A kwadoro nọmba ekwentị gị!',
    otp_fail: '❌ Koodu ezighi ezi.',
    otp_error: '⚠️ Nsogbu n\'ịlele. Biko nwaa ọzọ.',
    already_verified: '✅ I kwadoro! Jiri /menu.',
    menu_prompt: 'Isi Akwụkwọ:',
    ask_photo_or_weight: '📸 Zite foto ma ọ bụ tinye arọ na KG:',
    weight_recorded: (w, amount) => `✅ E debere ${w}kg.\nỊ nwetara ₦${amount.toFixed(2)}! 💸`,
    min_withdraw: '⚠️ Ọnụ ego kacha nta maka iwepụ bụ ₦1000.',
    withdraw_received: '✅ Arịrịọ iwepụ natara. Onye nchịkwa ga-ahụ ya.',
    stats: (w, bal) => `📈 Ngụkọta Ịkụcha: ${w}kg\n💰 Akpa ego: ₦${bal.toFixed(2)}`,
    admin_panel: '🧰 Nchịkwa Admin:\n/users - Lelee ndị ọrụ\n/approve <phone> - Kwenye iwepụ\n/reset - Hichapụ data\n/broadcast <msg> - Zipu ozi\n/uploads - Nlele uploads',
    not_admin: '⚠️ Ị bụghị admin.',
    bad_number: '⚠️ Biko tinye nọmba zuru ezu dị ka +23480xxxxxxx',
    upload_saved: filename => `✅ Foto echekwara dị ka ${filename}. Biko zipu ibu.`,
    set_lang: lang => `Asụsụ guzobere gaa ${lang}.`,
    unknown_cmd: 'Amaghị m nke a. Jiri /menu.'
  }
};

// default price per kg map (simulate)
const PRICE_PER_KG = 120; // ₦120/kg (simulation)

// utility: translate for a user
function t(user, key, ...args) {
  const lang = (user && user.lang) || 'en';
  const tpl = (M[lang] && M[lang][key]) || M['en'][key];
  return (typeof tpl === 'function') ? tpl(...args) : tpl;
}

// === Create Telegram bot ===
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// handler-safe wrapper so duplicate message handler uses don't conflict
bot.on('polling_error', (err) => {
  console.error('error: [polling_error]', err && (err.stack || err.message) || err);
});

// === /start command ===
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
      lang: 'en',
      awaiting_otp: false,
      awaiting_waste: false,
      awaiting_withdraw: false
    };
    users.push(user);
    saveUsers(users);
  }

  if (!user.verified) {
    const opts = {
      reply_markup: {
        keyboard: [[{ text: t(user,'send_contact_button'), request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    };
    return bot.sendMessage(chatId, t(user,'start_welcome')(msg.from && msg.from.first_name), opts);
  } else {
    return bot.sendMessage(chatId, t(user,'already_verified'));
  }
});

// === Language selector: /lang <code> ===
bot.onText(/\/lang (.+)/, (msg, match) => {
  const code = (match[1] || '').trim().toLowerCase();
  const chatId = msg.chat.id;
  const user = findUser(chatId);
  if (!user) return bot.sendMessage(chatId, 'Please /start first.');
  if (!LANGS.includes(code)) return bot.sendMessage(chatId, `Supported: ${LANGS.join(', ')}`);
  user.lang = code;
  saveUsers(loadUsers()); // save
  bot.sendMessage(chatId, t(user,'set_lang')(code));
});

// === /menu ===
bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  const user = findUser(chatId);
  if (!user || !user.verified) return bot.sendMessage(chatId, '⚠️ Please verify your phone first using /start');
  const buttons = [
    [{ text: '♻️ Scan Waste' }],
    [{ text: '💰 Withdraw' }],
    [{ text: '📊 My Stats' }],
    [{ text: '🌐 Change Language' }]
  ];
  if (ADMINS.includes(chatId)) buttons.push([{ text: '🛠 Admin Panel' }]);
  bot.sendMessage(chatId, t(user,'menu_prompt'), { reply_markup: { keyboard: buttons, resize_keyboard: true }});
});

// === handle contact share for phone verification ===
bot.on('contact', async (msg) => {
  const chatId = msg.chat.id;
  const phone = msg.contact && (msg.contact.phone_number || msg.contact.vcard);
  let user = findUser(chatId);
  if (!user) return;
  // normalize phone: Twilio expects e.g. +234...
  if (!phone || !/^\+/.test(phone)) {
    bot.sendMessage(chatId, t(user,'bad_number'));
    return;
  }
  user.phone = phone;
  user.awaiting_otp = true;
  saveUsers(loadUsers());

  try {
    await twilioClient.verify.v2.services(TWILIO_VERIFY_SID).verifications.create({ to: phone, channel: 'sms' });
    bot.sendMessage(chatId, t(user,'otp_sent')(phone));
  } catch (e) {
    console.error('Twilio send error', e && e.message || e);
    bot.sendMessage(chatId, t(user,'otp_error'));
  }
});

// === manual phone number input handling: if user sends +234... start OTP ===
bot.onText(/^\+?\d[\d\s()-]{6,}$/, async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const user = findUser(chatId);
  if (!user) return;
  // require + in number
  let phone = text.startsWith('+') ? text : '+' + text.replace(/\s+/g, '');
  user.phone = phone;
  user.awaiting_otp = true;
  saveUsers(loadUsers());
  try {
    await twilioClient.verify.v2.services(TWILIO_VERIFY_SID).verifications.create({ to: phone, channel: 'sms' });
    bot.sendMessage(chatId, t(user,'otp_sent')(phone));
  } catch (e) {
    console.error('Twilio send error', e && e.message || e);
    bot.sendMessage(chatId, t(user,'otp_error'));
  }
});

// === OTP verification: if user awaiting_otp and sends 6 digits ===
bot.on('message', async (msg) => {
  // NOTE: we use one message handler for OTP and for menu actions; early-exit if non-text or handled elsewhere
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const users = loadUsers();
  const user = users.find(u => u.telegram_id === chatId);
  if (!user) return;

  // if awaiting OTP and message is 6 digits
  if (user.awaiting_otp && /^\d{4,6}$/.test(text)) {
    try {
      const res = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
        .verificationChecks.create({ to: user.phone, code: text });
      if (res.status === 'approved') {
        user.verified = true;
        user.awaiting_otp = false;
        saveUsers(users);
        return bot.sendMessage(chatId, t(user,'otp_success'));
      } else {
        return bot.sendMessage(chatId, t(user,'otp_fail'));
      }
    } catch (e) {
      console.error('Twilio verify error', e && (e.stack || e.message) || e);
      return bot.sendMessage(chatId, t(user,'otp_error'));
    }
  }

  // language change prompt
  if (text === '🌐 Change Language') {
    const opts = {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'English', callback_data: 'lang_en' }, { text: 'Hausa', callback_data: 'lang_ha' }],
          [{ text: 'Yoruba', callback_data: 'lang_yo' }, { text: 'Igbo', callback_data: 'lang_ig' }]
        ]
      }
    };
    return bot.sendMessage(chatId, 'Choose language / Zaɓi harshe / Yan aṣayan èdè / Họrọ asụsụ', opts);
  }

  // handle menu buttons and flows (only if verified)
  if (!user.verified) return;

  // "Scan Waste" button
  if (text === '♻️ Scan Waste') {
    user.awaiting_waste = true;
    saveUsers(users);
    return bot.sendMessage(chatId, t(user,'ask_photo_or_weight'));
  }

  // withdrawing
  if (text === '💰 Withdraw') {
    if (user.balance < 1000) {
      return bot.sendMessage(chatId, t(user,'min_withdraw'));
    }
    user.awaiting_withdraw = true;
    saveUsers(users);
    return bot.sendMessage(chatId, `💳 Your balance: ₦${user.balance.toFixed(2)}\nPlease send your bank details/account for payout simulation.`);
  }

  // user provided weight while awaiting_waste
  if (user.awaiting_waste && /^\d+(\.\d+)?$/.test(text)) {
    const weight = parseFloat(text);
    const earned = weight * PRICE_PER_KG;
    user.total_waste = (user.total_waste || 0) + weight;
    user.balance = (user.balance || 0) + earned;
    user.awaiting_waste = false;
    saveUsers(users);
    return bot.sendMessage(chatId, t(user,'weight_recorded')(weight, earned));
  }

  // if awaiting_withdraw and user provided account details (any text) -> create request
  if (user.awaiting_withdraw) {
    const amount = user.balance;
    user.awaiting_withdraw = false;
    // For simulation we set balance 0 once request created
    user.balance = 0;
    saveUsers(users);
    bot.sendMessage(chatId, t(user,'withdraw_received'));
    // notify admins
    ADMINS.forEach(adminId => {
      bot.sendMessage(adminId, `💰 Withdrawal request\nUser: ${user.phone || 'unknown'}\nAmount: ₦${amount.toFixed(2)}\nAccount details: ${text}`);
    });
    return;
  }

  // My Stats
  if (text === '📊 My Stats') {
    return bot.sendMessage(chatId, t(user,'stats')(user.total_waste || 0, user.balance || 0));
  }

  // Admin Panel button
  if (text === '🛠 Admin Panel' && ADMINS.includes(chatId)) {
    return bot.sendMessage(chatId, t(user,'admin_panel'));
  }

  // unknown -> ignore or tell user
  if (text && !msg.photo && !msg.document) {
    // give a short hint
    return bot.sendMessage(chatId, t(user,'unknown_cmd'));
  }
});

// === photo/file uploads handler (used for offline "scan") ===
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const user = findUser(chatId);
  if (!user || !user.verified) return bot.sendMessage(chatId, 'Please verify first with /start');

  // choose highest resolution photo
  const photos = msg.photo || [];
  const photo = photos[photos.length - 1];
  if (!photo || !photo.file_id) return;

  try {
    const file = await bot.getFile(photo.file_id);
    const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;

    // fetch image bytes then save locally
    const res = await require('axios')({ url, method: 'GET', responseType: 'arraybuffer' });
    const timestamp = Date.now();
    const filename = `upload_${user.telegram_id}_${timestamp}.jpg`;
    const filepath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filepath, res.data);

    // mark user awaiting weight to complete scan
    user.awaiting_waste = true;
    saveUsers(loadUsers());
    bot.sendMessage(chatId, t(user,'upload_saved')(filename));
    // notify admins of new upload
    ADMINS.forEach(adminId => {
      bot.sendMessage(adminId, `📸 New upload by ${user.phone || user.telegram_id}\nFile: ${filename}`);
    });
  } catch (e) {
    console.error('photo handling error', e && e.message || e);
    bot.sendMessage(chatId, '⚠️ Failed to save upload. Try again.');
  }
});

// === Administrative commands ===

// /users - list users
bot.onText(/\/users/, (msg) => {
  if (!ADMINS.includes(msg.chat.id)) return bot.sendMessage(msg.chat.id, t({lang:'en'}, 'not_admin'));
  const users = loadUsers();
  if (!users.length) return bot.sendMessage(msg.chat.id, 'No users yet.');
  const list = users.map(u => `${u.phone || 'unknown'} — Verified: ${u.verified ? 'yes' : 'no'} — Balance: ₦${(u.balance||0).toFixed(2)}`).join('\n');
  bot.sendMessage(msg.chat.id, `👥 Users:\n${list}`);
});

// /reset - reset all user data
bot.onText(/\/reset/, (msg) => {
  if (!ADMINS.includes(msg.chat.id)) return bot.sendMessage(msg.chat.id, t({lang:'en'}, 'not_admin'));
  fs.writeJsonSync(USERS_FILE, []);
  bot.sendMessage(msg.chat.id, '🧹 All user data reset successfully.');
});

// /approve <phone> - admin approves withdrawal simulation
bot.onText(/\/approve (.+)/, (msg, match) => {
  if (!ADMINS.includes(msg.chat.id)) return bot.sendMessage(msg.chat.id, t({lang:'en'}, 'not_admin'));
  const phone = (match[1] || '').trim();
  const users = loadUsers();
  const u = users.find(x => x.phone === phone || String(x.telegram_id) === String(phone));
  if (!u) return bot.sendMessage(msg.chat.id, 'No user found with that phone/id.');
  // notify user
  bot.sendMessage(u.telegram_id, `✅ Your withdrawal has been approved by admin. Funds will be processed (simulation).`);
  bot.sendMessage(msg.chat.id, `Approved withdrawal request for ${phone}`);
});

// /broadcast <message>
bot.onText(/\/broadcast (.+)/, (msg, match) => {
  if (!ADMINS.includes(msg.chat.id)) return bot.sendMessage(msg.chat.id, t({lang:'en'}, 'not_admin'));
  const message = match[1];
  const users = loadUsers();
  users.forEach(u => {
    try { bot.sendMessage(u.telegram_id, `📣 Broadcast:\n${message}`); }
    catch (e) { /* ignore */ }
  });
  bot.sendMessage(msg.chat.id, 'Broadcast sent.');
});

// /uploads - list saved uploads for admin
bot.onText(/\/uploads/, (msg) => {
  if (!ADMINS.includes(msg.chat.id)) return bot.sendMessage(msg.chat.id, t({lang:'en'}, 'not_admin'));
  const files = fs.readdirSync(UPLOADS_DIR).slice(-50); // show latest 50
  if (!files.length) return bot.sendMessage(msg.chat.id, 'No uploads yet.');
  const list = files.map(f => `- ${f}`).join('\n');
  bot.sendMessage(msg.chat.id, `📁 Uploads:\n${list}`);
});

// callback queries from language inline keyboard
bot.on('callback_query', (q) => {
  const chatId = q.message.chat.id;
  const user = findUser(chatId) || { lang: 'en', telegram_id: chatId };
  const data = q.data || '';
  if (data.startsWith('lang_')) {
    const code = data.split('_')[1];
    if (LANGS.includes(code)) {
      user.lang = code;
      // persist if user exists
      const users = loadUsers();
      const idx = users.findIndex(u => u.telegram_id === chatId);
      if (idx >= 0) { users[idx].lang = code; saveUsers(users); }
      bot.sendMessage(chatId, t(user,'set_lang')(code));
    } else {
      bot.sendMessage(chatId, 'Unsupported language.');
    }
  }
  // always answer callback query
  bot.answerCallbackQuery(q.id).catch(()=>{});
});

// start message
console.log('🤖 Bot started successfully...');
