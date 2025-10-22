// bot.js - Clean Naija Bot (CommonJS)
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const twilio = require('twilio');
const AWS = require('aws-sdk');

// --- Validate required env vars early ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID;

if (!TELEGRAM_TOKEN) {
  console.error('FATAL: TELEGRAM_TOKEN not provided in environment variables.');
  process.exit(1);
}
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SID) {
  console.warn('Warning: Twilio credentials missing. OTP will fail until set.');
}

// --- Twilio client ---
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- Optional AWS S3 setup (for uploads) ---
const S3_BUCKET = process.env.AWS_S3_BUCKET || null;
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_REGION) {
  AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
  });
}
const s3 = new AWS.S3();

// --- Telegram bot init (polling) ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// --- Directories & data files ---
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(UPLOAD_DIR);

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SCANS_FILE = path.join(DATA_DIR, 'scans.json');
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
if (!fs.existsSync(SCANS_FILE)) fs.writeFileSync(SCANS_FILE, '[]');

// --- Helpers ---
const loadJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); }
  catch (e) { console.error('JSON load error', file, e); return []; }
};
const saveJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

const loadUsers = () => loadJson(USERS_FILE);
const saveUsers = (u) => saveJson(USERS_FILE, u);
const loadScans = () => loadJson(SCANS_FILE);
const saveScans = (s) => saveJson(SCANS_FILE, s);

const findUser = (telegramId) => loadUsers().find(x => x.telegram_id === telegramId);

// Admins: can be set via ADMIN_IDS env var (comma separated) or edit here
const ADMINS = (process.env.ADMIN_IDS || '').split(',').map(x => Number(x)).filter(Boolean);

// Utility to parse phone and format E.164
function normalizePhone(raw, defaultCountry = 'NG') {
  if (!raw) return null;
  const p = parsePhoneNumberFromString(raw, defaultCountry);
  if (!p) return null;
  return p.number; // e.164
}

// --- Start command ---
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  let user = findUser(chatId);
  if (!user) {
    user = { telegram_id: chatId, verified: false, phone: null, balance: 0, total_waste: 0 };
    const all = loadUsers();
    all.push(user);
    saveUsers(all);
  }

  if (!user.verified) {
    return bot.sendMessage(chatId, `👋 Hi ${msg.from.first_name || ''}!\nPlease verify your phone number to continue.\n\nYou can:\n• Share your contact with the button below\n• Type your phone number (e.g. +2348012345678)`, {
      reply_markup: {
        keyboard: [[{ text: "📱 Share My Number", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
  }

  bot.sendMessage(chatId, "✅ You're verified — use /menu to continue.");
});

// --- Handle contact share (phone) ---
bot.on('contact', async (msg) => {
  const phoneRaw = msg.contact && (msg.contact.phone_number || msg.contact.vcard);
  const chatId = msg.chat.id;
  const users = loadUsers();
  const user = users.find(u => u.telegram_id === chatId);
  if (!user) return;

  const normalized = normalizePhone(phoneRaw);
  if (!normalized) {
    bot.sendMessage(chatId, "❌ Couldn't parse that phone number. Please type with country code (e.g. +234...)");
    return;
  }

  user.phone = normalized;
  saveUsers(users);

  // send OTP
  try {
    await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
      .verifications.create({ to: normalized, channel: 'sms' });

    user.awaiting_otp = true;
    saveUsers(users);
    bot.sendMessage(chatId, `📨 Sent OTP to ${normalized}. Reply with the 6-digit code.`);
  } catch (err) {
    console.error('Twilio send error', err && err.message || err);
    bot.sendMessage(chatId, "❌ Failed to send OTP — Twilio credentials or Verify service might be misconfigured.");
  }
});

// --- Handle plain phone number typed by user (non-contact) ---
bot.onText(/^\+?\d[\d\s().-]{6,}$/, async (msg) => {
  const chatId = msg.chat.id;
  const raw = msg.text.trim();
  const users = loadUsers();
  const user = users.find(u => u.telegram_id === chatId);
  if (!user) return;

  const normalized = normalizePhone(raw);
  if (!normalized) {
    bot.sendMessage(chatId, "❌ I couldn't parse that phone number. Try with +countrycode (e.g. +2348012345678).");
    return;
  }

  user.phone = normalized;
  saveUsers(users);

  try {
    await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
      .verifications.create({ to: normalized, channel: 'sms' });

    user.awaiting_otp = true;
    saveUsers(users);
    bot.sendMessage(chatId, `📨 Sent OTP to ${normalized}. Reply with the 6-digit code.`);
  } catch (err) {
    console.error('Twilio send error', err && err.message || err);
    bot.sendMessage(chatId, "❌ Failed to send OTP — Twilio config may be missing.");
  }
});

// --- OTP verification and other message handlers (single place) ---
bot.on('message', async (msg) => {
  // many handlers use 'message', but contact and number regex above short-circuit
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // ignore messages that were already handled (contact, phone-number detection, commands)
  if (msg.contact) return; // handled above
  if (/^\+?\d[\d\s().-]{6,}$/.test(text)) return; // handled above
  if (text && text.startsWith('/')) return; // commands handled elsewhere

  const users = loadUsers();
  const user = users.find(u => u.telegram_id === chatId);
  if (user && user.awaiting_otp && /^\d{4,8}$/.test(text)) {
    // OTP check
    try {
      const res = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
        .verificationChecks.create({ to: user.phone, code: text });

      if (res.status === 'approved') {
        user.verified = true;
        delete user.awaiting_otp;
        saveUsers(users);
        bot.sendMessage(chatId, "✅ Phone verified successfully. Use /menu to continue.");
      } else {
        bot.sendMessage(chatId, "❌ Invalid OTP. Try again or request a new code.");
      }
    } catch (err) {
      console.error('Twilio verify error', err && err.message || err);
      bot.sendMessage(chatId, "⚠️ Verification failed. Please try again later.");
    }
    return;
  }

  // if user is not verified, ignore other messages besides verification flow
  if (!user || !user.verified) {
    // let the user know how to verify
    return bot.sendMessage(chatId, "⚠️ Please verify your phone first using /start.");
  }

  // Other free-text interactions: quick menu trigger
  if (text === '♻️ Scan Waste' || text.toLowerCase().includes('scan')) {
    user.awaiting_waste = true;
    saveUsers(users);
    return bot.sendMessage(chatId, "📸 Send a photo of the waste or type the weight in KG (e.g. 2.5).");
  }

  if (user.awaiting_waste && /^\d+(\.\d+)?$/.test(text)) {
    const weight = parseFloat(text);
    const amount = weight * 120; // ₦120 per kg — example
    user.total_waste = (user.total_waste || 0) + weight;
    user.balance = (user.balance || 0) + amount;
    delete user.awaiting_waste;
    saveUsers(users);
    return bot.sendMessage(chatId, `✅ Recorded ${weight} kg. You earned ₦${amount.toFixed(2)}.`);
  }

  // Withdraw flow
  if (text.toLowerCase().includes('withdraw') || text === '💰 Withdraw') {
    if (user.balance < 1000) {
      return bot.sendMessage(chatId, "⚠️ Minimum withdrawal is ₦1000.");
    }
    user.awaiting_withdraw = true;
    saveUsers(users);
    return bot.sendMessage(chatId, `💳 Your balance is ₦${user.balance.toFixed(2)}.\nPlease send account details for payout.`);
  }
  if (user.awaiting_withdraw) {
    // store withdrawal request (simple simulation)
    delete user.awaiting_withdraw;
    saveUsers(users);
    // notify admins
    ADMINS.forEach(aid => {
      bot.sendMessage(aid, `💰 Withdrawal request from ${user.phone || user.telegram_id}\nUser id: ${user.telegram_id}\nAmount: ₦${user.balance.toFixed(2)}`);
    });
    return bot.sendMessage(chatId, "✅ Withdrawal request received. Admins will process it shortly.");
  }

  // stats
  if (text === '📊 My Stats' || text.toLowerCase().includes('stats')) {
    return bot.sendMessage(chatId, `📈 Total waste: ${user.total_waste || 0} kg\n💰 Balance: ₦${(user.balance || 0).toFixed(2)}`);
  }

  // fallback
  bot.sendMessage(chatId, "I didn't understand that — use /menu to see available actions.");
});

// --- Photo handling (scan) ---
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const users = loadUsers();
  const user = users.find(u => u.telegram_id === chatId);
  if (!user || !user.verified) return bot.sendMessage(chatId, "⚠️ Please verify your phone first using /start.");

  // The last photo in array is highest resolution
  const photos = msg.photo || [];
  if (!photos.length) return bot.sendMessage(chatId, "No photo found.");

  const fileId = photos[photos.length - 1].file_id;
  try {
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    // download image
    const resp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const timestamp = Date.now();
    const filename = `scan-${user.telegram_id}-${timestamp}.jpg`;
    const filepath = path.join(UPLOAD_DIR, filename);
    await fs.writeFile(filepath, resp.data);

    // Save scan record to queue for offline processing
    const scans = loadScans();
    const scanObj = {
      id: `${user.telegram_id}-${timestamp}`,
      telegram_id: user.telegram_id,
      phone: user.phone,
      filename,
      path: filepath,
      uploaded: false,
      processed: false,
      created_at: new Date().toISOString()
    };
    scans.push(scanObj);
    saveScans(scans);

    // Respond to user
    bot.sendMessage(chatId, "📥 Photo received. It has been queued for offline processing. Thank you!");

    // Optionally kick off automatic upload to S3 (if configured)
    if (S3_BUCKET && AWS.config.accessKeyId) {
      // upload in background but wait a bit so response reaches user quickly
      uploadToS3AndMark(scanObj).catch(err => console.error('Auto upload error', err));
    }
  } catch (err) {
    console.error('photo handling error', err && err.message || err);
    bot.sendMessage(chatId, "❌ Failed to receive the photo. Try again.");
  }
});

// --- Admin commands ---
bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  const user = findUser(chatId);
  if (!user || !user.verified) return bot.sendMessage(chatId, "⚠️ Please verify your phone first using /start");

  const buttons = [
    [{ text: "♻️ Scan Waste" }],
    [{ text: "💰 Withdraw" }],
    [{ text: "📊 My Stats" }]
  ];
  if (ADMINS.includes(chatId)) buttons.push([{ text: "🛠 Admin Panel" }]);

  bot.sendMessage(chatId, "Main Menu:", {
    reply_markup: { keyboard: buttons, resize_keyboard: true }
  });
});

bot.onText(/\/users/, (msg) => {
  if (!ADMINS.includes(msg.chat.id)) return;
  const users = loadUsers();
  if (users.length === 0) return bot.sendMessage(msg.chat.id, "No users yet.");
  let list = users.map(u => `${u.telegram_id} | ${u.phone || 'unknown'} | verified: ${u.verified} | bal: ₦${(u.balance||0).toFixed(2)}`).join('\n');
  bot.sendMessage(msg.chat.id, `👥 Users:\n${list}`);
});

bot.onText(/\/scans/, (msg) => {
  if (!ADMINS.includes(msg.chat.id)) return;
  const scans = loadScans();
  if (!scans.length) return bot.sendMessage(msg.chat.id, "No scans queued.");
  const list = scans.slice(-50).map(s => `${s.id} | ${s.filename} | uploaded:${s.uploaded} | processed:${s.processed}`).join('\n');
  bot.sendMessage(msg.chat.id, `📦 Scans (last 50):\n${list}`);
});

// Admin: force-upload a queued scan to S3 (if configured)
bot.onText(/\/upload (\S+)/, async (msg, match) => {
  if (!ADMINS.includes(msg.chat.id)) return;
  const id = match[1];
  const scans = loadScans();
  const scan = scans.find(s => s.id === id);
  if (!scan) return bot.sendMessage(msg.chat.id, "Scan not found.");
  if (!S3_BUCKET) return bot.sendMessage(msg.chat.id, "S3 not configured in env variables.");

  try {
    await uploadToS3AndMark(scan);
    bot.sendMessage(msg.chat.id, `✅ Uploaded ${scan.filename} to S3.`);
  } catch (err) {
    console.error('manual upload error', err);
    bot.sendMessage(msg.chat.id, "❌ Upload failed. Check logs.");
  }
});

// Admin: process a scan (simulate OCR/classification)
bot.onText(/\/process (\S+)/, async (msg, match) => {
  if (!ADMINS.includes(msg.chat.id)) return;
  const id = match[1];
  const scans = loadScans();
  const scan = scans.find(s => s.id === id);
  if (!scan) return bot.sendMessage(msg.chat.id, "Scan not found.");

  // Example offline processing simulation (classify by filename randomness)
  scan.processed = true;
  scan.classification = fakeClassification(scan.filename);
  saveScans(scans);
  bot.sendMessage(msg.chat.id, `✅ Processed ${scan.filename} — classification: ${scan.classification}`);
});

function fakeClassification(filename) {
  const choices = ['plastic', 'metal', 'organic', 'paper', 'glass'];
  return choices[Math.floor(Math.random() * choices.length)];
}

// --- S3 upload helper ---
async function uploadToS3AndMark(scanObj) {
  if (!scanObj || !scanObj.path) throw new Error('Invalid scan object');
  if (!S3_BUCKET) throw new Error('S3_BUCKET not configured');

  const fileContent = await fs.readFile(scanObj.path);
  const key = `scans/${path.basename(scanObj.path)}`;
  const params = {
    Bucket: S3_BUCKET,
    Key: key,
    Body: fileContent,
    ContentType: 'image/jpeg',
    ACL: 'public-read'
  };

  const res = await s3.upload(params).promise();
  // mark uploaded in scans.json
  const scans = loadScans();
  const s = scans.find(x => x.id === scanObj.id);
  if (s) {
    s.uploaded = true;
    s.s3_url = res.Location;
    saveScans(scans);
  }
  return res;
}

// --- Graceful shutdown ---
process.on('SIGINT', () => {
  console.log('SIGINT received — shutting down.');
  bot.stopPolling();
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down.');
  bot.stopPolling();
  process.exit(0);
});

console.log('🤖 Bot started successfully...');
