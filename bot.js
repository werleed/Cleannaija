require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// === TWILIO SETUP ===
const twilio = require("twilio")(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// === FOLDERS ===
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const USERS_FILE = path.join(DATA_DIR, "users.json");
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]");

function loadUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function findUser(id) {
  return loadUsers().find((u) => u.id === id);
}
function updateUser(user) {
  const users = loadUsers();
  const i = users.findIndex((u) => u.id === user.id);
  if (i >= 0) users[i] = user;
  else users.push(user);
  saveUsers(users);
}

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const pendingVerify = {};

// === START COMMAND ===
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  let user = findUser(userId);

  if (!user) {
    user = {
      id: userId,
      username: ctx.from.username || "",
      first_name: ctx.from.first_name || "",
      phone: "",
      verified: false,
      wallet: 0,
      referrals: [],
    };
    updateUser(user);
  }

  if (!user.verified) {
    return ctx.reply(
      "👋 Welcome to Clean Naija Bot!\n\nPlease verify your phone number to continue:",
      Markup.keyboard([
        [Markup.button.contactRequest("📞 Use my Telegram number")],
        ["📱 Enter a new number"],
      ])
        .oneTime()
        .resize()
    );
  }

  ctx.reply("✅ You’re already verified! Type /menu to open your dashboard.");
});

// === HANDLE CONTACT ===
bot.on("contact", async (ctx) => {
  const phone = ctx.message.contact.phone_number;
  const userId = ctx.from.id;

  const user = findUser(userId);
  if (!user) return ctx.reply("Unexpected error. Try /start again.");

  user.phone = phone;
  updateUser(user);

  await sendOTP(ctx, phone);
});

// === HANDLE MANUAL PHONE ENTRY ===
bot.hears("📱 Enter a new number", (ctx) => {
  ctx.reply("Please send your phone number (include +234 country code):");
  pendingVerify[ctx.from.id] = { step: "await_phone" };
});

bot.on("text", async (ctx) => {
  const state = pendingVerify[ctx.from.id];

  if (state && state.step === "await_phone") {
    const phone = ctx.message.text.trim();
    if (!phone.startsWith("+")) {
      return ctx.reply("❌ Invalid format. Please use +234XXXXXXXXXX");
    }

    const user = findUser(ctx.from.id);
    user.phone = phone;
    updateUser(user);

    await sendOTP(ctx, phone);
    delete pendingVerify[ctx.from.id];
  } else if (state && state.step === "await_code") {
    await verifyCode(ctx, ctx.message.text.trim());
  }
});

// === SEND OTP VIA TWILIO ===
async function sendOTP(ctx, phone) {
  try {
    await twilio.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verifications.create({ to: phone, channel: "sms" });

    pendingVerify[ctx.from.id] = { step: "await_code", phone };
    ctx.reply("📨 OTP sent! Please enter the 6-digit code you received via SMS.");
  } catch (e) {
    console.error("OTP error:", e.message);
    ctx.reply("❌ Failed to send OTP. Try again later.");
  }
}

// === VERIFY CODE ===
async function verifyCode(ctx, code) {
  const userId = ctx.from.id;
  const phone = pendingVerify[userId]?.phone;
  if (!phone) return ctx.reply("Session expired. Use /start again.");

  try {
    const check = await twilio.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verificationChecks.create({ to: phone, code });

    if (check.status === "approved") {
      const user = findUser(userId);
      user.verified = true;
      updateUser(user);
      delete pendingVerify[userId];

      ctx.reply(
        "✅ Verification successful! Welcome to Clean Naija 🌍\nUse /menu to continue."
      );
    } else {
      ctx.reply("❌ Invalid code. Try again.");
    }
  } catch (e) {
    console.error("Verify error:", e.message);
    ctx.reply("❌ Error verifying code. Try again.");
  }
}

// === MENU ===
bot.command("menu", (ctx) => {
  const user = findUser(ctx.from.id);
  if (!user?.verified) return ctx.reply("⚠️ Verify first using /start");

  ctx.reply(
    "🌍 Clean Naija Dashboard:\nChoose an option below:",
    Markup.keyboard([
      ["♻️ Detect Waste", "💰 My Wallet"],
      ["👥 Referrals", "📩 Complaints"],
    ])
      .resize()
      .persistent()
  );
});

// === WASTE DETECTION SIMULATION ===
bot.hears("♻️ Detect Waste", (ctx) => {
  ctx.reply(
    "📸 Send a photo or description of your waste. I’ll estimate its type and recycling reward."
  );
});

bot.on("photo", async (ctx) => {
  ctx.reply("🔍 Analyzing waste image...");
  setTimeout(() => {
    const reward = Math.floor(Math.random() * 200 + 100);
    const user = findUser(ctx.from.id);
    user.wallet += reward;
    updateUser(user);
    ctx.reply(`✅ Detected recyclable waste! ₦${reward} added to your wallet.`);
  }, 2000);
});

// === WALLET ===
bot.hears("💰 My Wallet", (ctx) => {
  const user = findUser(ctx.from.id);
  ctx.reply(`💵 Wallet Balance: ₦${user.wallet}`);
});

// === REFERRALS ===
bot.hears("👥 Referrals", (ctx) => {
  const user = findUser(ctx.from.id);
  ctx.reply(
    `🔗 Share this link:\nhttps://t.me/${ctx.botInfo.username}?start=${ctx.from.id}\n\nYou’ve referred ${user.referrals.length} users!`
  );
});

// === COMPLAINTS ===
bot.hears("📩 Complaints", (ctx) => {
  ctx.reply("📝 Please type your complaint:");
  pendingVerify[ctx.from.id] = { step: "await_complaint" };
});

bot.on("text", (ctx) => {
  const state = pendingVerify[ctx.from.id];
  if (state?.step === "await_complaint") {
    const msg = ctx.message.text;
    fs.appendFileSync(
      path.join(DATA_DIR, "complaints.txt"),
      `${ctx.from.id} (${ctx.from.username}): ${msg}\n`
    );
    ctx.reply("✅ Complaint submitted. Thank you!");
    delete pendingVerify[ctx.from.id];
  }
});

// === ADMIN COMMANDS ===
bot.command("admin", (ctx) => {
  if (String(ctx.from.id) !== process.env.ADMIN_ID)
    return ctx.reply("❌ Unauthorized");
  ctx.reply("👑 Admin Panel:\n/users\n/complaints\n/broadcast");
});

bot.command("users", (ctx) => {
  if (String(ctx.from.id) !== process.env.ADMIN_ID) return;
  const users = loadUsers();
  ctx.reply(`👥 Total Users: ${users.length}`);
});

// === LAUNCH BOT ===
bot.launch();
console.log("✅ Clean Naija Bot running...");
