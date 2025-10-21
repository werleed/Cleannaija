require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

// Twilio setup
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const VERIFY_SID = process.env.TWILIO_VERIFY_SID;

// Data folder setup
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const USERS_FILE = path.join(DATA_DIR, 'users.json');
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');

// Load & save helpers
function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE)); } catch { return []; }
}
function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}
function findUser(id) {
  return readUsers().find(u => u.id === id);
}
function updateUser(u) {
  const users = readUsers();
  const idx = users.findIndex(x => x.id === u.id);
  if (idx >= 0) users[idx] = u; else users.push(u);
  saveUsers(users);
}

// ✅ OTP pending memory
const pending = {};

// 🧍 Start Command
bot.start(async (ctx) => {
  const user = ctx.from;
  let u = findUser(user.id);
  if (!u) {
    u = {
      id: user.id,
      username: user.username || '',
      name: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
      verified: false,
      phone: null,
      balance: 0,
      waste: 0,
      complaints: []
    };
    updateUser(u);
  }

  if (!u.verified) {
    return ctx.reply(
      "👋 Welcome to *Clean Naija Waste Bot!*\n\nPlease verify your phone number first to continue.",
      Markup.keyboard([[{ text: "📱 Share My Number", request_contact: true }]]).resize().oneTime()
    );
  }

  ctx.reply(
    `✅ Welcome back ${u.name}!`,
    Markup.inlineKeyboard([
      [Markup.button.callback("♻️ Report Waste", "report_waste")],
      [Markup.button.callback("💰 Withdraw", "withdraw")],
      [Markup.button.callback("📊 My Stats", "my_stats")],
      [Markup.button.callback("🗣️ Complain", "complain")]
    ])
  );
});

// 📱 Contact Handler (Start verification)
bot.on('contact', async (ctx) => {
  const contact = ctx.message.contact;
  const phone = contact.phone_number.replace(/\s|\+/g, '');
  const id = ctx.from.id;
  const user = findUser(id);

  ctx.reply(`Sending OTP to ${phone}...`);

  try {
    await client.verify.v2.services(VERIFY_SID).verifications.create({
      to: `+${phone}`,
      channel: 'sms'
    });
    pending[id] = { phone };
    ctx.reply("✅ OTP sent! Please enter the 6-digit code.");
  } catch (err) {
    ctx.reply("❌ Failed to send OTP. Please check Twilio credentials or try again.");
  }
});

// 💬 Message handler for OTP input
bot.on('text', async (ctx) => {
  const id = ctx.from.id;
  const user = findUser(id);
  const text = ctx.message.text.trim();

  // If OTP pending
  if (pending[id]) {
    if (!/^\d{6}$/.test(text)) return ctx.reply("Please enter a valid 6-digit code.");
    try {
      const result = await client.verify.v2.services(VERIFY_SID).verificationChecks.create({
        to: `+${pending[id].phone}`,
        code: text
      });
      if (result.status === "approved") {
        delete pending[id];
        user.phone = result.to;
        user.verified = true;
        updateUser(user);
        return ctx.reply("✅ Verification successful! You can now use the bot.",
          Markup.removeKeyboard());
      }
      return ctx.reply("❌ Invalid OTP. Try again.");
    } catch (err) {
      return ctx.reply("⚠️ Error verifying code. Try again later.");
    }
  }
});

// ♻️ Report Waste
bot.action("report_waste", async (ctx) => {
  const user = findUser(ctx.from.id);
  if (!user || !user.verified) return ctx.reply("Please verify your account first.");
  await ctx.reply("♻️ Enter the waste weight (in KG):");
  user.awaitingWeight = true;
  updateUser(user);
});

// Handle waste input
bot.on('message', (ctx) => {
  const id = ctx.from.id;
  const user = findUser(id);
  const text = ctx.message.text?.trim();

  if (user?.awaitingWeight && /^\d+(\.\d+)?$/.test(text)) {
    const kg = parseFloat(text);
    const rate = 50; // ₦ per KG
    const earned = kg * rate;
    user.waste += kg;
    user.balance += earned;
    user.awaitingWeight = false;
    updateUser(user);
    return ctx.reply(`✅ You reported ${kg}kg of waste.\n💰 You earned ₦${earned.toFixed(2)}.`);
  }
});

// 💰 Withdraw
bot.action("withdraw", (ctx) => {
  const user = findUser(ctx.from.id);
  if (!user || !user.verified) return ctx.reply("Please verify first.");
  ctx.reply("💳 Enter amount to withdraw:");
  user.awaitingWithdraw = true;
  updateUser(user);
});

bot.on('text', (ctx) => {
  const id = ctx.from.id;
  const user = findUser(id);
  const text = ctx.message.text?.trim();

  if (user?.awaitingWithdraw && /^\d+$/.test(text)) {
    const amt = parseFloat(text);
    if (amt > user.balance) return ctx.reply("❌ Insufficient balance.");
    user.awaitingWithdraw = false;
    updateUser(user);
    ctx.telegram.sendMessage(process.env.ADMIN_ID, `💰 New withdrawal request:\nUser: @${user.username}\nAmount: ₦${amt}`);
    return ctx.reply("✅ Withdrawal request sent to admin.");
  }
});

// 📊 My Stats
bot.action("my_stats", (ctx) => {
  const u = findUser(ctx.from.id);
  ctx.reply(`📊 Your Stats:\n\n♻️ Total Waste: ${u.waste}kg\n💰 Balance: ₦${u.balance}`);
});

// 🗣️ Complaint
bot.action("complain", (ctx) => {
  const u = findUser(ctx.from.id);
  u.awaitingComplaint = true;
  updateUser(u);
  ctx.reply("📝 Please type your complaint:");
});

bot.on('text', (ctx) => {
  const u = findUser(ctx.from.id);
  if (u?.awaitingComplaint) {
    u.complaints.push(ctx.message.text);
    u.awaitingComplaint = false;
    updateUser(u);
    ctx.reply("✅ Complaint received. Admin will review it soon.");
    ctx.telegram.sendMessage(process.env.ADMIN_ID, `🗣️ New complaint from @${u.username}:\n${ctx.message.text}`);
  }
});

// 👑 Admin commands
bot.command("admin", (ctx) => {
  if (ctx.from.id.toString() !== process.env.ADMIN_ID) return;
  ctx.reply("👑 Admin Commands:\n\n/users - View all users\n/stats - View summary");
});

bot.command("users", (ctx) => {
  if (ctx.from.id.toString() !== process.env.ADMIN_ID) return;
  const users = readUsers();
  ctx.reply(`👥 Total Users: ${users.length}`);
});

bot.command("stats", (ctx) => {
  if (ctx.from.id.toString() !== process.env.ADMIN_ID) return;
  const users = readUsers();
  const totalWaste = users.reduce((a, b) => a + (b.waste || 0), 0);
  const totalPaid = users.reduce((a, b) => a + (b.balance || 0), 0);
  ctx.reply(`📈 System Stats:\n\nUsers: ${users.length}\nTotal Waste: ${totalWaste}kg\nTotal ₦ Paid: ₦${totalPaid}`);
});

bot.launch();
console.log("✅ Clean Naija Bot is running...");
