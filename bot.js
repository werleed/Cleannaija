/***********************************************
 🤖 CLEAN9JA / WERLEED BOT
 Author: Werleed Dev
 Version: 2.0 (Offline, Professional)
 Description:
 - Twilio SMS verification (multi-language)
 - Admin & User features
 - Offline waste detection with pricing
 - Online/offline status detection
 - Clean professional messaging
************************************************/

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const twilio = require('twilio');
const fs = require('fs');
const axios = require('axios');

// --- ENVIRONMENT VARIABLES ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID;
const PORT = process.env.PORT || 8080;

// --- VALIDATION ---
if (!TELEGRAM_TOKEN || !TWILIO_SID || !TWILIO_AUTH || !TWILIO_VERIFY_SID) {
  console.error("❌ Missing environment variables. Please check .env configuration.");
  process.exit(1);
}

// --- SETUP ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const client = twilio(TWILIO_SID, TWILIO_AUTH);
const app = express();

// --- START EXPRESS SERVER ---
app.get('/', (req, res) => res.send('🤖 Clean9ja Bot is online and working fine.'));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));

// --- DATA STORE ---
const users = {}; // {chatId: {phone, verified, language}}
const admins = ['+2349012345678']; // Replace with real admin phone(s)

// --- LANGUAGES ---
const LANGUAGES = {
  en: 'English',
  ha: 'Hausa',
  yo: 'Yoruba',
  fr: 'French',
  tw: 'Twi'
};

// --- LANGUAGE TEXTS ---
const TEXTS = {
  en: {
    welcome: "👋 Welcome to Clean9ja Smart Waste System! Please choose your language:",
    verify: "Please enter your phone number (e.g., +234XXXXXXXXXX) to receive your verification code.",
    codeSent: "📩 OTP sent! Please enter the 6-digit code you received.",
    success: "✅ Verification successful! You can now access all features.",
    fail: "❌ Invalid code. Please try again.",
    mainUser: "♻️ *User Menu*\n1️⃣ Scan Waste\n2️⃣ View Price Estimate\n3️⃣ Nearby Collection Points\n4️⃣ Help / Support",
    mainAdmin: "👨‍💼 *Admin Menu*\n1️⃣ View Users\n2️⃣ View Reports\n3️⃣ Broadcast Message\n4️⃣ Waste Data Analytics",
    scan: "🔍 Scanning your waste sample...",
    result: "✅ Detected: *Plastic Bottle*\nEstimated Price: ₦150/kg\nLocation: Lagos",
  },
  ha: {
    welcome: "👋 Barka da zuwa Clean9ja! Da fatan za ka zaɓi harshe:",
    verify: "Shigar da lambar wayarka (misali: +234XXXXXXXXXX).",
    codeSent: "📩 An aika da lambar OTP! Shigar da lambobin 6 da aka aiko maka.",
    success: "✅ An tabbatar! Zaka iya amfani da dukkan ayyuka yanzu.",
    fail: "❌ Lambar ba daidai ba ce. Sake gwadawa.",
    mainUser: "♻️ *Menu na Mai amfani*\n1️⃣ Duba shara\n2️⃣ Kimar farashi\n3️⃣ Wurin tattara shara\n4️⃣ Taimako",
    mainAdmin: "👨‍💼 *Menu na Admin*\n1️⃣ Masu amfani\n2️⃣ Rahotanni\n3️⃣ Aika saƙo\n4️⃣ Bayanan nazari",
    scan: "🔍 Ana binciken shararka...",
    result: "✅ An gano: *Filastik*\nFarashi: ₦150/kg\nWuri: Lagos",
  },
  yo: {
    welcome: "👋 Kaabo si Clean9ja! Jọwọ yan ede rẹ:",
    verify: "Tẹ nọmba foonu rẹ sii (fun apẹẹrẹ: +234XXXXXXXXXX).",
    codeSent: "📩 A ti fi koodu OTP ranṣẹ! Tẹ koodu marun-un mẹfa ti o gba.",
    success: "✅ Ayẹwo rẹ ti ṣaṣeyọri! O le lo gbogbo awọn iṣẹ bayi.",
    fail: "❌ Koodu naa ko tọ. Jọwọ tun gbiyanju.",
    mainUser: "♻️ *Akopọ olumulo*\n1️⃣ Ṣayẹwo idoti\n2️⃣ Iye owo\n3️⃣ Ibudo gbigba\n4️⃣ Iranlọwọ",
    mainAdmin: "👨‍💼 *Akopọ Adari*\n1️⃣ Awọn olumulo\n2️⃣ Awọn ijabọ\n3️⃣ Ifiranṣẹ gbogbo eniyan\n4️⃣ Itupalẹ data",
    scan: "🔍 N ṣayẹwo idoti rẹ...",
    result: "✅ Awari: *Igo pilasitiki*\nIye owo: ₦150/kg\nIpo: Lagos",
  },
  fr: {
    welcome: "👋 Bienvenue sur Clean9ja ! Veuillez choisir votre langue :",
    verify: "Entrez votre numéro de téléphone (ex : +234XXXXXXXXXX).",
    codeSent: "📩 Code OTP envoyé ! Entrez le code à 6 chiffres reçu.",
    success: "✅ Vérification réussie ! Vous pouvez maintenant accéder à toutes les fonctions.",
    fail: "❌ Code invalide. Réessayez.",
    mainUser: "♻️ *Menu Utilisateur*\n1️⃣ Scanner un déchet\n2️⃣ Voir estimation du prix\n3️⃣ Points de collecte\n4️⃣ Aide / Support",
    mainAdmin: "👨‍💼 *Menu Administrateur*\n1️⃣ Voir les utilisateurs\n2️⃣ Voir les rapports\n3️⃣ Message global\n4️⃣ Analyse des données",
    scan: "🔍 Analyse du déchet...",
    result: "✅ Détecté : *Bouteille en plastique*\nPrix estimé : ₦150/kg\nLieu : Lagos",
  },
  tw: {
    welcome: "👋 Akwaaba! Yɛbɛboa wo wɔ Clean9ja. Fa kasa a wopɛ:",
    verify: "Kyerɛ w'ankasa nɔma no (e.g., +234XXXXXXXXXX).",
    codeSent: "📩 Wo nsa aka OTP no! Kyerɛ nsia-digit no.",
    success: "✅ Wo nsa aka no yiye! Bisa nsɛm nyinaa seesei.",
    fail: "❌ Kɔd no nteɛ. San yɛ bio.",
    mainUser: "♻️ *Menu no ma ɔdehye*\n1️⃣ Hwɛ nsuo\n2️⃣ Hwɛ bo\n3️⃣ Nkyɛmu hɔ\n4️⃣ Mmoa",
    mainAdmin: "👨‍💼 *Menu ma admin*\n1️⃣ Hwɛ nkɔsoɔ\n2️⃣ Hwɛ amanneɛ\n3️⃣ Kɔ nsɛm nyinaa\n4️⃣ Nsɛm ahorow",
    scan: "🔍 Rehwehwɛ wo sika...",
    result: "✅ Ahyɛaseɛ: *Plastic Bottle*\nBo: ₦150/kg\nBea: Lagos",
  }
};

// --- START COMMAND ---
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const languageKeyboard = {
    reply_markup: {
      keyboard: Object.values(LANGUAGES).map(l => [{ text: l }]),
      one_time_keyboard: true,
      resize_keyboard: true
    }
  };

  bot.sendMessage(chatId, TEXTS.en.welcome, languageKeyboard);
});

// --- LANGUAGE SELECTION ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // If user chooses a language
  const selectedLang = Object.entries(LANGUAGES).find(([code, name]) => name === text);
  if (selectedLang) {
    const [langCode] = selectedLang;
    users[chatId] = { language: langCode, verified: false };
    bot.sendMessage(chatId, TEXTS[langCode].verify);
    return;
  }

  // If number starts with +
  if (text.startsWith('+')) {
    const lang = users[chatId]?.language || 'en';
    sendOTP(chatId, text, lang);
    return;
  }
});

// --- SEND OTP ---
async function sendOTP(chatId, phone, lang) {
  try {
    await client.verify.v2.services(TWILIO_VERIFY_SID)
      .verifications
      .create({ to: phone, channel: 'sms' });

    users[chatId].phone = phone;
    bot.sendMessage(chatId, TEXTS[lang].codeSent);
    bot.once('message', async (msg2) => {
      const code = msg2.text.trim();
      verifyCode(chatId, phone, code, lang);
    });

  } catch (err) {
    console.error("Twilio error:", err.message);
    bot.sendMessage(chatId, "⚠️ Unable to send code. Please try again later.");
  }
}

// --- VERIFY CODE ---
async function verifyCode(chatId, phone, code, lang) {
  try {
    const verification = await client.verify.v2.services(TWILIO_VERIFY_SID)
      .verificationChecks
      .create({ to: phone, code });

    if (verification.status === 'approved') {
      users[chatId].verified = true;
      bot.sendMessage(chatId, TEXTS[lang].success);
      showMainMenu(chatId, phone, lang);
    } else {
      bot.sendMessage(chatId, TEXTS[lang].fail);
    }

  } catch (err) {
    console.error("Verification failed:", err.message);
    bot.sendMessage(chatId, "⚠️ Something went wrong. Try again.");
  }
}

// --- MAIN MENU ---
function showMainMenu(chatId, phone, lang) {
  const isAdmin = admins.includes(phone);
  const menu = isAdmin ? TEXTS[lang].mainAdmin : TEXTS[lang].mainUser;
  bot.sendMessage(chatId, menu, { parse_mode: 'Markdown' });
}

// --- WASTE SCAN SIMULATION ---
bot.onText(/scan|waste|check/i, (msg) => {
  const chatId = msg.chat.id;
  const lang = users[chatId]?.language || 'en';
  bot.sendMessage(chatId, TEXTS[lang].scan);
  setTimeout(() => {
    bot.sendMessage(chatId, TEXTS[lang].result, { parse_mode: 'Markdown' });
  }, 3000);
});

// --- ONLINE / OFFLINE DETECTION ---
setInterval(async () => {
  try {
    await axios.get("https://api.telegram.org");
    console.log("📶 Bot Online");
  } catch {
    console.log("⚠️ Bot Offline (Local mode)");
  }
}, 300000);

// --- SAFETY HANDLERS ---
process.on('unhandledRejection', err => console.error("Unhandled Rejection:", err));
process.on('uncaughtException', err => console.error("Uncaught Exception:", err));
