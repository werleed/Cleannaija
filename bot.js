// bot.js — Clean Naija Bot (complete)
require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { URL } = require('url');
const twilio = require('twilio');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const mime = require('mime-types');
const axios = require('axios');

// ----- Config / env -----
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN;
const ADMIN_TELEGRAM_ID = (process.env.ADMIN_TELEGRAM_ID || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // optional
const PORT = parseInt(process.env.PORT || '8080', 10) || 8080;

// quick checks
if (!TELEGRAM_TOKEN) {
  console.error('EFATAL: Telegram Bot Token not provided! Set TELEGRAM_TOKEN or BOT_TOKEN.');
}
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SID) {
  console.warn('⚠️ Twilio credentials missing. OTP will fail until set.');
}

// Twilio client (if credentials exist)
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  } catch (e) {
    console.error('⚠️ Failed to init Twilio client:', e.message);
    twilioClient = null;
  }
}

// ----- Data paths & ensure directories -----
const ROOT = path.resolve(__dirname);
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const LOGS_DIR = path.join(ROOT, 'logs');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const WITHDRAWALS_FILE = path.join(DATA_DIR, 'withdrawals.json');

fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(LOGS_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeJSONSync(USERS_FILE, []);
if (!fs.existsSync(WITHDRAWALS_FILE)) fs.writeJSONSync(WITHDRAWALS_FILE, []);

// ----- Helpers -----
const log = (...args) => {
  console.log(new Date().toISOString(), ...args);
};
const readUsers = () => {
  try { return fs.readJSONSync(USERS_FILE); } catch (e) { return []; }
};
const writeUsers = (u) => fs.writeJSONSync(USERS_FILE, u, { spaces: 2 });
const readWithdrawals = () => {
  try { return fs.readJSONSync(WITHDRAWALS_FILE); } catch (e) { return []; }
};
const writeWithdrawals = (w) => fs.writeJSONSync(WITHDRAWALS_FILE, w, { spaces: 2 });
const findUserByTelegram = (id) => readUsers().find(x => x.telegram_id === id);

// price per kg (configurable)
const PRICE_PER_KG = 120;

// languages (simple)
const LANGS = {
  en: { welcome: 'Welcome', startVerify: 'Please verify your phone number first', verified: 'Phone number verified successfully!', sendOTPFail: '❌ Failed to send OTP. Please check Twilio credentials or phone number.' },
  ha: { welcome: 'Barka', startVerify: 'Da fatan tabbatar da lambar wayarka', verified: 'An tabbatar da lambar waya!', sendOTPFail: '❌ An kasa aikawa da OTP. Duba siffar Twilio ko waya.' },
  yo: { welcome: 'Kaabo', startVerify: 'Jọwọ jẹrisi nọmba foonu rẹ', verified: 'A ti jẹrisi!', sendOTPFail: '❌ Ikuna lati firanṣẹ OTP. Ṣayẹwo Twilio tabi nọmba foonu.' },
  ig: { welcome: 'Nnọọ', startVerify: 'Biko gosi nọmba ekwentị gị', verified: 'Ekwentị ekwentị emetụtara!', sendOTPFail: '❌ Nwụcha izipu OTP. Lelee Twilio ma ọ bụ nọmba.' }
};
const defaultLang = 'en';

// ----- Telegram bot init (webhook or polling) -----
if (!TELEGRAM_TOKEN) process.exit(1);

let bot;
if (WEBHOOK_URL) {
  log('Starting in WEBHOOK mode. Will create express endpoint.');
  // For webhook we must set up an express server and pass the URL to bot
  const app = express();
  app.use(express.json());
  // create bot with polling: false
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false, filepath: false });

  // mount Telegram updates
  app.post(`/telegram/${TELEGRAM_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  app.get('/', (req, res) => res.send('Clean Naija Bot is running (webhook mode)'));

  // start server
  app.listen(PORT, async () => {
    const webhookEndpoint = new URL(WEBHOOK_URL);
    // ensure full path ends with our route
    const webhookUrl = `${webhookEndpoint.origin}/telegram/${TELEGRAM_TOKEN}`;
    try {
      await bot.setWebHook(webhookUrl);
      log('Webhook set to', webhookUrl);
    } catch (e) {
      log('Failed to set webhook:', e.message);
    }
    log(`Express server listening on port ${PORT}`);
  });
} else {
  log('Starting in POLLING mode.');
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
}

// ----- Safe wrapper to send messages -----
async function safeSend(chatId, ...args) {
  try { return await bot.sendMessage(chatId, ...args); }
  catch (e) { console.error('sendMessage error', e.message); }
}

// ----- Utility: normalize phone number to E.164 if possible -----
function normalizePhone(phone, defaultCountry = 'NG') {
  if (!phone) return null;
  try {
    const p = parsePhoneNumberFromString(phone, defaultCountry);
    if (p && p.isValid()) return p.number;
    // fallback: remove spaces and return if starts with + or digits
    const cleaned = phone.replace(/\s+/g, '');
    return cleaned.startsWith('+') ? cleaned : '+' + cleaned.replace(/[^0-9]/g, '');
  } catch (e) {
    return phone.replace(/\s+/g, '');
  }
}

// ----- Send OTP via Twilio Verify -----
async function sendOtp(toPhone) {
  if (!twilioClient) throw new Error('Twilio not configured');
  return twilioClient.verify.v2.services(TWILIO_VERIFY_SID).verifications.create({
    to: toPhone,
    channel: 'sms'
  });
}
async function checkOtp(toPhone, code) {
  if (!twilioClient) throw new Error('Twilio not configured');
  return twilioClient.verify.v2.services(TWILIO_VERIFY_SID).verificationChecks.create({
    to: toPhone,
    code
  });
}

// ----- Commands and handlers -----

// start / language selection
bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const name = msg.from && (msg.from.first_name || msg.from.username) ? (msg.from.first_name || msg.from.username) : 'there';
    let users = readUsers();
    let user = users.find(u => u.telegram_id === chatId);
    if (!user) {
      user = {
        telegram_id: chatId,
        verified: false,
        phone: null,
        balance: 0,
        total_waste: 0,
        lang: defaultLang
      };
      users.push(user);
      writeUsers(users);
    }
    const langButtons = [
      [{ text: 'English', callback_data: 'lang_en' }],
      [{ text: 'Hausa', callback_data: 'lang_ha' }],
      [{ text: 'Yoruba', callback_data: 'lang_yo' }],
      [{ text: 'Igbo', callback_data: 'lang_ig' }]
    ];
    await bot.sendMessage(chatId,
      `👋 ${LANGS[user.lang].welcome} ${name}!\n\n${LANGS[user.lang].startVerify}`,
      {
        reply_markup: {
          keyboard: [[{ text: "📱 Share My Number", request_contact: true }], [{ text: "Enter phone number manually" }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
    // Suggest language via inline keyboard as separate message
    await bot.sendMessage(chatId, `Choose language / Zaɓi yare / Yan yàn èdè / Họrọ asụsụ:`, {
      reply_markup: { inline_keyboard: langButtons }
    });
  } catch (e) {
    console.error('/start error', e);
  }
});

// language change via callback
bot.on('callback_query', async (q) => {
  try {
    const data = q.data || '';
    const chatId = q.message.chat.id;
    if (data.startsWith('lang_')) {
      const lang = data.split('_')[1];
      const users = readUsers();
      const user = users.find(u => u.telegram_id === chatId);
      if (user) { user.lang = LANGS[lang] ? lang : defaultLang; writeUsers(users); }
      await bot.answerCallbackQuery(q.id, { text: 'Language updated.' });
      await safeSend(chatId, `Language set to ${lang}`);
      return;
    }

    // withdrawal admin actions: approve/reject
    if (data.startsWith('withdraw_')) {
      // format: withdraw_<id>_approve or withdraw_<id>_reject
      const parts = data.split('_');
      const withdrawId = parts[1];
      const action = parts[2];
      if (!ADMIN_TELEGRAM_ID.includes(q.from.id)) {
        await bot.answerCallbackQuery(q.id, { text: 'Not authorized' });
        return;
      }
      const withdrawals = readWithdrawals();
      const w = withdrawals.find(x => x.id === withdrawId);
      if (!w) {
        await bot.answerCallbackQuery(q.id, { text: 'Request not found' });
        return;
      }
      if (action === 'approve') {
        w.status = 'approved';
        w.processed_by = q.from.id;
        w.processed_at = new Date().toISOString();
        writeWithdrawals(withdrawals);
        // notify user
        await safeSend(w.user_telegram_id, `💰 Your withdrawal of ₦${w.amount} has been *approved* by admin. We will process payment soon.`, { parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(q.id, { text: 'Approved' });
        await safeSend(q.from.id, `✅ You approved withdrawal ${withdrawId}`);
      } else {
        w.status = 'rejected';
        w.processed_by = q.from.id;
        w.processed_at = new Date().toISOString();
        writeWithdrawals(withdrawals);
        await safeSend(w.user_telegram_id, `❌ Your withdrawal of ₦${w.amount} was *rejected* by admin.`, { parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(q.id, { text: 'Rejected' });
        await safeSend(q.from.id, `✅ You rejected withdrawal ${withdrawId}`);
      }
      return;
    }

  } catch (e) {
    console.error('callback_query error', e);
  }
});

// contact share handler
bot.on('contact', async (msg) => {
  try {
    const phone = msg.contact && msg.contact.phone_number;
    const chatId = msg.chat.id;
    if (!phone) return safeSend(chatId, 'No phone provided.');
    const normalized = normalizePhone(phone);
    const users = readUsers();
    const user = users.find(u => u.telegram_id === chatId);
    if (!user) return safeSend(chatId, 'No user found. Use /start.');

    user.phone = normalized;
    writeUsers(users);

    // send OTP
    try {
      if (!twilioClient) throw new Error('Twilio not configured');
      await sendOtp(normalized);
      user.awaiting_otp = true;
      writeUsers(users);
      await safeSend(chatId, `📨 Verification code sent to ${normalized}. Please reply with the 6-digit code.`);
    } catch (e) {
      console.error('sendOtp error', e && e.message ? e.message : e);
      await safeSend(chatId, `${LANGS[user.lang].sendOTPFail}\n${e && e.message ? e.message : ''}`);
    }
  } catch (e) {
    console.error('contact handler', e);
  }
});

// message handler (for OTP, menu choices, uploads via image)
bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    const users = readUsers();
    let user = users.find(u => u.telegram_id === chatId);

    // Ignore bot's own non-user messages
    if (!user) {
      user = { telegram_id: chatId, verified: false, phone: null, balance: 0, total_waste: 0, lang: defaultLang };
      users.push(user); writeUsers(users);
    }

    // If message contains photo and user asked to scan waste
    if (msg.photo && user.awaiting_waste_image) {
      // save file locally (download highest resolution)
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const file = await bot.getFile(fileId);
      const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
      const ext = path.extname(file.file_path) || '.jpg';
      const filename = `${Date.now()}_${chatId}${ext}`;
      const localPath = path.join(UPLOADS_DIR, filename);

      const resp = await axios({ url, responseType: 'stream' });
      const wstream = fs.createWriteStream(localPath);
      await new Promise((res, rej) => {
        resp.data.pipe(wstream);
        resp.data.on('end', res);
        resp.data.on('error', rej);
      });

      // Offline detection heuristic: file size -> weight approximation
      const stats = fs.statSync(localPath);
      const kb = Math.max(1, Math.round(stats.size / 1024));
      // crude mapping: every 50KB ~ 0.1kg (very rough)
      const weight = Math.min(100, Math.max(0.1, (kb / 50) * 0.1));
      const amount = weight * PRICE_PER_KG;
      user.total_waste = (user.total_waste || 0) + Number(weight.toFixed(2));
      user.balance = (user.balance || 0) + Number(amount.toFixed(2));
      delete user.awaiting_waste_image;
      writeUsers(users);

      await safeSend(chatId, `🟢 Image received and processed (offline).\nEstimated weight: ${weight.toFixed(2)}kg\nYou earned ₦${amount.toFixed(2)}.`);
      return;
    }

    // OTP flow: numeric 6-digit when awaiting_otp
    if (user.awaiting_otp && /^\d{4,6}$/.test(text)) {
      const normalized = user.phone;
      try {
        const res = await checkOtp(normalized, text);
        if (res && res.status === 'approved') {
          user.verified = true;
          delete user.awaiting_otp;
          writeUsers(users);
          await safeSend(chatId, LANGS[user.lang].verified);
        } else {
          await safeSend(chatId, '❌ Invalid code. Try again.');
        }
      } catch (e) {
        console.error('checkOtp error', e && e.message ? e.message : e);
        await safeSend(chatId, LANGS[user.lang].sendOTPFail);
      }
      return;
    }

    // If message asks to enter phone manually
    if (text.toLowerCase().startsWith('enter phone') || text.match(/^\+?\d[\d\s\-]{6,}$/)) {
      // if typed phone number directly
      const maybe = text.match(/(\+?\d[\d\s\-]{6,})/);
      const phoneRaw = maybe ? maybe[1] : text;
      const normalized = normalizePhone(phoneRaw);
      user.phone = normalized;
      writeUsers(users);
      try {
        if (!twilioClient) throw new Error('Twilio not configured');
        await sendOtp(normalized);
        user.awaiting_otp = true;
        writeUsers(users);
        await safeSend(chatId, `📨 Verification code sent to ${normalized}. Reply with the code.`);
      } catch (e) {
        console.error('sendOtp error', e);
        await safeSend(chatId, LANGS[user.lang].sendOTPFail);
      }
      return;
    }

    // If user not verified: block other actions
    if (!user.verified) {
      // remind with options
      return safeSend(chatId, `⚠️ You must verify your phone first. Use /start or share contact.`);
    }

    // Verified user actions and menu texts
    if (text === '/menu') {
      const buttons = [
        [{ text: '♻️ Scan Waste' }],
        [{ text: '💰 Withdraw' }],
        [{ text: '📊 My Stats' }]
      ];
      if (ADMIN_TELEGRAM_ID.includes(chatId)) buttons.push([{ text: '🛠 Admin Panel' }]);
      return bot.sendMessage(chatId, 'Main Menu:', { reply_markup: { keyboard: buttons, resize_keyboard: true } });
    }

    if (text === '♻️ Scan Waste') {
      user.awaiting_waste_image = true;
      writeUsers(users);
      return safeSend(chatId, '📸 Send a photo of your waste or type the weight in KG (e.g. `2.5`).');
    }

    if (user.awaiting_waste_image && text && /^\d+(\.\d+)?$/.test(text)) {
      const weight = parseFloat(text);
      const amount = weight * PRICE_PER_KG;
      user.total_waste = (user.total_waste || 0) + weight;
      user.balance = (user.balance || 0) + amount;
      delete user.awaiting_waste_image;
      writeUsers(users);
      return safeSend(chatId, `✅ Recorded ${weight}kg waste.\nYou earned ₦${amount.toFixed(2)}!`);
    }

    if (text === '💰 Withdraw') {
      if ((user.balance || 0) < 1000) {
        return safeSend(chatId, '⚠️ Minimum withdrawal is ₦1000.');
      }
      user.awaiting_withdraw = true;
      writeUsers(users);
      return safeSend(chatId, `💳 Your balance is ₦${user.balance.toFixed(2)}. Send your account details (account name, account number, bank).`);
    }

    if (user.awaiting_withdraw) {
      const amount = user.balance;
      const wreq = {
        id: `w_${Date.now()}`,
        user_telegram_id: user.telegram_id,
        phone: user.phone,
        amount: amount,
        account_details: text,
        status: 'pending',
        created_at: new Date().toISOString()
      };
      const withdrawals = readWithdrawals();
      withdrawals.push(wreq);
      writeWithdrawals(withdrawals);

      // clear user balance locally (simulate hold)
      user.balance = 0;
      delete user.awaiting_withdraw;
      writeUsers(users);

      // notify admins with inline buttons
      const inline = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve', callback_data: `withdraw_${wreq.id}_approve` },
              { text: '❌ Reject', callback_data: `withdraw_${wreq.id}_reject` }
            ]
          ]
        }
      };

      ADMIN_TELEGRAM_ID.forEach(async (adminId) => {
        try {
          await safeSend(adminId, `💰 New withdrawal request\nID: ${wreq.id}\nUser: ${wreq.phone || wreq.user_telegram_id}\nAmount: ₦${wreq.amount}\nAccount: ${text}`, inline);
        } catch (e) { console.error('notify admin error', e); }
      });

      await safeSend(chatId, '✅ Withdrawal request received. Admin will process it soon.');
      return;
    }

    if (text === '📊 My Stats') {
      return safeSend(chatId, `📈 Total Waste: ${user.total_waste || 0}kg\n💰 Balance: ₦${(user.balance || 0).toFixed(2)}`);
    }

    if (text === '🛠 Admin Panel' && ADMIN_TELEGRAM_ID.includes(chatId)) {
      return bot.sendMessage(chatId, '🧰 Admin Panel:\n1) /users - list users\n2) /withdrawals - list withdrawals\n3) /toggles - show admin toggles');
    }

    // fallback
    return safeSend(chatId, 'Unrecognized command. Use /menu to start.');
  } catch (e) {
    console.error('message handler error', e);
  }
});

// Admin commands: list users
bot.onText(/\/users/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ADMIN_TELEGRAM_ID.includes(chatId)) return;
  const users = readUsers();
  const lines = users.map(u => `${u.telegram_id} | ${u.phone || 'unknown'} | verified:${u.verified} | bal:₦${(u.balance||0).toFixed(2)}`).slice(0, 200).join('\n') || 'No users';
  await safeSend(chatId, `👥 Users:\n${lines}`);
});

// Admin withdrawals
bot.onText(/\/withdrawals/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ADMIN_TELEGRAM_ID.includes(chatId)) return;
  const w = readWithdrawals();
  const lines = w.map(x => `${x.id} | ${x.phone || x.user_telegram_id} | ₦${x.amount} | ${x.status}`).join('\n') || 'No withdrawals';
  await safeSend(chatId, `💳 Withdrawals:\n${lines}`);
});

// Admin toggles (demo two toggles)
let adminToggles = { auto_withdraw_enabled: false, uploads_enabled: true };
bot.onText(/\/toggles/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ADMIN_TELEGRAM_ID.includes(chatId)) return;
  await bot.sendMessage(chatId, `Admin toggles:\nAuto withdraw: ${adminToggles.auto_withdraw_enabled}\nUploads: ${adminToggles.uploads_enabled}`);
});

// process errors / lifecycle
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err && err.stack || err);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err && err.stack || err);
});

// boot log
log('🤖 Bot started successfully...');
