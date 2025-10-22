require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const twilio = require('twilio');

// === Twilio Setup ===
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const VERIFY_SERVICE = process.env.TWILIO_VERIFY_SID;

// === Telegram Setup ===
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// === Paths ===
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const USERS_FILE = path.join(DATA_DIR, 'users.json');
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');

// === Helper functions ===
const loadUsers = () => JSON.parse(fs.readFileSync(USERS_FILE));
const saveUsers = (data) => fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
const findUser = (id) => loadUsers().find(u => u.telegram_id === id);

// === Admin list (add your Telegram ID) ===
const ADMINS = [
  123456789, // 🔹 replace with your real Telegram user ID
];

// === Start command ===
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
    return bot.sendMessage(chatId, `👋 Welcome ${msg.from.first_name}!\nPlease verify your phone number first.\n\nYou can either:\n1️⃣ Send your Telegram contact\n2️⃣ Or type your phone number manually`, {
      reply_markup: {
        keyboard: [[{ text: "📱 Share My Number", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
  }

  bot.sendMessage(chatId, "✅ You’re already verified!\nUse /menu to continue.");
});

// === Handle contact share ===
bot.on('contact', async (msg) => {
  const phone = msg.contact.phone_number;
  const chatId = msg.chat.id;
  const users = loadUsers();
  const user = users.find(u => u.telegram_id === chatId);
  if (!user) return;

  user.phone = phone;
  saveUsers(users);

  try {
    await client.verify.v2.services(VERIFY_SERVICE).verifications.create({ to: phone, channel: 'sms' });
    bot.sendMessage(chatId, `📨 Verification code sent to ${phone}. Please reply with the 6-digit code.`);
    user.awaiting_otp = true;
    saveUsers(users);
  } catch (e) {
    bot.sendMessage(chatId, "❌ Failed to send OTP. Check your Twilio credentials.");
    console.error(e);
  }
});

// === Handle OTP verification ===
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text.trim();
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
        bot.sendMessage(chatId, "✅ Phone number verified successfully! Type /menu to start.");
      } else {
        bot.sendMessage(chatId, "❌ Invalid code. Try again.");
      }
    } catch (e) {
      bot.sendMessage(chatId, "⚠️ Verification failed. Please try again.");
      console.error(e);
    }
  }
});

// === Main menu ===
bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  const user = findUser(chatId);
  if (!user || !user.verified) return bot.sendMessage(chatId, "⚠️ Please verify your phone first using /start");

  const buttons = [
    [{ text: "♻️ Scan Waste" }],
    [{ text: "💰 Withdraw" }],
    [{ text: "📊 My Stats" }],
  ];
  if (ADMINS.includes(chatId)) buttons.push([{ text: "🛠 Admin Panel" }]);

  bot.sendMessage(chatId, "Main Menu:", {
    reply_markup: { keyboard: buttons, resize_keyboard: true }
  });
});

// === Handle user actions ===
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const users = loadUsers();
  const user = users.find(u => u.telegram_id === chatId);
  if (!user || !user.verified) return;

  if (text === "♻️ Scan Waste") {
    bot.sendMessage(chatId, "📸 Send a photo of your waste or type the weight in KG:");
    user.awaiting_waste = true;
    saveUsers(users);
  } else if (user.awaiting_waste && /^\d+(\.\d+)?$/.test(text)) {
    const weight = parseFloat(text);
    const amount = weight * 120; // ₦120 per kg simulation
    user.total_waste += weight;
    user.balance += amount;
    delete user.awaiting_waste;
    saveUsers(users);
    bot.sendMessage(chatId, `✅ Recorded ${weight}kg waste.\nYou earned ₦${amount.toFixed(2)}! 💸`);
  } else if (text === "💰 Withdraw") {
    if (user.balance < 1000) {
      bot.sendMessage(chatId, "⚠️ Minimum withdrawal is ₦1000.");
    } else {
      bot.sendMessage(chatId, `💳 Your balance is ₦${user.balance.toFixed(2)}.\nPlease send your account details for payout simulation.`);
      user.awaiting_withdraw = true;
      saveUsers(users);
    }
  } else if (user.awaiting_withdraw) {
    bot.sendMessage(chatId, "✅ Withdrawal request received. Admin will process it soon!");
    delete user.awaiting_withdraw;
    saveUsers(users);
    ADMINS.forEach(adminId => {
      bot.sendMessage(adminId, `💰 New withdrawal request:\nUser: ${user.phone}\nAmount: ₦${user.balance}`);
    });
  } else if (text === "📊 My Stats") {
    bot.sendMessage(chatId, `📈 Total Waste: ${user.total_waste}kg\n💰 Balance: ₦${user.balance.toFixed(2)}`);
  } else if (text === "🛠 Admin Panel" && ADMINS.includes(chatId)) {
    bot.sendMessage(chatId, "🧰 Admin Panel:\n1️⃣ /users - View users\n2️⃣ /reset - Reset all data");
  }
});

// === Admin Commands ===
bot.onText(/\/users/, (msg) => {
  if (!ADMINS.includes(msg.chat.id)) return;
  const users = loadUsers();
  let list = users.map(u => `${u.phone || 'unknown'} - ₦${u.balance}`).join('\n');
  bot.sendMessage(msg.chat.id, `👥 Users:\n${list || 'No users yet.'}`);
});

bot.onText(/\/reset/, (msg) => {
  if (!ADMINS.includes(msg.chat.id)) return;
  fs.writeFileSync(USERS_FILE, '[]');
  bot.sendMessage(msg.chat.id, "🧹 All user data reset successfully.");
});

console.log("🤖 Bot started successfully...");
