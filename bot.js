/**
 * clean9ja-bot (all-features, offline-safe)
 * - Multi-language
 * - Admin & user menus
 * - Twilio optional (if env provided) else offline OTP (in-chat)
 * - Image (photo) offline mock detection using Jimp
 * - Voice/audio: offline mock processing (length-based transcript placeholder)
 * - Robust error handling & no crash loops
 */

require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Jimp = require('jimp');               // image processing (pure js)
const multer = require('multer');           // used if later adding HTTP uploads
const os = require('os');

// Optional Twilio — only require if env present to avoid startup failures
let twilioClient = null;
const hasTwilio = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SID);
if (hasTwilio) {
  try {
    const twilio = require('twilio');
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log('✅ Twilio client loaded (verification enabled).');
  } catch (e) {
    console.warn('⚠️ Twilio libs not installed or failed to load. Twilio disabled. Error:', e.message);
  }
}

// --- env & checks ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const PORT = process.env.PORT || 8080;
if (!TELEGRAM_TOKEN) {
  console.error('❌ TELEGRAM_TOKEN missing. Add it to your environment variables.');
  process.exit(1);
}

// --- Setup bot + web server ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true, request: { timeout: 15000 } });
const app = express();
app.use(express.json());

// Serve health-check endpoint used by Railway
app.get('/', (req, res) => res.send('🤖 Clean9ja Bot — healthy'));

// Start express
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server listening on :${PORT}`));

// --- Data storage (simple JSON files) ---
const DATA_DIR = path.join(process.cwd(), 'data');
fs.ensureDirSync(DATA_DIR);
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function loadJSON(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return fs.readJsonSync(file);
  } catch (e) {
    console.error(`Failed to load ${file}:`, e.message);
    return fallback;
  }
}
function saveJSON(file, obj) {
  try {
    fs.writeJsonSync(file, obj, { spaces: 2 });
  } catch (e) {
    console.error(`Failed to save ${file}:`, e.message);
  }
}

const usersDB = loadJSON(USERS_FILE, {});        // keyed by chatId
const settings = loadJSON(SETTINGS_FILE, {
  withdrawals_enabled: true,
  min_withdraw: 1000,
  adminPhones: [],      // populate as needed
});

// --- Languages & messages ---
const LANGUAGES = { en: 'English', ha: 'Hausa', yo: 'Yoruba', fr: 'French', tw: 'Twi' };

const TEXTS = {
  en: {
    welcome: "👋 Welcome to Clean9ja Smart Waste System! Choose a language:",
    chooseLangHint: "Tap a language to continue.",
    askPhone: "Please send your phone number in international format (e.g. +2348012345678) to receive a verification code.",
    otpSent: "📩 An OTP was sent. Enter the 6-digit code here. (If SMS not configured, the code will be sent inside this chat.)",
    otpDeliveredInChat: "📩 No external SMS configured. Your OTP was delivered inside this chat for testing.",
    verified: "✅ Verification successful. You now have access to the bot's features.",
    invalidOTP: "❌ Invalid code. Please request a new code or try again.",
    mainUser: "♻️ *User Menu*\n• /scan — Scan waste (send photo)\n• /estimate — Price estimate (send weight)\n• /points — Nearby collection points (mock)\n• /help — Support",
    mainAdmin: "👨‍💼 *Admin Menu*\n• /users — List users\n• /broadcast — Send broadcast\n• /settings — View / modify settings",
    scanProcessing: "🔍 Processing image. This is an offline estimate — results are simulated.\nPlease wait...",
    scanResult: (label, priceStr) => `✅ Detected: *${label}*\nEstimated price: ${priceStr}\nNote: This is an offline estimate.`,
    audioReceived: "🎧 Audio received. Performing offline analysis...",
    audioResult: (transcript) => `📝 Transcript (simulated):\n"${transcript}"\n\nIf you'd like a proper transcription, enable external speech-to-text integration.`,
    missingPhone: "⚠️ I didn't find a phone number for you. Send your phone first.",
    twilioError: "❌ Failed to send SMS via Twilio. The bot will fall back to in-chat OTP.",
    professionalError: "⚠️ An internal error occured. Our team has been notified (simulated). Please try again.",
  },
  ha: { /* short versions to keep example concise */ 
    welcome: "👋 Barka da zuwa Clean9ja! Zaɓi harshe:",
    chooseLangHint: "Zaɓi yaren ka don ci gaba.",
    askPhone: "Aika lambar wayarka (+234...).",
    otpSent: "📩 An aika OTP. Shigar da lambobin 6.",
    otpDeliveredInChat: "📩 Ba a daidaita SMS ba. OTP ɗin an aiko a cikin tattaunawa.",
    verified: "✅ An tabbatar. Yanzu zaka iya amfani.",
    mainUser: "♻️ *Menu*\n/scan /estimate /points /help",
    mainAdmin: "👨‍💼 *Admin*\n/users /broadcast /settings",
    scanProcessing: "🔍 Ana dubawa (simulated)...",
    scanResult: (label, priceStr) => `✅ An gano: *${label}*\nFarashi: ${priceStr}`,
    audioReceived: "🎧 An karɓi audio...",
    audioResult: (t) => `📝 Transcript (sim): "${t}"`,
    missingPhone: "⚠️ Ba a same wayar ka ba.",
    twilioError: "❌ Twilio ya kasa — za a yi fallback.",
    professionalError: "⚠️ Kuskurena ya faru. Gwada sake."
  },
  // For brevity, reuse English keys for other langs in this template.
  yo: {}, fr: tw: {}
};

// Fill missing with en fallback
['yo','fr','tw'].forEach(k => { if(!TEXTS[k]) TEXTS[k] = TEXTS.en; });

// --- Helpers ---
function getLang(chatId) {
  return usersDB[chatId]?.language || 'en';
}
function sendProfessional(botChatId, lang, text, extra = {}) {
  try {
    return bot.sendMessage(botChatId, text, Object.assign({ parse_mode: 'Markdown' }, extra));
  } catch (e) {
    console.error('sendProfessional error:', e.message);
  }
}

// --- Language selection flow ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const keyboard = {
    reply_markup: {
      keyboard: Object.values(LANGUAGES).map(l => [{ text: l }]),
      one_time_keyboard: true,
      resize_keyboard: true
    }
  };
  sendProfessional(chatId, 'en', TEXTS.en.welcome + '\n' + TEXTS.en.chooseLangHint, keyboard);
});

// Handle language selection
bot.on('message', async (msg) => {
  try {
    if (!msg.text) return; // ignore non-text here (photos handled separately)

    const chatId = msg.chat.id;
    const text = msg.text.trim();
    // If user sends a language name
    const selected = Object.entries(LANGUAGES).find(([, name]) => name.toLowerCase() === text.toLowerCase());
    if (selected) {
      const [code] = selected;
      usersDB[chatId] = usersDB[chatId] || {};
      usersDB[chatId].language = code;
      saveJSON(USERS_FILE, usersDB);
      sendProfessional(chatId, code, TEXTS[code].askPhone);
      return;
    }

    // If text looks like phone starting with +
    if (text.startsWith('+')) {
      const phone = text;
      const lang = getLang(chatId);
      usersDB[chatId] = usersDB[chatId] || {};
      usersDB[chatId].phone = phone;
      saveJSON(USERS_FILE, usersDB);
      // send OTP via Twilio if configured, else send OTP in-chat
      await sendOTPFlow(chatId, phone, lang);
      return;
    }

    // Commands (helpful fallback)
    if (text === '/help' || text.toLowerCase() === 'help') {
      const lang = getLang(chatId);
      return sendProfessional(chatId, lang, TEXTS[lang].mainUser);
    }

    // If user sends numeric OTP attempt (6 digits)
    if (/^\d{4,6}$/.test(text)) {
      const lang = getLang(chatId);
      return verifyOTPAttempt(chatId, text, lang);
    }

    // admin commands
    if (text.startsWith('/broadcast')) {
      const lang = getLang(chatId);
      const phone = usersDB[chatId]?.phone;
      if (!isAdminPhone(phone)) return sendProfessional(chatId, lang, 'Unauthorized. Only admins allowed.');
      const msgToSend = text.replace('/broadcast', '').trim();
      if (!msgToSend) return sendProfessional(chatId, lang, 'Usage: /broadcast <message>');
      // send to all verified users
      const broadcastTargets = Object.entries(usersDB).filter(([,u]) => u.verified).map(([id]) => id);
      for (const id of broadcastTargets) {
        try { await bot.sendMessage(id, `📣 Broadcast from Admin:\n\n${msgToSend}`); } catch(e) { console.warn('broadcast fail for', id, e.message); }
      }
      return sendProfessional(chatId, lang, `✅ Broadcast sent to ${broadcastTargets.length} users.`);
    }

    // /users admin
    if (text === '/users') {
      const lang = getLang(chatId);
      if (!isAdminPhone(usersDB[chatId]?.phone)) return sendProfessional(chatId, lang, 'Unauthorized.');
      const list = Object.entries(usersDB).map(([id,u]) => `${id} — ${u.phone||'no-phone'} — ${u.verified ? 'verified' : 'unverified'}`).slice(0, 2000).join('\n') || 'No users';
      return sendProfessional(chatId, lang, `👥 Users:\n${list}`);
    }

    // /scan command hint
    if (text === '/scan') {
      const lang = getLang(chatId);
      return sendProfessional(chatId, lang, `📸 Please send a photo of the waste you'd like to scan.`);
    }

    // /estimate expects "weight kg" e.g. "2.5kg" or "2.5 kg"
    const estimateMatch = text.match(/^(\d+(\.\d+)?)\s?kg$/i);
    if (estimateMatch) {
      const lang = getLang(chatId);
      const weight = parseFloat(estimateMatch[1]);
      const pricePerKg = 150; // offline configured value; could come from settings
      const total = (weight * pricePerKg).toFixed(2);
      return sendProfessional(chatId, lang, `📦 Estimated price for ${weight} kg: ₦${total}`);
    }

    // default reply
    // keep it professional
    const lang = getLang(chatId);
    return sendProfessional(chatId, lang, "I didn't quite understand that. Use /scan, /estimate (e.g. '2.5kg'), or send a photo to scan.");
  } catch (err) {
    console.error('message handler error:', err);
    const chatId = msg.chat?.id;
    if (chatId) sendProfessional(chatId, getLang(chatId), TEXTS.en.professionalError);
  }
});

// --- OTP flow (Twilio optional, fallback to in-chat codes) ---
const otpStore = {}; // chatId -> { code, phone, expiresAt }

async function sendOTPFlow(chatId, phone, lang) {
  try {
    const code = (Math.floor(100000 + Math.random() * 900000)).toString(); // 6-digit
    const expiresAt = Date.now() + 5 * 60 * 1000;
    otpStore[chatId] = { code, phone, expiresAt };

    if (twilioClient && hasTwilio) {
      // Try Twilio Verify if available
      try {
        await twilioClient.verify.services(process.env.TWILIO_VERIFY_SID)
          .verifications.create({ to: phone, channel: 'sms' });
        sendProfessional(chatId, lang, TEXTS[lang].otpSent);
        // we won't store Twilio code locally — Twilio will check it
        return;
      } catch (e) {
        console.warn('Twilio send failed, falling back to chat OTP:', e.message);
        sendProfessional(chatId, lang, TEXTS[lang].twilioError);
        // fall through to in-chat OTP
      }
    }

    // Fallback: deliver OTP in-chat (development / offline mode)
    sendProfessional(chatId, lang, `${TEXTS[lang].otpDeliveredInChat}\n\n🔐 OTP: *${code}* (expires in 5 minutes)`, { parse_mode: 'Markdown' });
    sendProfessional(chatId, lang, TEXTS[lang].otpSent);
  } catch (e) {
    console.error('sendOTPFlow error:', e);
    sendProfessional(chatId, getLang(chatId) || 'en', TEXTS.en.professionalError);
  }
}

async function verifyOTPAttempt(chatId, codeText, lang) {
  try {
    // If Twilio configured, call verification endpoint
    if (twilioClient && hasTwilio) {
      const phone = usersDB[chatId]?.phone;
      if (!phone) return sendProfessional(chatId, lang, TEXTS[lang].missingPhone);
      // Use Twilio Verify checks
      try {
        const res = await twilioClient.verify.services(process.env.TWILIO_VERIFY_SID)
          .verificationChecks.create({ to: phone, code: codeText });
        if (res.status === 'approved') {
          usersDB[chatId] = usersDB[chatId] || {};
          usersDB[chatId].verified = true;
          saveJSON(USERS_FILE, usersDB);
          return sendProfessional(chatId, lang, TEXTS[lang].verified);
        } else {
          return sendProfessional(chatId, lang, TEXTS[lang].invalidOTP);
        }
      } catch (e) {
        console.warn('Twilio verify failed:', e.message);
        // fallthrough to local check
      }
    }

    // Local check
    const entry = otpStore[chatId];
    if (!entry) return sendProfessional(chatId, lang, TEXTS[lang].invalidOTP);
    if (Date.now() > entry.expiresAt) { delete otpStore[chatId]; return sendProfessional(chatId, lang, '❌ OTP expired. Request a new one.'); }
    if (entry.code === codeText) {
      usersDB[chatId] = usersDB[chatId] || {};
      usersDB[chatId].verified = true;
      usersDB[chatId].phone = entry.phone;
      saveJSON(USERS_FILE, usersDB);
      delete otpStore[chatId];
      return sendProfessional(chatId, lang, TEXTS[lang].verified);
    } else {
      return sendProfessional(chatId, lang, TEXTS[lang].invalidOTP);
    }
  } catch (e) {
    console.error('verifyOTPAttempt error:', e.message);
    return sendProfessional(chatId, lang, TEXTS[lang].professionalError);
  }
}

// --- Helper: is admin phone ---
function isAdminPhone(phone) {
  if (!phone) return false;
  const adminPhones = settings.adminPhones || [];
  // Accept exact match; normalize simple
  return adminPhones.includes(phone);
}

// --- Photo handler: offline/mock detection with Jimp ---
bot.on('photo', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const lang = getLang(chatId);
    if (!usersDB[chatId]?.verified) return sendProfessional(chatId, lang, TEXTS[lang].missingPhone);

    sendProfessional(chatId, lang, TEXTS[lang].scanProcessing);
    // pick the highest resolution photo
    const photos = msg.photo;
    const best = photos[photos.length - 1];
    const fileId = best.file_id;

    // download file buffer
    const file = await bot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    const buffer = await res.buffer();

    // Process image with Jimp (offline heuristic):
    const image = await Jimp.read(buffer);
    // Resize to moderate size for analysis
    image.resize(300, Jimp.AUTO);

    // Compute average color for simple heuristics
    let rSum = 0, gSum = 0, bSum = 0;
    const w = image.bitmap.width;
    const h = image.bitmap.height;
    image.scan(0, 0, w, h, function(x, y, idx) {
      rSum += this.bitmap.data[idx + 0];
      gSum += this.bitmap.data[idx + 1];
      bSum += this.bitmap.data[idx + 2];
    });
    const pxCount = w * h;
    const rAvg = Math.round(rSum / pxCount);
    const gAvg = Math.round(gSum / pxCount);
    const bAvg = Math.round(bSum / pxCount);

    // Simple rule-based label detection (offline heuristic)
    let label = 'Mixed/Unknown waste';
    let priceStr = '₦100/kg (estimate)';
    // heuristics: if bright/translucent-ish => plastic
    if (rAvg > 180 && gAvg > 180 && bAvg > 180) { label = 'Plastic (likely PET)'; priceStr = '₦150/kg'; }
    else if (rAvg < 80 && gAvg < 80 && bAvg < 80) { label = 'Metal (likely cans)'; priceStr = '₦200/kg'; }
    else if (gAvg > rAvg && gAvg > bAvg + 10) { label = 'Organic/Plant waste'; priceStr = '₦40/kg'; }
    else label = 'Mixed recyclables';

    sendProfessional(chatId, lang, TEXTS[lang].scanResult(label, priceStr));
  } catch (e) {
    console.error('photo handler err:', e.message);
    sendProfessional(msg.chat.id, getLang(msg.chat.id), TEXTS[getLang(msg.chat.id)].professionalError);
  }
});

// --- Audio handler (voice notes or audio) ---
bot.on('voice', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const lang = getLang(chatId);
    if (!usersDB[chatId]?.verified) return sendProfessional(chatId, lang, TEXTS[lang].missingPhone);

    sendProfessional(chatId, lang, TEXTS[lang].audioReceived);

    // Download voice file
    const fileId = msg.voice.file_id;
    const file = await bot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    const buffer = await res.buffer();
    // Simulated analysis: base transcript on length
    const durationSec = msg.voice.duration || Math.round(buffer.length / 10000);
    let transcript = '';
    if (durationSec < 3) transcript = 'Short voice note: user says hello.';
    else if (durationSec < 10) transcript = 'User describes waste and asks for pickup.';
    else transcript = 'Longer message: user gave details about waste quantity and pickup preference.';
    sendProfessional(chatId, lang, TEXTS[lang].audioResult(transcript));
  } catch (e) {
    console.error('voice handler:', e);
    sendProfessional(msg.chat.id, getLang(msg.chat.id), TEXTS[getLang(msg.chat.id)].professionalError);
  }
});

// Also accept generic audio/document uploads (mp3/wav)
bot.on('document', async (msg) => {
  try {
    const mime = msg.document.mime_type || '';
    if (mime.startsWith('audio/') || mime === 'application/octet-stream') {
      // treat like audio
      return bot.emit('voice', Object.assign({}, msg, { voice: { file_id: msg.document.file_id, duration: msg.document.file_size ? Math.round(msg.document.file_size / 10000) : 5 } }));
    }
  } catch (e) {
    console.error('document handler:', e.message);
  }
});

// --- Periodic online/offline check (non-blocking) ---
setInterval(async () => {
  try {
    // small HEAD to Telegram API base — no heavy payload
    await fetch('https://api.telegram.org');
    console.log('📶 Telegram reachable (bot likely online).');
  } catch (e) {
    console.log('⚠️ Telegram unreachable — running in offline/local simulation mode.');
  }
}, 5 * 60 * 1000);

// --- Safety handlers to prevent container crash loops ---
process.on('uncaughtException', err => {
  console.error('uncaughtException:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', err => {
  console.error('unhandledRejection:', err && err.stack ? err.stack : err);
});

// Save DB on graceful exit
async function shutdown() {
  console.log('Shutting down... saving data.');
  saveJSON(USERS_FILE, usersDB);
  saveJSON(SETTINGS_FILE, settings);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
