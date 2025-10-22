/**
 * Clean9ja Telegram Bot
 * All-in-telegram admin + user features:
 * - multilingual onboarding
 * - Twilio Verify (real if configured) or mock fallback
 * - scan (mock), accept price -> credit
 * - complaint flow (optional photo) -> admin approve/decline -> bonus ₦700
 * - withdrawal requests -> admin approve/decline -> refunds
 * - transfer between users (by @username or verified phone)
 * - broadcast (admin)
 * - auto-create JSON files and recover gracefully
 *
 * Run: node bot.js
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const dotenv = require("dotenv");
dotenv.config();

// === CONFIG ===
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PORT = parseInt(process.env.PORT || "8080", 10);
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID || "";
const INIT_ADMIN_ID = process.env.INIT_ADMIN_ID ? parseInt(process.env.INIT_ADMIN_ID, 10) : null;
const COMPLAINT_BONUS = parseFloat(process.env.COMPLAINT_BONUS || "700");

// Warn if no token (bot will still start but won't work)
if (!TOKEN) console.warn("⚠️ TELEGRAM_TOKEN not set. Bot will start but cannot connect to Telegram.");

// === DATA FILES / DIR ===
const DATA_DIR = path.resolve(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const filePath = (name) => path.join(DATA_DIR, name + ".json");
const USER_FILE = filePath("users");
const TRANSACTIONS_FILE = filePath("transactions");
const ADMIN_FILE = filePath("admin");
const WITHDRAWALS_FILE = filePath("withdrawals");
const COMPLAINTS_FILE = filePath("complaints");

// Ensure files exist
const ensureFile = (p, initial = []) => {
  try {
    if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(initial, null, 2));
  } catch (e) {
    console.error("Failed to ensure file", p, e);
  }
};
ensureFile(USER_FILE, []);
ensureFile(TRANSACTIONS_FILE, []);
ensureFile(ADMIN_FILE, { admins: [] });
ensureFile(WITHDRAWALS_FILE, []);
ensureFile(COMPLAINTS_FILE, []);

// JSON helpers
const readJSON = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error("Error reading JSON", p, e);
    return null;
  }
};
const writeJSON = (p, v) => {
  try {
    fs.writeFileSync(p, JSON.stringify(v, null, 2));
  } catch (e) {
    console.error("Error writing JSON", p, e);
  }
};

// === TWILIO VERIFY OR MOCK ===
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
      },
    };
    console.log("✅ Twilio Verify enabled.");
  } else {
    throw new Error("Twilio not configured");
  }
} catch (e) {
  console.warn("⚠️ Twilio not configured or unavailable. Using mock verification service.");
  // NOTE: require local mock module (file present in repo)
  verifyService = require("./mock-twilio");
}

// === LANGUAGES (simple) ===
const LANGS = {
  en: { name: "English", welcome: "Welcome to Clean9ja. Use the menu below to interact. Ask for Help anytime." },
  ha: { name: "Hausa", welcome: "Barka da zuwa Clean9ja. Yi amfani da menu don hulɗa." },
  yo: { name: "Yoruba", welcome: "Kaabo si Clean9ja. Lo akojọ aṣayan lati ba iṣẹ sọrọ." },
  fr: { name: "French", welcome: "Bienvenue sur Clean9ja. Utilisez le menu pour interagir." },
  tw: { name: "Twi", welcome: "Akwaaba Clean9ja. Fa menu no so." },
};

// === TELEGRAM BOT ===
const bot = new TelegramBot(TOKEN, { polling: true });

// minimal express health endpoint (Railway/Docker)
const app = express();
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.listen(PORT, () => console.log(`Express listening on ${PORT}`));

// === Data helpers ===
function getUsers() {
  return readJSON(USER_FILE) || [];
}
function saveUsers(users) {
  writeJSON(USER_FILE, users);
}
function getTransactions() {
  return readJSON(TRANSACTIONS_FILE) || [];
}
function saveTransactions(tx) {
  writeJSON(TRANSACTIONS_FILE, tx);
}
function getAdminCfg() {
  return readJSON(ADMIN_FILE) || { admins: [] };
}
function saveAdminCfg(cfg) {
  writeJSON(ADMIN_FILE, cfg);
}
function getWithdrawals() {
  return readJSON(WITHDRAWALS_FILE) || [];
}
function saveWithdrawals(w) {
  writeJSON(WITHDRAWALS_FILE, w);
}
function getComplaints() {
  return readJSON(COMPLAINTS_FILE) || [];
}
function saveComplaints(c) {
  writeJSON(COMPLAINTS_FILE, c);
}

function findUser(id) {
  const users = getUsers();
  return users.find((u) => u.id === id);
}
function findUserByUsername(username) {
  if (!username) return null;
  const users = getUsers();
  return users.find((u) => u.username && u.username.toLowerCase() === username.toLowerCase());
}
function findUserByPhone(phone) {
  if (!phone) return null;
  const users = getUsers();
  return users.find((u) => u.phone === phone);
}
function upsertUser(obj) {
  const users = getUsers();
  const idx = users.findIndex((u) => u.id === obj.id);
  if (idx === -1) {
    users.push(obj);
  } else {
    users[idx] = { ...users[idx], ...obj };
  }
  saveUsers(users);
}

// transactions
function addTransaction({ userId, type, amount, note }) {
  const tx = getTransactions();
  tx.push({
    id: "tx_" + Date.now(),
    userId,
    type,
    amount,
    note,
    ts: new Date().toISOString(),
  });
  saveTransactions(tx);
}

// admin init if none
const adminCfg = getAdminCfg();
if ((!adminCfg.admins || adminCfg.admins.length === 0) && INIT_ADMIN_ID) {
  adminCfg.admins = [INIT_ADMIN_ID];
  saveAdminCfg(adminCfg);
  console.log("Initialized admin from INIT_ADMIN_ID");
}

// === Utility: professional response helper ===
function professional(text, lang = "en") {
  // Could be extended to more language variations. For now, return text unchanged.
  return text;
}

// === START: language selection if new user ===
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  // store username if present
  const username = msg.from && msg.from.username ? msg.from.username : null;
  if (username) upsertUser({ id: chatId, username });

  const user = findUser(chatId);
  if (!user) {
    // present languages as inline buttons
    const langButtons = Object.keys(LANGS).map((k) => [{ text: LANGS[k].name, callback_data: `lang_${k}` }]);
    // arrange into rows of 2
    const rows = [];
    for (let i = 0; i < langButtons.length; i += 2) rows.push(langButtons.slice(i, i + 2).flat());
    bot.sendMessage(chatId, "🌍 Please choose your language / Don zaɓi harshe:", {
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }

  const lang = user.lang || "en";
  const kb = [
    [{ text: "Scan Waste ♻️" }, { text: "Balance 💰" }],
    [{ text: "Withdraw ➖" }, { text: "Verify Phone 📱" }],
    [{ text: "Complaints 📝" }, { text: "Send Money ➡️" }],
    [{ text: "Menu 📋" }, { text: "Help ❓" }],
  ];
  bot.sendMessage(chatId, (LANGS[lang] || LANGS.en).welcome, {
    reply_markup: { keyboard: kb, resize_keyboard: true },
  });
});

// language selection handler
bot.on("callback_query", (q) => {
  try {
    const chatId = q.message.chat.id;
    const data = q.data || "";
    if (data.startsWith("lang_")) {
      const lang = data.split("_")[1];
      const user = findUser(chatId) || { id: chatId };
      user.lang = lang;
      user.verified = user.verified || false;
      user.balance = user.balance || 0;
      upsertUser(user);
      bot.sendMessage(chatId, `✅ Language set to ${LANGS[lang].name}. ${LANGS[lang].welcome}`);
      bot.answerCallbackQuery(q.id);
    } else if (data.startsWith("complaint_")) {
      // admin approve/decline direct callbacks could be implemented here
      bot.answerCallbackQuery(q.id, { text: "Use admin commands to approve/decline complaints." });
    } else {
      bot.answerCallbackQuery(q.id);
    }
  } catch (e) {
    console.error("callback_query error", e);
  }
});

// === GENERIC MESSAGE HANDLING (menu actions & commands) ===
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = (msg.text || "").trim();
    // capture username updates
    if (msg.from && msg.from.username) {
      const u = findUser(chatId) || { id: chatId };
      if (!u.username || u.username !== msg.from.username) {
        upsertUser({ id: chatId, username: msg.from.username });
      }
    }

    // Conversation guard: flows create temporary listeners which remove themselves.
    // Primary menu triggers:
    if (text === "Menu 📋" || text === "/menu") {
      return showMenu(chatId);
    }
    if (text === "Balance 💰" || text === "/balance") {
      const u = findUser(chatId) || {};
      const bal = (u.balance || 0).toFixed ? u.balance.toFixed(2) : u.balance || 0;
      return bot.sendMessage(chatId, professional(`💼 Your balance is ₦${bal}. Use Withdraw to request funds.`, u.lang || "en"));
    }
    if (text === "Verify Phone 📱" || text === "/verify") {
      return startVerificationFlow(chatId);
    }
    if (text === "Scan Waste ♻️" || text === "/scan") {
      return handleScan(chatId);
    }
    if (text === "Withdraw ➖" || text === "/withdraw") {
      return startWithdrawFlow(chatId);
    }
    if (text === "Complaints 📝" || text === "/complain") {
      return startComplaintFlow(chatId);
    }
    if ((text.startsWith("/send") || text.startsWith("Send Money") || text.startsWith("➡️"))) {
      return startSendMoneyFlow(chatId, text);
    }
    if (text === "Help ❓" || text === "/help") {
      return bot.sendMessage(chatId, professional(
        "I can help you scan waste, verify your phone, request withdrawals, submit complaints, and transfer money to other users. Admins can manage requests using /admin commands.",
        (findUser(chatId) || {}).lang || "en"
      ));
    }

    // Admin commands
    if (text.startsWith("/admin")) return handleAdminCommand(chatId, text);

    // Unknown messages: show menu if registered
    const u = findUser(chatId);
    if (u) return showMenu(chatId);
    else return bot.sendMessage(chatId, "Send /start to begin and register.");
  } catch (e) {
    console.error("Message handler error", e);
  }
});

// === MENU DISPLAY ===
function showMenu(chatId) {
  const kb = [
    [{ text: "Scan Waste ♻️" }, { text: "Verify Phone 📱" }],
    [{ text: "Balance 💰" }, { text: "Withdraw ➖" }],
    [{ text: "Complaints 📝" }, { text: "Send Money ➡️" }],
    [{ text: "Help ❓" }],
  ];
  bot.sendMessage(chatId, "Please choose an option from the menu below:", { reply_markup: { keyboard: kb, resize_keyboard: true } });
}

// === VERIFICATION FLOW (phone) ===
async function startVerificationFlow(chatId) {
  bot.sendMessage(chatId, "Please send your phone number in international format (e.g., +2349012345678) or /cancel:");
  const listener = async (msg) => {
    if (msg.chat.id !== chatId) return;
    const phone = (msg.text || "").trim();
    if (phone === "/cancel") {
      bot.sendMessage(chatId, "Verification cancelled.");
      bot.removeListener("message", listener);
      return;
    }
    if (!phone.startsWith("+") || phone.length < 8) {
      bot.sendMessage(chatId, "Invalid phone format. Please ensure international format (e.g., +234...). Try again or /cancel.");
      bot.removeListener("message", listener);
      return;
    }

    bot.sendMessage(chatId, `Sending verification code to ${phone}...`);
    try {
      const sendRes = await verifyService.send(phone);
      bot.sendMessage(chatId, "✅ Code sent. Please reply with the code you received or send /cancel.");
      // wait for code
      const codeListener = async (m2) => {
        if (m2.chat.id !== chatId) return;
        const code = (m2.text || "").trim();
        if (code === "/cancel") {
          bot.sendMessage(chatId, "Verification cancelled.");
          bot.removeListener("message", codeListener);
          return;
        }
        try {
          const checkRes = await verifyService.check(phone, code);
          if (checkRes.success) {
            const user = findUser(chatId) || { id: chatId };
            user.phone = phone;
            user.verified = true;
            user.lang = user.lang || "en";
            upsertUser(user);
            bot.sendMessage(chatId, "✅ Phone verified successfully. You can now withdraw and send money.");
            bot.removeListener("message", codeListener);
          } else {
            bot.sendMessage(chatId, "❌ Verification failed. The code is incorrect or expired. Start /verify again.");
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
      bot.sendMessage(chatId, "❌ Failed to send OTP. Admin must configure Twilio or you can use the offline mock.");
    }
    bot.removeListener("message", listener);
  };
  bot.on("message", listener);
}

// === SCAN (mock) ===
async function handleScan(chatId) {
  const simulated = {
    wasteType: "Plastic Bottle",
    cleanlinessScore: Math.floor(Math.random() * 50) + 50,
    estimatedKg: (Math.random() * 2 + 0.2).toFixed(2),
  };
  const basePricePerKg = 150;
  const price = (parseFloat(simulated.estimatedKg) * basePricePerKg).toFixed(2);
  const keyboard = [[{ text: `Accept ₦${price}` }, { text: "Reject" }]];
  bot.sendMessage(chatId,
    `🔎 Scan result:\n• Waste: ${simulated.wasteType}\n• Cleanliness: ${simulated.cleanlinessScore}%\n• Estimated weight: ${simulated.estimatedKg} kg\n• Estimated price: ₦${price}\n\nDo you accept this price?`,
    { reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: true } });

  const listener = (msg) => {
    if (msg.chat.id !== chatId) return;
    const t = (msg.text || "").trim();
    if (t.startsWith("Accept")) {
      const u = findUser(chatId) || { id: chatId, balance: 0, verified: false, lang: "en" };
      u.balance = (parseFloat(u.balance || 0) + parseFloat(price));
      upsertUser(u);
      addTransaction({ userId: chatId, type: "scan_credit", amount: parseFloat(price), note: simulated.wasteType });
      bot.sendMessage(chatId, `✅ Accepted. ₦${price} added to your balance. New balance: ₦${u.balance.toFixed(2)}`);
      bot.removeListener("message", listener);
    } else if (t === "Reject") {
      bot.sendMessage(chatId, "Scan rejected. No changes made.");
      bot.removeListener("message", listener);
    }
  };
  bot.on("message", listener);
}

// === WITHDRAWALS (user) ===
function startWithdrawFlow(chatId) {
  const user = findUser(chatId);
  if (!user) return bot.sendMessage(chatId, "Please register first using /start.");
  if (!user.verified) return bot.sendMessage(chatId, "You must verify your phone before withdrawing using 'Verify Phone 📱'.");

  bot.sendMessage(chatId, `Your balance is ₦${(user.balance || 0).toFixed(2)}. Enter the amount to withdraw or /cancel:`);
  const listener = (msg) => {
    if (msg.chat.id !== chatId) return;
    const text = (msg.text || "").trim();
    if (text === "/cancel") {
      bot.sendMessage(chatId, "Withdrawal cancelled.");
      bot.removeListener("message", listener);
      return;
    }
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "Invalid amount. Enter a valid number or /cancel.");
    if (amount > (user.balance || 0)) {
      bot.sendMessage(chatId, "Insufficient balance.");
      bot.removeListener("message", listener);
      return;
    }

    const withdrawals = getWithdrawals();
    const req = { id: "wd_" + Date.now(), userId: chatId, amount, phone: user.phone || null, status: "pending", ts: new Date().toISOString() };
    withdrawals.push(req);
    saveWithdrawals(withdrawals);

    // temporarily deduct (marked pending)
    user.balance = (user.balance || 0) - amount;
    upsertUser(user);
    addTransaction({ userId: chatId, type: "withdraw_request", amount: -amount, note: `request ${req.id}` });

    bot.sendMessage(chatId, `✅ Withdrawal request created for ₦${amount}. Request ID: ${req.id}. An admin will review it.`);
    notifyAdmins(`📤 New withdrawal request:\nID: ${req.id}\nUser: ${chatId}\nAmount: ₦${amount}`);
    bot.removeListener("message", listener);
  };
  bot.on("message", listener);
}

// === COMPLAINT FLOW (user) ===
function startComplaintFlow(chatId) {
  const user = findUser(chatId);
  if (!user) return bot.sendMessage(chatId, "Please /start to register first.");
  bot.sendMessage(chatId, "To submit a complaint about illegal dumping, please provide the location (city or coordinates) or /cancel:");
  const step1 = (msg) => {
    if (msg.chat.id !== chatId) return;
    const location = (msg.text || "").trim();
    if (location === "/cancel") {
      bot.sendMessage(chatId, "Complaint cancelled.");
      bot.removeListener("message", step1);
      return;
    }
    bot.sendMessage(chatId, "Please provide local government (LGA) or area name (or send /skip):");
    const step2 = (msg2) => {
      if (msg2.chat.id !== chatId) return;
      const lga = (msg2.text || "").trim();
      if (lga === "/cancel") {
        bot.sendMessage(chatId, "Complaint cancelled.");
        bot.removeListener("message", step2);
        bot.removeListener("message", step1);
        return;
      }
      bot.sendMessage(chatId, "You can send an image of the dump site now (optional). If you have no photo, send /nophoto:");
      const step3 = (msg3) => {
        if (msg3.chat.id !== chatId) return;
        // if user sends photo, Telegram gives photo field
        if (msg3.text && msg3.text.trim() === "/nophoto") {
          saveComplaint(chatId, location, lga, null);
          bot.sendMessage(chatId, "Complaint submitted. An admin will review and you'll be notified on approval. Thank you.");
          bot.removeListener("message", step3);
          bot.removeListener("message", step2);
          bot.removeListener("message", step1);
          return;
        }
        if (msg3.photo && msg3.photo.length) {
          const fileId = msg3.photo[msg3.photo.length - 1].file_id; // largest
          saveComplaint(chatId, location, lga, fileId);
          bot.sendMessage(chatId, "Complaint with photo submitted. An admin will review and you'll be notified. Thank you.");
          bot.removeListener("message", step3);
          bot.removeListener("message", step2);
          bot.removeListener("message", step1);
          return;
        }
        // if text other than /nophoto, treat as note and still save
        if (msg3.text) {
          saveComplaint(chatId, location, lga, null, msg3.text.trim());
          bot.sendMessage(chatId, "Complaint submitted. An admin will review and you'll be notified.");
          bot.removeListener("message", step3);
          bot.removeListener("message", step2);
          bot.removeListener("message", step1);
          return;
        }
      };
      bot.on("message", step3);
    };
    bot.on("message", step2);
  };
  bot.on("message", step1);
}
function saveComplaint(userId, location, lga, photoFileId = null, extra = null) {
  const complaints = getComplaints();
  const id = "cmp_" + Date.now();
  const obj = { id, userId, location, lga, photoFileId, extra, status: "pending", ts: new Date().toISOString() };
  complaints.push(obj);
  saveComplaints(complaints);
  notifyAdmins(`📝 New complaint: ID ${id}\nUser: ${userId}\nLocation: ${location}\nLGA/Area: ${lga}\nUse /admin list_complaints or /admin approve_cmp ${id} /admin decline_cmp ${id}`);
}

// === TRANSFER / SEND MONEY FLOW ===
function startSendMoneyFlow(chatId, rawText) {
  const user = findUser(chatId);
  if (!user) return bot.sendMessage(chatId, "Please /start to register first.");
  if (!user.verified) return bot.sendMessage(chatId, "You must verify your phone before sending money (use 'Verify Phone 📱').");

  bot.sendMessage(chatId, "To send money, use: /send <@username|+234...> <amount>\nExample: /send @john 500\nOr send recipient phone number (international) and amount.");
  // If they already included details: try simple parse
  if (rawText && rawText.startsWith("/send")) {
    const parts = rawText.split(/\s+/);
    if (parts.length >= 3) {
      const recipientRaw = parts[1];
      const amount = parseFloat(parts[2]);
      if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "Invalid amount. Use /send <recipient> <amount>.");
      handleDirectTransfer(chatId, recipientRaw, amount);
      return;
    }
  }

  // Otherwise, wait for message with recipient and amount
  const listener = (msg) => {
    if (msg.chat.id !== chatId) return;
    const parts = (msg.text || "").trim().split(/\s+/);
    if (parts.length < 2) {
      bot.sendMessage(chatId, "Invalid. Use <recipient> <amount> or /cancel.");
      return;
    }
    if (parts[0] === "/cancel") {
      bot.sendMessage(chatId, "Send money cancelled.");
      bot.removeListener("message", listener);
      return;
    }
    const recipientRaw = parts[0];
    const amount = parseFloat(parts[1]);
    if (isNaN(amount) || amount <= 0) {
      bot.sendMessage(chatId, "Invalid amount. Try again.");
      return;
    }
    handleDirectTransfer(chatId, recipientRaw, amount);
    bot.removeListener("message", listener);
  };
  bot.on("message", listener);
}

function handleDirectTransfer(senderId, recipientRaw, amount) {
  const sender = findUser(senderId);
  if (!sender || (sender.balance || 0) < amount) {
    return bot.sendMessage(senderId, "Insufficient balance to perform this transfer.");
  }
  let recipient = null;
  if (recipientRaw.startsWith("@")) {
    recipient = findUserByUsername(recipientRaw.slice(1));
  } else if (recipientRaw.startsWith("+")) {
    recipient = findUserByPhone(recipientRaw);
  } else {
    // maybe a numeric id
    const idNum = parseInt(recipientRaw, 10);
    if (!isNaN(idNum)) recipient = findUser(idNum);
  }

  if (!recipient) {
    return bot.sendMessage(senderId, "Recipient not found. They must have used this bot and have a username or verified phone.");
  }
  // execute transfer
  sender.balance = (sender.balance || 0) - amount;
  recipient.balance = (recipient.balance || 0) + amount;
  upsertUser(sender);
  upsertUser(recipient);
  addTransaction({ userId: senderId, type: "transfer_out", amount: -amount, note: `to ${recipient.id}` });
  addTransaction({ userId: recipient.id, type: "transfer_in", amount: amount, note: `from ${senderId}` });
  bot.sendMessage(senderId, `✅ Sent ₦${amount} to ${recipient.username || recipient.id}. Your new balance: ₦${(sender.balance || 0).toFixed(2)}`);
  bot.sendMessage(recipient.id, `📥 You received ₦${amount} from ${sender.username || senderId}. New balance: ₦${(recipient.balance || 0).toFixed(2)}`);
}

// === ADMIN NOTIFY ===
function notifyAdmins(message) {
  const cfg = getAdminCfg();
  if (!cfg || !cfg.admins || cfg.admins.length === 0) {
    console.warn("No admins configured. Message for admins:", message);
    return;
  }
  cfg.admins.forEach((adminId) => {
    try {
      bot.sendMessage(adminId, message);
    } catch (e) {
      console.error("Failed to notify admin", adminId, e);
    }
  });
}

// === ADMIN COMMANDS (all via telegram) ===
function handleAdminCommand(chatId, text) {
  const cfg = getAdminCfg();
  if (!cfg.admins.includes(chatId)) return bot.sendMessage(chatId, "Unauthorized. You are not an admin.");

  const parts = text.split(" ");
  const cmd = parts[1];

  switch (cmd) {
    case "list_withdrawals": {
      const w = getWithdrawals();
      if (!w.length) return bot.sendMessage(chatId, "No withdrawals.");
      const s = w.map((r) => `${r.id} - ${r.userId} - ₦${r.amount} - ${r.status}`).join("\n");
      return bot.sendMessage(chatId, `Withdrawals:\n${s}`);
    }
    case "approve":
      if (!parts[2]) return bot.sendMessage(chatId, "Usage: /admin approve <withdrawal_id>");
      return adminApprove(chatId, parts[2]);
    case "decline":
      if (!parts[2]) return bot.sendMessage(chatId, "Usage: /admin decline <withdrawal_id>");
      return adminDecline(chatId, parts[2]);
    case "broadcast":
      if (parts.length < 3) return bot.sendMessage(chatId, "Usage: /admin broadcast <message>");
      broadcastToAll(parts.slice(2).join(" "), chatId);
      return;
    case "addadmin":
      if (!parts[2]) return bot.sendMessage(chatId, "Usage: /admin addadmin <userid>");
      return addAdmin(chatId, parts[2]);
    case "list_complaints": {
      const c = getComplaints();
      if (!c.length) return bot.sendMessage(chatId, "No complaints.");
      const s = c.map((r) => `${r.id} - user:${r.userId} - ${r.location} - ${r.lga} - ${r.status}`).join("\n");
      return bot.sendMessage(chatId, `Complaints:\n${s}`);
    }
    case "approve_cmp":
      if (!parts[2]) return bot.sendMessage(chatId, "Usage: /admin approve_cmp <complaint_id>");
      return adminApproveComplaint(chatId, parts[2]);
    case "decline_cmp":
      if (!parts[2]) return bot.sendMessage(chatId, "Usage: /admin decline_cmp <complaint_id>");
      return adminDeclineComplaint(chatId, parts[2]);
    default:
      return bot.sendMessage(chatId,
        "Admin commands:\n" +
        "/admin list_withdrawals\n/admin approve <id>\n/admin decline <id>\n/admin broadcast <message>\n/admin addadmin <userid>\n" +
        "/admin list_complaints\n/admin approve_cmp <id>\n/admin decline_cmp <id>"
      );
  }
}

function addAdmin(requesterId, userIdStr) {
  const newAdmin = parseInt(userIdStr, 10);
  if (isNaN(newAdmin)) return bot.sendMessage(requesterId, "Invalid user id.");
  const cfg = getAdminCfg();
  if (!cfg.admins.includes(newAdmin)) {
    cfg.admins.push(newAdmin);
    saveAdminCfg(cfg);
    bot.sendMessage(requesterId, `Added admin ${newAdmin}`);
    bot.sendMessage(newAdmin, "You have been added as an admin for Clean9ja bot.");
  } else {
    bot.sendMessage(requesterId, `User ${newAdmin} already an admin.`);
  }
}

// Approve withdrawal
async function adminApprove(adminChatId, withdrawId) {
  const cfg = getAdminCfg();
  if (!cfg.admins.includes(adminChatId)) return bot.sendMessage(adminChatId, "Unauthorized");
  const withdrawals = getWithdrawals();
  const req = withdrawals.find((r) => r.id === withdrawId);
  if (!req) return bot.sendMessage(adminChatId, "Request not found.");
  if (req.status !== "pending") return bot.sendMessage(adminChatId, "Request already processed.");
  req.status = "approved";
  req.approvedBy = adminChatId;
  req.approvedAt = new Date().toISOString();
  saveWithdrawals(withdrawals);

  // record the transaction as payout (already deducted earlier)
  addTransaction({ userId: req.userId, type: "withdraw_approved", amount: -req.amount, note: `approved by ${adminChatId}` });

  bot.sendMessage(adminChatId, `Withdrawal ${withdrawId} approved.`);
  bot.sendMessage(req.userId, `✅ Your withdrawal ${withdrawId} of ₦${req.amount} has been approved by admin ${adminChatId}.`);
}

// Decline withdrawal (refund)
async function adminDecline(adminChatId, withdrawId) {
  const cfg = getAdminCfg();
  if (!cfg.admins.includes(adminChatId)) return bot.sendMessage(adminChatId, "Unauthorized");
  const withdrawals = getWithdrawals();
  const req = withdrawals.find((r) => r.id === withdrawId);
  if (!req) return bot.sendMessage(adminChatId, "Request not found.");
  if (req.status !== "pending") return bot.sendMessage(adminChatId, "Request already processed.");
  req.status = "declined";
  req.declinedBy = adminChatId;
  req.declinedAt = new Date().toISOString();
  saveWithdrawals(withdrawals);

  // refund user
  const users = getUsers();
  const userIdx = users.findIndex((u) => u.id === req.userId);
  if (userIdx !== -1) {
    users[userIdx].balance = (users[userIdx].balance || 0) + req.amount;
    saveUsers(users);
    addTransaction({ userId: req.userId, type: "withdraw_declined_refund", amount: req.amount, note: `declined ${withdrawId}` });
  }

  bot.sendMessage(adminChatId, `Withdrawal ${withdrawId} declined and amount refunded.`);
  bot.sendMessage(req.userId, `❌ Your withdrawal ${withdrawId} of ₦${req.amount} was declined by admin ${adminChatId}. Amount refunded.`);
}

// Complaints approval/decline
function adminApproveComplaint(adminId, complaintId) {
  const cfg = getAdminCfg();
  if (!cfg.admins.includes(adminId)) return bot.sendMessage(adminId, "Unauthorized");
  const complaints = getComplaints();
  const cmp = complaints.find((c) => c.id === complaintId);
  if (!cmp) return bot.sendMessage(adminId, "Complaint not found.");
  if (cmp.status !== "pending") return bot.sendMessage(adminId, "Already processed.");

  cmp.status = "approved";
  cmp.approvedBy = adminId;
  cmp.approvedAt = new Date().toISOString();
  saveComplaints(complaints);

  // bonus the user
  const users = getUsers();
  const idx = users.findIndex((u) => u.id === cmp.userId);
  if (idx !== -1) {
    users[idx].balance = (users[idx].balance || 0) + COMPLAINT_BONUS;
    saveUsers(users);
    addTransaction({ userId: cmp.userId, type: "complaint_bonus", amount: COMPLAINT_BONUS, note: `complaint ${complaintId} approved` });
  }

  bot.sendMessage(adminId, `Complaint ${complaintId} approved and bonus ₦${COMPLAINT_BONUS} credited.`);
  bot.sendMessage(cmp.userId, `✅ Your complaint ${complaintId} has been approved. A bonus of ₦${COMPLAINT_BONUS} has been credited to your wallet.`);
}

function adminDeclineComplaint(adminId, complaintId) {
  const cfg = getAdminCfg();
  if (!cfg.admins.includes(adminId)) return bot.sendMessage(adminId, "Unauthorized");
  const complaints = getComplaints();
  const cmp = complaints.find((c) => c.id === complaintId);
  if (!cmp) return bot.sendMessage(adminId, "Complaint not found.");
  if (cmp.status !== "pending") return bot.sendMessage(adminId, "Already processed.");

  cmp.status = "declined";
  cmp.declinedBy = adminId;
  cmp.declinedAt = new Date().toISOString();
  saveComplaints(complaints);

  bot.sendMessage(adminId, `Complaint ${complaintId} declined.`);
  bot.sendMessage(cmp.userId, `❌ Your complaint ${complaintId} was declined by admin ${adminId}.`);
}

// Broadcast
function broadcastToAll(message, requestedBy) {
  const cfg = getAdminCfg();
  if (!cfg.admins.includes(requestedBy)) return bot.sendMessage(requestedBy, "Unauthorized to broadcast.");
  const users = getUsers();
  let sent = 0;
  users.forEach((u) => {
    try {
      bot.sendMessage(u.id, `📢 Broadcast:\n${message}`);
      sent++;
    } catch (e) { /* ignore per-user send errors */ }
  });
  bot.sendMessage(requestedBy, `Broadcast sent to ${sent} users.`);
}

// === Graceful catch-all logging ===
process.on("uncaughtException", (err) => {
  console.error("UncaughtException:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("UnhandledRejection:", err);
});

console.log("Clean9ja Bot started and ready.");
