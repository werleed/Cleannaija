import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";
import fs from "fs-extra";
import path from "path";
import express from "express";
import twilio from "twilio";
import axios from "axios";

dotenv.config();
const __dirname = path.resolve();

// ✅ Create /data folder
const DATA_DIR = path.join(__dirname, "data");
await fs.ensureDir(DATA_DIR);

const FILES = {
  users: path.join(DATA_DIR, "users.json"),
  waste: path.join(DATA_DIR, "waste.json"),
  withdrawals: path.join(DATA_DIR, "withdrawals.json"),
  complaints: path.join(DATA_DIR, "complaints.json"),
  referrals: path.join(DATA_DIR, "referrals.json")
};

for (const f of Object.values(FILES)) await fs.ensureFile(f);

// ✅ Helpers to read & save data
const readData = (file) => {
  try {
    const d = fs.readFileSync(file);
    return d.length ? JSON.parse(d) : [];
  } catch {
    return [];
  }
};
const saveData = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// ✅ Twilio setup
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

// ✅ Telegram bot setup
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
let pendingVerify = {};

// 🧩 Utilities
function findUser(id) {
  return readData(FILES.users).find((u) => u.telegram_id === id);
}
function saveOrUpdateUser(user) {
  const users = readData(FILES.users);
  const idx = users.findIndex((u) => u.telegram_id === user.telegram_id);
  if (idx !== -1) users[idx] = user;
  else users.push(user);
  saveData(FILES.users, users);
}

// 🎯 Command: /start
bot.start(async (ctx) => {
  const user = findUser(ctx.from.id);
  if (user?.verified) {
    return ctx.reply(`👋 Welcome back, ${ctx.from.first_name}! ✅`, Markup.keyboard([
      ["♻️ Scan Waste", "💰 My Balance"],
      ["🏆 Referrals", "📞 Support"]
    ]).resize());
  }

  await ctx.reply(
    "👋 Welcome to *CleanNaija Bot*! Please verify your phone number to continue.",
    {
      parse_mode: "Markdown",
      ...Markup.keyboard([
        [Markup.button.contactRequest("📱 Share My Number")],
        ["❌ Cancel"]
      ]).resize()
    }
  );
});

// 📱 Handle phone contact
bot.on("contact", async (ctx) => {
  const tgId = ctx.from.id;
  const contact = ctx.message.contact.phone_number;
  let user =
    findUser(tgId) || {
      telegram_id: tgId,
      username: ctx.from.username || "",
      first_name: ctx.from.first_name || "",
      phone: contact,
      verified: false,
      points: 0,
      balance: 0
    };
  user.phone = contact;
  saveOrUpdateUser(user);

  try {
    await twilioClient.verify.v2
      .services(process.env.TWILIO_SERVICE_SID)
      .verifications.create({ to: `+${contact.replace(/\D/g, "")}`, channel: "sms" });

    pendingVerify[tgId] = { phone: contact, ts: Date.now() };
    ctx.reply("📩 OTP sent! Please enter the 6-digit code you received.");
  } catch (err) {
    console.error(err);
    ctx.reply("❌ Failed to send OTP. Check your Twilio credentials or number format.");
  }
});

// 🔢 OTP Verification
bot.on("text", async (ctx) => {
  const tgId = ctx.from.id;
  const msg = ctx.message.text.trim();
  const pending = pendingVerify[tgId];

  if (pending && /^\d{6}$/.test(msg)) {
    try {
      const check = await twilioClient.verify.v2
        .services(process.env.TWILIO_SERVICE_SID)
        .verificationChecks.create({
          to: `+${pending.phone.replace(/\D/g, "")}`,
          code: msg
        });

      if (check.status === "approved") {
        const user = findUser(tgId);
        user.verified = true;
        saveOrUpdateUser(user);
        delete pendingVerify[tgId];

        ctx.reply("✅ Verification successful! Welcome to CleanNaija ♻️", Markup.keyboard([
          ["♻️ Scan Waste", "💰 My Balance"],
          ["🏆 Referrals", "📞 Support"]
        ]).resize());
      } else {
        ctx.reply("⚠️ Invalid code. Try again.");
      }
    } catch (err) {
      console.error(err);
      ctx.reply("❌ Verification failed. Please try again later.");
    }
  }
});

// ♻️ Simulated Waste Scan
bot.hears("♻️ Scan Waste", async (ctx) => {
  const user = findUser(ctx.from.id);
  if (!user?.verified) return ctx.reply("⚠️ Please verify your phone first.");

  const wasteTypes = ["Plastic", "Can", "Paper", "Glass"];
  const detected = wasteTypes[Math.floor(Math.random() * wasteTypes.length)];
  const reward = Math.floor(Math.random() * 50) + 10;

  user.points += reward;
  user.balance += reward;
  saveOrUpdateUser(user);

  ctx.reply(`🗑 Detected: *${detected}*\n💰 Earned ₦${reward}\nTotal Balance: ₦${user.balance}`, { parse_mode: "Markdown" });
});

// 💰 Balance
bot.hears("💰 My Balance", (ctx) => {
  const user = findUser(ctx.from.id);
  if (!user) return ctx.reply("❌ Not registered yet.");
  ctx.reply(`💵 Your balance: ₦${user.balance}\nPoints: ${user.points}`);
});

// 🏆 Referrals
bot.hears("🏆 Referrals", (ctx) => {
  ctx.reply("📢 Invite friends using your referral link:\nhttps://t.me/CleanNaijaBot?start=" + ctx.from.id);
});

// 📞 Support
bot.hears("📞 Support", (ctx) => {
  ctx.reply("📩 Contact Admin:\n@CleanNaijaAdmin\nPhone: +2349039475752");
});

// 🧑‍💼 Admin commands
bot.command("users", (ctx) => {
  if (ctx.from.id.toString() !== process.env.ADMIN_ID) return;
  const users = readData(FILES.users);
  ctx.reply(`👥 Total users: ${users.length}`);
});

bot.command("stats", (ctx) => {
  if (ctx.from.id.toString() !== process.env.ADMIN_ID) return;
  const users = readData(FILES.users);
  const totalBalance = users.reduce((a, b) => a + (b.balance || 0), 0);
  ctx.reply(`📊 Total Users: ${users.length}\n💰 Total Wallet: ₦${totalBalance}`);
});

// 🌍 Location Detection via Express
const app = express();
app.get("/location", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    const geo = await axios.get(`https://ipapi.co/${ip}/json/`);
    res.json({ country: geo.data.country_name, region: geo.data.region, city: geo.data.city });
  } catch {
    res.json({ error: "Could not detect location" });
  }
});
app.listen(process.env.PORT || 3000, () => console.log("🌐 Server online"));

bot.launch();
console.log("🤖 CleanNaija Bot running...");
