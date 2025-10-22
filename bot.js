require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const axios = require('axios');
const path = require('path');
const twilio = require('twilio');
const express = require('express');

// === KEEP-ALIVE SERVER (for Railway) ===
const app = express();
app.get('/', (req, res) => res.send('🤖 Clean Naija Bot is running fine!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Keep-alive server running on port ${PORT}`));

// === Twilio Setup ===
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const VERIFY_SERVICE = process.env.TWILIO_VERIFY_SID;

// === Telegram Setup ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error("❌ TELEGRAM_TOKEN missing in environment variables!");
  process.exit(1);
}
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// === Paths and Files ===
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(UPLOADS_DIR);

const USERS_FILE = path.join(DATA_DIR, 'users.json');
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');

// === Helper Functions ===
const loadUsers = () => JSON.parse(fs.readFileSync(USERS_FILE));
const saveUsers = (data) => fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
const findUser = (id) => loadUsers().find(u => u.telegram_id === id);

// === Admins ===
const ADMINS = [parseInt(process.env.ADMIN_TELEGRAM_ID || '0', 10)];

// === Start Command ===
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
    return bot.sendMessage(chatId, `👋 Welcome ${msg.from.first_name || 'User'}!\n\nBefore using this bot, please verify your phone number.`, {
      reply_markup: {
        keyboard: [[{ text: "📱 Share My Number", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
  }

  bot.sendMessage(chatId, "✅ You’re already verified! Use /menu to continue.");
});

// === Handle Contact ===
bot.on('contact', async (msg) => {
  const chatId = msg.chat.id;
  const phone = msg.contact.phone_number;
  const users = loadUsers();
  const user = users.find(u => u.telegram_id === chatId);
  if (!user) return;

  user.phone = phone;
  saveUsers(users);

  try {
    await client.verify.v2.services(VERIFY_SERVICE).verifications.create({ to: phone, channel: 'sms' });
    bot.sendMessage(chatId, `📨 A 6-digit code has been sent to ${phone}. Please reply with that code.`);
    user.awaiting_otp = true;
    saveUsers(users);
  } catch (e) {
    console.error("Twilio Error:", e.message);
    bot.sendMessage(chatId, "❌ Failed to send OTP. Please check Twilio credentials.");
  }
});

// === Handle OTP Verification ===
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const users = loadUsers();
  const user = users.find(u => u.telegram_id === chatId);

  if (user && user.awaiting_otp && /^\d{6}$/.test(text)) {
    try {
      const result = await client.verify.v2.services(VERIFY_SERVICE).verificationChecks.create({
        to: user.phone,
        code: text
      });
      if (result.status === 'approved') {
        user.verified = true;
        delete user.awaiting_otp;
        saveUsers(users);
        return bot.sendMessage(chatId, "✅ Phone number verified successfully! Type /menu to continue.");
      } else {
        bot.sendMessage(chatId, "❌ Invalid code. Try again.");
      }
    } catch {
      bot.sendMessage(chatId, "⚠️ Verification failed. Try again later.");
    }
  }
});

// === Menu ===
bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  const user = findUser(chatId);
  if (!user || !user.verified) return bot.sendMessage(chatId, "⚠️ Please verify your phone first using /start.");

  const buttons = [
    [{ text: "♻️ Upload Waste Photo" }],
    [{ text: "📦 Enter Waste Weight" }],
    [{ text: "💰 Withdraw" }],
    [{ text: "📊 My Stats" }]
  ];
  if (ADMINS.includes(chatId)) buttons.push([{ text: "🛠 Admin Panel" }]);

  bot.sendMessage(chatId, "Choose an option below 👇", {
    reply_markup: { keyboard: buttons, resize_keyboard: true }
  });
});

// === Handle Messages & Actions ===
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const users = loadUsers();
  const user = users.find(u => u.telegram_id === chatId);
  if (!user || !user.verified) return;

  // Upload photo for waste detection
  if (msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const file = await bot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    const savePath = path.join(UPLOADS_DIR, `${chatId}-${Date.now()}.jpg`);
    const res = await axios.get(url, { responseType: 'arraybuffer' });
    fs.writeFileSync(savePath, res.data);
    bot.sendMessage(chatId, "📷 Waste photo uploaded! Estimating value...");
    const fakeValue = Math.floor(Math.random() * 500) + 100; // Simulated ₦100–₦600
    user.balance += fakeValue;
    user.total_waste += 1;
    saveUsers(users);
    return bot.sendMessage(chatId, `✅ Estimated ₦${fakeValue} added to your balance! 💰`);
  }

  // Enter weight manually
  if (text === "📦 Enter Waste Weight") {
    user.awaiting_waste = true;
    saveUsers(users);
    return bot.sendMessage(chatId, "Enter the waste weight in KG (e.g. 2.5):");
  }

  if (user.awaiting_waste && /^\d+(\.\d+)?$/.test(text)) {
    const weight = parseFloat(text);
    const reward = weight * 120;
    user.balance += reward;
    user.total_waste += weight;
    delete user.awaiting_waste;
    saveUsers(users);
    return bot.sendMessage(chatId, `✅ Recorded ${weight}kg of waste.\nYou earned ₦${reward.toFixed(2)}.`);
  }

  // Withdraw
  if (text === "💰 Withdraw") {
    if (user.balance < 1000) return bot.sendMessage(chatId, "⚠️ Minimum withdrawal is ₦1000.");
    user.awaiting_withdraw = true;
    saveUsers(users);
    return bot.sendMessage(chatId, "💳 Send your account details to request a withdrawal.");
  }

  if (user.awaiting_withdraw) {
    delete user.awaiting_withdraw;
    saveUsers(users);
    bot.sendMessage(chatId, "✅ Withdrawal request received. Admin will process it soon!");
    ADMINS.forEach(a => bot.sendMessage(a, `💰 Withdrawal Request:\nUser: ${user.phone}\nAmount: ₦${user.balance}`));
    return;
  }

  // Stats
  if (text === "📊 My Stats") {
    return bot.sendMessage(chatId, `📈 Total Waste: ${user.total_waste}kg\n💰 Balance: ₦${user.balance.toFixed(2)}`);
  }

  // Admin Panel
  if (text === "🛠 Admin Panel" && ADMINS.includes(chatId)) {
    return bot.sendMessage(chatId, "🧰 Admin Commands:\n/users - View all users\n/reset - Reset data");
  }
});

// === Admin Commands ===
bot.onText(/\/users/, (msg) => {
  if (!ADMINS.includes(msg.chat.id)) return;
  const users = loadUsers();
  if (!users.length) return bot.sendMessage(msg.chat.id, "No users yet.");
  const list = users.map(u => `${u.phone || 'N/A'} - ₦${u.balance}`).join('\n');
  bot.sendMessage(msg.chat.id, `👥 Users:\n${list}`);
});

bot.onText(/\/reset/, (msg) => {
  if (!ADMINS.includes(msg.chat.id)) return;
  fs.writeFileSync(USERS_FILE, '[]');
  bot.sendMessage(msg.chat.id, "🧹 All user data cleared successfully.");
});

console.log("🤖 Bot started successfully...");
