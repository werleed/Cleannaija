/**
 * Clean9ja Telegram Bot v2.1.0
 * - Multi-language onboarding
 * - Twilio Verify (optional) with mock fallback
 * - Scan (online/offline simulated)
 * - Complaints submission + admin approval + complaint bonus
 * - Withdrawals (user request -> admin approve/decline -> payout simulation)
 * - Send money to other users by @username or verified phone
 * - Admin tools and broadcast
 * - Auto-create data files and robust error handling
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const dotenv = require("dotenv");
dotenv.config();

const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PORT = process.env.PORT || 8080;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID || "";
const ENABLE_POLLING = process.env.ENABLE_POLLING !== "false"; // set false to use webhook (not implemented here)
const INIT_ADMIN_ID = process.env.INIT_ADMIN_ID || null; // optional initial admin

if (!TOKEN) console.warn("⚠ TELEGRAM_TOKEN not set. Bot will still start but cannot connect without a token.");

// === DATA FILES & helpers ===
const DATA_DIR = path.resolve(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const filePath = (name) => path.join(DATA_DIR, name + ".json");
const USER_FILE = filePath("users");
const TRANSACTIONS_FILE = filePath("transactions");
const ADMIN_FILE = filePath("admin");
const WITHDRAWALS_FILE = filePath("withdrawals");
const OTP_STORE_FILE = filePath("otp_store");
const COMPLAINTS_FILE = filePath("complaints");

// ensure exist
const ensureFile = (p, init) => {
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(init, null, 2));
};
ensureFile(USER_FILE, []);
ensureFile(TRANSACTIONS_FILE, []);
ensureFile(ADMIN_FILE, { admins: [] });
ensureFile(WITHDRAWALS_FILE, []);
ensureFile(OTP_STORE_FILE, {});
ensureFile(COMPLAINTS_FILE, []);

// safe json read/write
const readJSON = (p) => {
  try { return JSON.parse(fs.readFileSync(p)); } catch (e) { console.error("readJSON error", p, e); return null; }
};
const writeJSON = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

function getUsers() { return readJSON(USER_FILE) || []; }
function saveUsers(u) { writeJSON(USER_FILE, u); }
function getTransactions() { return readJSON(TRANSACTIONS_FILE) || []; }
function saveTransactions(t) { writeJSON(TRANSACTIONS_FILE, t); }
function getAdminCfg() { return readJSON(ADMIN_FILE) || { admins: [] }; }
function saveAdminCfg(c) { writeJSON(ADMIN_FILE, c); }
function getWithdrawals() { return readJSON(WITHDRAWALS_FILE) || []; }
function saveWithdrawals(w) { writeJSON(WITHDRAWALS_FILE, w); }
function getComplaints() { return readJSON(COMPLAINTS_FILE) || []; }
function saveComplaints(c) { writeJSON(COMPLAINTS_FILE, c); }

// utilities
function findUser(id) { return getUsers().find(u => u.id === id); }
function findUserByPhone(phone) { return getUsers().find(u => u.phone === phone); }
function findUserByUsername(un) { if (!un) return null; if (un.startsWith("@")) un = un.slice(1); return getUsers().find(u => u.username === un); }
function upsertUser(obj) {
  const users = getUsers();
  const idx = users.findIndex(u => u.id === obj.id);
  if (idx === -1) users.push(obj); else users[idx] = { ...users[idx], ...obj };
  saveUsers(users);
}
function addTransaction({ userId, type, amount, note }) {
  const tx = getTransactions();
  tx.push({ id: `tx_${Date.now()}`, userId, type, amount, note: note || "", ts: new Date().toISOString() });
  saveTransactions(tx);
}

// === Twilio or Mock ===
let verifyService;
try {
  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_VERIFY_SID) {
    const Twilio = require("twilio");
    const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    verifyService = {
      send: async (phone) => {
        const res = await client.verify.services(TWILIO_VERIFY_SID).verifications.create({ to: phone, channel: "sms" });
        return { success: true, sid: res.sid };
      },
      check: async (phone, code) => {
        const res = await client.verify.services(TWILIO_VERIFY_SID).verificationChecks.create({ to: phone, code });
        return { success: res.status === "approved", raw: res };
      }
    };
    console.info("✅ Twilio Verify enabled.");
  } else throw new Error("twilio not configured");
} catch (e) {
  console.warn("⚠ Twilio not configured or failed. Using mock verify service.");
  verifyService = require("./mock-twilio");
}

// === LANGS & MENU (as screenshot) ===
const LANGS = {
  en: { name: "English", welcome: "Welcome to Clean9ja. Use the menu below to interact. Ask for Help anytime." },
  ha: { name: "Hausa", welcome: "Barka da zuwa Clean9ja. Yi amfani da menu a ƙasa." },
  yo: { name: "Yoruba", welcome: "Kaabo si Clean9ja. Lo akojọ aṣayan ni isalẹ." },
  fr: { name: "French", welcome: "Bienvenue sur Clean9ja. Utilisez le menu ci-dessous." },
  tw: { name: "Twi", welcome: "Akwaaba Clean9ja. Fa menu no so." },
};

// Start bot
const bot = new TelegramBot(TOKEN, { polling: ENABLE_POLLING });

bot.on("polling_error", (err) => {
  console.error("[polling_error]", err);
  // Log but don't crash; if you see ETELEGRAM 409, only one instance should run.
});

// express health
const app = express();
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.listen(PORT, () => console.log(`Express listening on ${PORT}`));

// menu markup helper
function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "Scan Waste ♻️" }, { text: "Balance 💰" }],
        [{ text: "Withdraw ➖" }, { text: "Verify Phone 📱" }],
        [{ text: "Complaints 📝" }, { text: "Send Money ➡️" }],
        [{ text: "Menu 📋" }, { text: "Help ❓" }]
      ],
      resize_keyboard: true
    }
  };
}

// === /start ===
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const user = findUser(chatId);
  if (!user) {
    // prompt language
    const langButtons = Object.keys(LANGS).map(k => ({ text: LANGS[k].name, callback_data: `lang_${k}` }));
    const inline = [];
    for (let i=0;i<langButtons.length;i+=2) inline.push(langButtons.slice(i, i+2));
    bot.sendMessage(chatId, "🌍 Please choose your language:", { reply_markup: { inline_keyboard: inline } });
    return;
  }
  const text = LANGS[user.lang]?.welcome || LANGS.en.welcome;
  bot.sendMessage(chatId, "Please choose an option from the menu below:\n\n" + text, mainMenu());
});

// language selection
bot.on("callback_query", (q) => {
  try {
    const chatId = q.message.chat.id;
    const data = q.data || "";
    if (data.startsWith("lang_")) {
      const lang = data.split("_")[1];
      upsertUser({ id: chatId, lang, verified: false, balance: 0, username: q.from.username || null });
      bot.answerCallbackQuery(q.id, { text: `Language set to ${LANGS[lang].name}` });
      bot.sendMessage(chatId, LANGS[lang].welcome, mainMenu());
    } else if (data.startsWith("complaint_approve_") || data.startsWith("complaint_decline_")) {
      // admin inline actions for complaints might be handled here
      bot.answerCallbackQuery(q.id);
    }
  } catch (e) {
    console.error("callback_query error", e);
  }
});

// Generic message handler (menu + commands)
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // ignore forwarded messages without text etc.
  if (!text) return;

  // Keep usernames up-to-date
  if (msg.from && msg.from.username) {
    const u = findUser(chatId) || { id: chatId, balance: 0, verified: false };
    u.username = msg.from.username;
    upsertUser(u);
  }

  // Commands & menu options:
  if (text === "Menu 📋" || text === "/menu") return bot.sendMessage(chatId, "Please choose an option from the menu below:", mainMenu());
  if (text === "Help ❓" || text === "/help") {
    const help = [
      "Help — Clean9ja Bot",
      "/start - Restart onboarding",
      "Scan Waste ♻️ - Scan and price your waste (simulated)",
      "Balance 💰 - Show wallet balance",
      "Withdraw ➖ - Request withdrawal",
      "Verify Phone 📱 - Verify phone with OTP",
      "Complaints 📝 - Report illegal dump or request pickup",
      "Send Money ➡️ - Transfer to another user",
      "/admin - admin commands (admins only)"
    ].join("\n");
    return bot.sendMessage(chatId, help);
  }

  if (text === "Balance 💰" || text === "/balance") {
    const u = findUser(chatId) || { balance: 0 };
    const bal = Number(u.balance || 0).toFixed(2);
    return bot.sendMessage(chatId, `💰 Balance: ₦${bal}`);
  }

  if (text === "Verify Phone 📱" || text === "/verify") return startVerificationFlow(chatId);
  if (text === "Scan Waste ♻️" || text === "/scan") return handleScan(chatId, msg);
  if (text === "Withdraw ➖" || text === "/withdraw") return startWithdrawFlow(chatId);
  if (text === "Complaints 📝" || text === "/complaints") return startComplaintFlow(chatId, msg);
  if (text === "Send Money ➡️" || text === "/send") return startSendMoneyFlow(chatId);
  if (text.startsWith("/admin")) return handleAdminCommand(chatId, text);

  // Fallback: keep menu friendly
  const u = findUser(chatId);
  if (u) return bot.sendMessage(chatId, "I didn't understand that command. Use the menu below.", mainMenu());
  return bot.sendMessage(chatId, "Send /start to begin.");
});

// --------------------- Verification flow ---------------------
async function startVerificationFlow(chatId) {
  await bot.sendMessage(chatId, "Please enter your phone number in international format (e.g., +2349012345678). Send /cancel to stop.");
  const phoneListener = async (m) => {
    if (m.chat.id !== chatId) return;
    if (!m.text) return;
    const val = m.text.trim();
    if (val === "/cancel") { bot.sendMessage(chatId, "Verification cancelled."); bot.removeListener("message", phoneListener); return; }
    if (!val.startsWith("+") || val.length < 8) { bot.sendMessage(chatId, "Invalid phone format — use + countrycode. Try again or /cancel."); bot.removeListener("message", phoneListener); return; }

    try {
      await bot.sendMessage(chatId, `Sending verification code to ${val} ...`);
      const r = await verifyService.send(val);
      await bot.sendMessage(chatId, "✅ Code sent. Please reply with the 6-digit code you received (or /cancel).");
      // wait for code
      const codeListener = async (m2) => {
        if (m2.chat.id !== chatId) return;
        if (!m2.text) return;
        const code = m2.text.trim();
        if (code === "/cancel") { bot.sendMessage(chatId, "Verification cancelled."); bot.removeListener("message", codeListener); return; }
        try {
          const check = await verifyService.check(val, code);
          if (check.success) {
            upsertUser({ id: chatId, phone: val, verified: true, lang: (findUser(chatId)||{}).lang || "en" });
            bot.sendMessage(chatId, "✅ Phone verified successfully. You may now withdraw or receive transfers.");
            bot.removeListener("message", codeListener);
          } else {
            bot.sendMessage(chatId, "❌ Verification failed. The code is invalid or expired. Use /verify to try again.");
            bot.removeListener("message", codeListener);
          }
        } catch (err) {
          console.error("verification check error", err);
          bot.sendMessage(chatId, "❌ Verification error occurred. Try again later or contact an admin.");
          bot.removeListener("message", codeListener);
        }
      };
      bot.on("message", codeListener);
    } catch (err) {
      console.error("verification send error", err);
      bot.sendMessage(chatId, "❌ Failed to send OTP. Admin must configure Twilio or use offline mock.");
    } finally {
      bot.removeListener("message", phoneListener);
    }
  };
  bot.on("message", phoneListener);
}

// --------------------- Scan flow ---------------------
async function handleScan(chatId, msg) {
  // simulate online/offline scanning
  const online = Math.random() > 0.3; // 70% online simulated
  const simulated = {
    wasteType: ["Plastic Bottle", "Glass Bottle", "Paper/Cardboard", "Metal Can"][Math.floor(Math.random()*4)],
    cleanlinessScore: Math.floor(Math.random()*60) + 30, // 30-90
    estimatedKg: (Math.random() * 2 + 0.2).toFixed(2)
  };
  const basePricePerKg = 700; // you asked earlier e.g., 700 naira per kg
  const price = (parseFloat(simulated.estimatedKg) * basePricePerKg).toFixed(2);

  const sourceText = online ? "Online scan (AI model) result" : "Offline scan (simulated)";
  const keyboard = { reply_markup: { keyboard: [[{ text: `Accept ₦${price}` }, { text: "Reject" }]], one_time_keyboard: true, resize_keyboard: true } };

  await bot.sendMessage(chatId, `🔎 ${sourceText}:\n• Waste: ${simulated.wasteType}\n• Cleanliness: ${simulated.cleanlinessScore}%\n• Estimated weight: ${simulated.estimatedKg} kg\n• Estimated price: ₦${price}\n\nDo you accept this price?`, keyboard);

  const listener = (m) => {
    if (m.chat.id !== chatId) return;
    if (!m.text) return;
    const t = m.text.trim();
    if (t.startsWith("Accept")) {
      const u = findUser(chatId) || { id: chatId, balance: 0, verified: false };
      u.balance = (Number(u.balance || 0) + Number(price));
      upsertUser(u);
      addTransaction({ userId: chatId, type: "scan_credit", amount: Number(price), note: simulated.wasteType });
      bot.sendMessage(chatId, `✅ Accepted. ₦${price} added to your balance. Current balance: ₦${u.balance.toFixed(2)}`, mainMenu());
      bot.removeListener("message", listener);
    } else if (t === "Reject") {
      bot.sendMessage(chatId, "Scan rejected. No changes made.", mainMenu());
      bot.removeListener("message", listener);
    } else {
      // ignore unrelated messages
    }
  };

  bot.on("message", listener);
}

// --------------------- Complaints flow ---------------------
async function startComplaintFlow(chatId, msg) {
  const user = findUser(chatId) || { id: chatId, balance: 0, verified: false, lang: "en" };
  await bot.sendMessage(chatId, "Please describe the dump/issue and include nearest address or LGA. You may also send a photo. Send /cancel to stop.");

  const collector = async (m) => {
    if (m.chat.id !== chatId) return;
    if (m.text && m.text.trim() === "/cancel") { bot.sendMessage(chatId, "Complaint cancelled."); bot.removeListener("message", collector); return; }

    // Collect text and optionally photo and location
    let complaint = {
      id: `cmp_${Date.now()}`,
      userId: chatId,
      text: m.text || (m.caption || ""),
      photo: null,
      location: m.location || null,
      lga: null,
      status: "pending",
      ts: new Date().toISOString()
    };

    if (m.photo && m.photo.length) {
      // store file_id so admin can view
      complaint.photo = m.photo[m.photo.length - 1].file_id;
    }
    // if location provided, store lat/lon - user may include text LGA in message
    if (m.location) complaint.location = m.location;

    // parse LGA from text heuristically
    if (complaint.text) {
      // very naive extraction: look for "LGA" or words like "Area" etc. Keep simple
      complaint.lga = complaint.text.match(/LGA[:\s]*([A-Za-z0-9\s]+)/i)?.[1] || null;
    }

    // Save complaint
    const complaints = getComplaints();
    complaints.push(complaint);
    saveComplaints(complaints);

    bot.sendMessage(chatId, `✅ Complaint received. Ref: ${complaint.id}. An admin will review this in due course. If approved you'll get a bonus.`);
    notifyAdmins(`New Complaint: ${complaint.id}\nUser: ${chatId}\nText: ${complaint.text || "[no-text]"}\n\nUse /admin list_complaints to review.`);

    bot.removeListener("message", collector);
  };

  bot.on("message", collector);
}

// Admin review for complaints (via /admin)
function adminApproveComplaint(adminId, complaintId) {
  const cfg = getAdminCfg();
  if (!cfg.admins.includes(adminId)) return bot.sendMessage(adminId, "Unauthorized.");

  const complaints = getComplaints();
  const c = complaints.find(x => x.id === complaintId);
  if (!c) return bot.sendMessage(adminId, "Complaint not found.");
  if (c.status !== "pending") return bot.sendMessage(adminId, "Already processed.");

  c.status = "approved";
  c.approvedBy = adminId;
  c.approvedAt = new Date().toISOString();
  saveComplaints(complaints);

  // give bonus to user wallet (e.g., 700 naira)
  const bonus = 700;
  const users = getUsers();
  const idx = users.findIndex(u => u.id === c.userId);
  if (idx !== -1) {
    users[idx].balance = (Number(users[idx].balance || 0) + bonus);
    saveUsers(users);
    addTransaction({ userId: c.userId, type: "complaint_bonus", amount: bonus, note: `complaint ${c.id} approved` });
    bot.sendMessage(c.userId, `✅ Your complaint ${c.id} was approved. A bonus of ₦${bonus} has been added to your wallet. Current balance: ₦${users[idx].balance.toFixed(2)}`);
  } else {
    bot.sendMessage(adminId, `Warning: user ${c.userId} not found for complaint ${c.id}.`);
  }

  bot.sendMessage(adminId, `Complaint ${c.id} approved and bonus credited.`);
}

function adminDeclineComplaint(adminId, complaintId) {
  const cfg = getAdminCfg();
  if (!cfg.admins.includes(adminId)) return bot.sendMessage(adminId, "Unauthorized.");
  const complaints = getComplaints();
  const c = complaints.find(x => x.id === complaintId);
  if (!c) return bot.sendMessage(adminId, "Complaint not found.");
  if (c.status !== "pending") return bot.sendMessage(adminId, "Already processed.");
  c.status = "declined";
  c.declinedBy = adminId;
  c.declinedAt = new Date().toISOString();
  saveComplaints(complaints);
  bot.sendMessage(c.userId, `❌ Your complaint ${c.id} was declined by admin ${adminId}.`);
  bot.sendMessage(adminId, `Complaint ${c.id} declined.`);
}

// --------------------- Withdraw flow ---------------------
function startWithdrawFlow(chatId) {
  const user = findUser(chatId);
  if (!user) return bot.sendMessage(chatId, "Please /start to register first.");
  if (!user.verified) return bot.sendMessage(chatId, "You must verify your phone before withdrawing. Use Verify Phone.");

  bot.sendMessage(chatId, `Your balance: ₦${(user.balance||0).toFixed(2)}\nEnter amount to withdraw or send /cancel.`);

  const listener = (m) => {
    if (m.chat.id !== chatId) return;
    const text = (m.text || "").trim();
    if (text === "/cancel") { bot.sendMessage(chatId, "Withdraw cancelled."); bot.removeListener("message", listener); return; }
    const amount = parseFloat(text);
    if (!amount || amount <= 0) { bot.sendMessage(chatId, "Invalid amount. Enter a valid number or /cancel."); return; }
    if (amount > (user.balance || 0)) { bot.sendMessage(chatId, "Insufficient balance."); bot.removeListener("message", listener); return; }

    // create withdrawal request
    const withdrawals = getWithdrawals();
    const req = { id: `wd_${Date.now()}`, userId: chatId, amount, status: "pending", ts: new Date().toISOString(), phone: user.phone || null };
    withdrawals.push(req);
    saveWithdrawals(withdrawals);

    // temp deduct
    user.balance = (Number(user.balance || 0) - amount);
    upsertUser(user);
    addTransaction({ userId: chatId, type: "withdraw_request", amount: -amount, note: req.id });

    bot.sendMessage(chatId, `✅ Withdrawal request created: ${req.id}. Awaiting admin approval.`, mainMenu());
    notifyAdmins(`New withdrawal request: ${req.id}\nUser: ${chatId}\nAmount: ₦${amount}\nUse /admin list_withdrawals to manage.`);
    bot.removeListener("message", listener);
  };

  bot.on("message", listener);
}

// Admin approve/decline (for withdrawals)
async function adminApprove(adminChatId, withdrawId) {
  const cfg = getAdminCfg();
  if (!cfg.admins.includes(adminChatId)) return bot.sendMessage(adminChatId, "Unauthorized.");
  const withdrawals = getWithdrawals();
  const r = withdrawals.find(x => x.id === withdrawId);
  if (!r) return bot.sendMessage(adminChatId, "Withdrawal not found.");
  if (r.status !== "pending") return bot.sendMessage(adminChatId, "Already processed.");

  r.status = "approved";
  r.approvedBy = adminChatId;
  r.approvedAt = new Date().toISOString();
  saveWithdrawals(withdrawals);

  addTransaction({ userId: r.userId, type: "withdraw_approved", amount: -r.amount, note: `approved ${withdrawId}` });

  bot.sendMessage(adminChatId, `Withdrawal ${withdrawId} approved. Mark payout done manually (or integrate real payout service).`);
  bot.sendMessage(r.userId, `✅ Your withdrawal ${withdrawId} of ₦${r.amount} has been approved by admin ${adminChatId}.`);
}

async function adminDecline(adminChatId, withdrawId) {
  const cfg = getAdminCfg();
  if (!cfg.admins.includes(adminChatId)) return bot.sendMessage(adminChatId, "Unauthorized.");
  const withdrawals = getWithdrawals();
  const r = withdrawals.find(x => x.id === withdrawId);
  if (!r) return bot.sendMessage(adminChatId, "Withdrawal not found.");
  if (r.status !== "pending") return bot.sendMessage(adminChatId, "Already processed.");

  r.status = "declined";
  r.declinedBy = adminChatId;
  r.declinedAt = new Date().toISOString();
  saveWithdrawals(withdrawals);

  // refund user
  const users = getUsers();
  const idx = users.findIndex(u => u.id === r.userId);
  if (idx !== -1) {
    users[idx].balance = (Number(users[idx].balance || 0) + r.amount);
    saveUsers(users);
    addTransaction({ userId: r.userId, type: "withdraw_declined_refund", amount: r.amount, note: withdrawId });
  }

  bot.sendMessage(adminChatId, `Withdrawal ${withdrawId} declined and amount refunded.`);
  bot.sendMessage(r.userId, `❌ Your withdrawal ${withdrawId} was declined by admin ${adminChatId}. Amount refunded.`);
}

// --------------------- Send money to other users ---------------------
function startSendMoneyFlow(chatId) {
  const user = findUser(chatId);
  if (!user) return bot.sendMessage(chatId, "Please /start to register first.");
  bot.sendMessage(chatId, "To send money: reply with recipient (use @username or verified phone number) and amount separated by space.\nExample: @alice 500  OR  +2349012345678 500\nSend /cancel to stop.");

  const listener = (m) => {
    if (m.chat.id !== chatId) return;
    const t = (m.text || "").trim();
    if (t === "/cancel") { bot.sendMessage(chatId, "Send money cancelled."); bot.removeListener("message", listener); return; }

    const parts = t.split(/\s+/);
    if (parts.length < 2) { bot.sendMessage(chatId, "Invalid format. Example: @alice 500"); return; }
    const recipient = parts[0];
    const amount = parseFloat(parts[1]);
    if (isNaN(amount) || amount <= 0) { bot.sendMessage(chatId, "Invalid amount."); return; }

    let targetUser = null;
    if (recipient.startsWith("+")) targetUser = findUserByPhone(recipient);
    else targetUser = findUserByUsername(recipient);

    if (!targetUser) { bot.sendMessage(chatId, "Recipient not found or not registered with bot."); bot.removeListener("message", listener); return; }
    if ((user.balance || 0) < amount) { bot.sendMessage(chatId, "Insufficient balance."); bot.removeListener("message", listener); return; }

    // transfer
    user.balance = (Number(user.balance || 0) - amount);
    upsertUser(user);
    targetUser.balance = (Number(targetUser.balance || 0) + amount);
    upsertUser(targetUser);
    addTransaction({ userId: chatId, type: "transfer_out", amount: -amount, note: `to ${targetUser.id}` });
    addTransaction({ userId: targetUser.id, type: "transfer_in", amount: amount, note: `from ${chatId}` });

    bot.sendMessage(chatId, `✅ Sent ₦${amount.toFixed(2)} to ${recipient}. Your new balance: ₦${user.balance.toFixed(2)}`);
    bot.sendMessage(targetUser.id, `✅ You received ₦${amount.toFixed(2)} from @${user.username || user.id}. New balance: ₦${targetUser.balance.toFixed(2)}`);
    bot.removeListener("message", listener);
  };

  bot.on("message", listener);
}

// --------------------- Admin commands ---------------------
function handleAdminCommand(chatId, text) {
  const cfg = getAdminCfg();
  if (!cfg.admins.includes(chatId)) return bot.sendMessage(chatId, "Unauthorized. You are not an admin.");

  const parts = text.split(" ");
  // /admin list_withdrawals
  const cmd = parts[1] || "";
  if (cmd === "list_withdrawals") {
    const w = getWithdrawals();
    if (!w.length) return bot.sendMessage(chatId, "No withdrawals.");
    const s = w.map(r => `${r.id} - ${r.userId} - ₦${r.amount} - ${r.status}`).join("\n");
    return bot.sendMessage(chatId, `Withdrawals:\n${s}`);
  }
  if (cmd === "approve" && parts[2]) return adminApprove(chatId, parts[2]);
  if (cmd === "decline" && parts[2]) return adminDecline(chatId, parts[2]);
  if (cmd === "list_complaints") {
    const c = getComplaints();
    if (!c.length) return bot.sendMessage(chatId, "No complaints.");
    const s = c.map(x => `${x.id} - ${x.userId} - ${x.status} - ${x.text?.slice(0,60)}`).join("\n");
    return bot.sendMessage(chatId, `Complaints:\n${s}`);
  }
  if (cmd === "approve_complaint" && parts[2]) return adminApproveComplaint(chatId, parts[2]);
  if (cmd === "decline_complaint" && parts[2]) return adminDeclineComplaint(chatId, parts[2]);
  if (cmd === "broadcast") {
    const msg = parts.slice(2).join(" ");
    return broadcastToAll(msg, chatId);
  }
  if (cmd === "addadmin" && parts[2]) {
    const newAdmin = parseInt(parts[2], 10);
    const cfg = getAdminCfg();
    if (!cfg.admins.includes(newAdmin)) { cfg.admins.push(newAdmin); saveAdminCfg(cfg); return bot.sendMessage(chatId, `Added admin ${newAdmin}`); }
    return bot.sendMessage(chatId, `User ${newAdmin} already admin`);
  }

  bot.sendMessage(chatId, "Admin commands:\n/admin list_withdrawals\n/admin approve <id>\n/admin decline <id>\n/admin list_complaints\n/admin approve_complaint <id>\n/admin decline_complaint <id>\n/admin broadcast <message>\n/admin addadmin <userid>");
}

function broadcastToAll(message, requestedBy) {
  const cfg = getAdminCfg();
  if (!cfg.admins.includes(requestedBy)) return bot.sendMessage(requestedBy, "Unauthorized to broadcast.");
  const users = getUsers();
  let sent = 0;
  for (const u of users) {
    try { bot.sendMessage(u.id, `📢 Broadcast:\n${message}`); sent++; } catch (e) { /* ignore individual send errors */ }
  }
  bot.sendMessage(requestedBy, `Broadcast sent to ${sent} users.`);
}

// notify admin helper
function notifyAdmins(message) {
  const cfg = getAdminCfg();
  if (!cfg || !cfg.admins || cfg.admins.length === 0) {
    console.warn("No admins configured to notify.");
    return;
  }
  for (const adminId of cfg.admins) {
    try {
      bot.sendMessage(adminId, message);
    } catch (e) {
      console.error("Failed to notify admin", adminId, e);
    }
  }
}

// init admin if provided
const cfg = getAdminCfg();
if ((!cfg.admins || cfg.admins.length === 0) && INIT_ADMIN_ID) {
  cfg.admins = [parseInt(INIT_ADMIN_ID, 10)];
  saveAdminCfg(cfg);
  console.log("Initialized admin from INIT_ADMIN_ID");
}

// graceful handlers
process.on("uncaughtException", (err) => {
  console.error("UncaughtException:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("UnhandledRejection:", err);
});

console.log("Clean9ja Bot started and ready.");
