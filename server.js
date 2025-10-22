import dotenv from "dotenv";
import express from "express";
import { Telegraf, Markup } from "telegraf";
import fs from "fs";
import path from "path";
import twilio from "twilio";

dotenv.config();

// --- ENVIRONMENT VARIABLES ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID;
const PORT = process.env.PORT || 8080;

// --- VALIDATION ---
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN missing in .env");
  process.exit(1);
}

// --- TWILIO CLIENT ---
const twilioClient = twilio(TWILIO_SID, TWILIO_AUTH);

// --- TELEGRAM BOT ---
const bot = new Telegraf(BOT_TOKEN);

// --- STORAGE SETUP ---
const DATA_DIR = path.resolve("./data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const USERS_FILE = path.join(DATA_DIR, "users.json");
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]");

// --- HELPERS ---
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function findUser(id) {
  const users = loadUsers();
  return users.find(u => u.id === id);
}

function updateUser(user) {
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === user.id);
  if (idx !== -1) users[idx] = user;
  else users.push(user);
  saveUsers(users);
}

// --- START COMMAND ---
bot.start(async (ctx) => {
  const tgId = ctx.from.id;
  const user = findUser(tgId) || { id: tgId, name: ctx.from.first_name, verified: false };
  updateUser(user);
  await ctx.reply(
    `👋 Welcome to *Clean Naija Waste Bot*\n\nWe help you request waste pickups, earn rewards, and contact your local authorities easily.`,
    { parse_mode: "Markdown" }
  );
  await ctx.reply("📱 Please share or enter your phone number to verify your account.", Markup.keyboard([
    [Markup.button.contactRequest("📞 Share my number")]
  ]).oneTime().resize());
});

// --- CONTACT HANDLER ---
bot.on("contact", async (ctx) => {
  const contact = ctx.message.contact;
  const user = findUser(ctx.from.id) || { id: ctx.from.id, name: ctx.from.first_name };
  user.phone = contact.phone_number;
  updateUser(user);

  try {
    await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
      .verifications.create({ to: user.phone, channel: "sms" });

    await ctx.reply(`✅ Verification code sent to ${user.phone}. Please enter the 6-digit code.`);
  } catch (e) {
    await ctx.reply("❌ Failed to send verification. Please try again later.");
    console.error(e);
  }
});

// --- OTP CODE HANDLER ---
bot.on("text", async (ctx) => {
  const user = findUser(ctx.from.id);
  if (!user || !user.phone) return;

  const text = ctx.message.text.trim();

  if (/^\d{6}$/.test(text)) {
    try {
      const res = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID)
        .verificationChecks.create({ to: user.phone, code: text });

      if (res.status === "approved") {
        user.verified = true;
        updateUser(user);
        await ctx.reply("🎉 Verification successful! Welcome aboard, you can now use all features.");
        return;
      }
      await ctx.reply("❌ Invalid or expired code. Try again.");
    } catch (err) {
      await ctx.reply("⚠️ Error verifying your code. Try again later.");
      console.error(err);
    }
  }
});

// --- ADMIN COMMANDS ---
bot.command("admin", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("🚫 You are not an admin.");
  await ctx.reply("⚙️ Admin Menu:", Markup.inlineKeyboard([
    [Markup.button.callback("📊 View Stats", "stats")],
    [Markup.button.callback("💸 Process Withdrawal", "withdrawal")]
  ]));
});

// --- EXPRESS SERVER ---
const app = express();
app.get("/", (req, res) => {
  res.send("✅ Clean Naija Bot is running perfectly!");
});

app.listen(PORT, async () => {
  console.log(`✅ Server listening on port ${PORT}`);
  await bot.launch();
  console.log("🤖 Telegram bot is live!");
});

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
