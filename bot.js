require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const twilio = require('./twilio');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

// === Data files ===
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const WASTE_FILE = path.join(DATA_DIR, 'waste.json');

function loadData(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
}
function saveData(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let users = loadData(USERS_FILE);
let wasteRates = { plastic: 50, metal: 80, paper: 30 }; // ₦ per kg

function saveUsers() { saveData(USERS_FILE, users); }

// === START BOT ===
bot.start(async (ctx) => {
  const id = ctx.from.id;
  if (!users[id]) {
    users[id] = { id, verified: false, balance: 0, name: ctx.from.first_name };
    saveUsers();
  }
  await ctx.reply('👋 Welcome to *Clean Naija Bot*!', { parse_mode: 'Markdown' });
  if (!users[id].verified) {
    return ctx.reply(
      '📱 Please verify your phone number to continue.',
      Markup.keyboard([[{ text: 'Share My Number 📞', request_contact: true }]]).oneTime().resize()
    );
  }
  return ctx.reply('✅ You are already verified! Use /menu to continue.');
});

// === HANDLE CONTACT ===
bot.on('contact', async (ctx) => {
  const contact = ctx.message.contact;
  const user = users[ctx.from.id];
  user.phone = contact.phone_number.startsWith('+')
    ? contact.phone_number
    : '+' + contact.phone_number;
  saveUsers();
  ctx.reply('📩 Sending OTP to ' + user.phone);
  const res = await twilio.startVerify(user.phone);
  if (res.success) {
    user.pending = true;
    saveUsers();
    ctx.reply('Enter the 6-digit code you received via SMS:');
  } else ctx.reply('❌ Failed to send OTP: ' + res.error);
});

// === HANDLE OTP ===
bot.on('text', async (ctx) => {
  const id = ctx.from.id;
  const user = users[id];
  const text = ctx.message.text.trim();

  if (user && user.pending && /^\d{4,6}$/.test(text)) {
    const ok = await twilio.checkVerify(user.phone, text);
    if (ok) {
      user.verified = true;
      delete user.pending;
      saveUsers();
      return ctx.reply('✅ Verification successful! Use /menu.');
    } else return ctx.reply('❌ Wrong code. Try again.');
  }
});

// === MENU ===
bot.command('menu', async (ctx) => {
  if (!users[ctx.from.id]?.verified)
    return ctx.reply('⚠️ Please verify your phone number first.');
  ctx.reply(
    '📋 *Main Menu*',
    Markup.inlineKeyboard([
      [Markup.button.callback('♻️ Scan Waste', 'SCAN')],
      [Markup.button.callback('💰 Withdraw', 'WITHDRAW')],
      [Markup.button.callback('📞 Complain', 'COMPLAIN')],
      [Markup.button.callback('ℹ️ My Info', 'INFO')],
    ])
  );
});

// === CALLBACK HANDLERS ===
bot.action('SCAN', (ctx) => {
  ctx.reply('Enter waste type (plastic, metal, paper):');
  users[ctx.from.id].step = 'waste_type';
  saveUsers();
});

bot.on('text', async (ctx) => {
  const id = ctx.from.id;
  const user = users[id];
  const msg = ctx.message.text.toLowerCase();

  if (user?.step === 'waste_type') {
    if (!wasteRates[msg]) return ctx.reply('Invalid type. Try: plastic, metal, or paper.');
    user.currentType = msg;
    user.step = 'waste_weight';
    saveUsers();
    return ctx.reply('Enter weight in kg:');
  }

  if (user?.step === 'waste_weight') {
    const kg = parseFloat(msg);
    if (isNaN(kg) || kg <= 0) return ctx.reply('Please enter a valid weight.');
    const earn = kg * wasteRates[user.currentType];
    user.balance += earn;
    user.step = null;
    saveUsers();
    return ctx.reply(`✅ Recorded! You earned ₦${earn.toFixed(2)}.\n💰 New balance: ₦${user.balance}`);
  }
});

// === ADMIN COMMANDS ===
bot.command('admin', (ctx) => {
  if (ctx.from.id.toString() !== process.env.ADMIN_ID) return;
  ctx.reply(
    '🛠 *Admin Panel*',
    Markup.inlineKeyboard([
      [Markup.button.callback('📊 View Users', 'ADMIN_USERS')],
      [Markup.button.callback('💵 Set Waste Rates', 'ADMIN_RATES')],
    ])
  );
});

bot.action('ADMIN_USERS', (ctx) => {
  if (ctx.from.id.toString() !== process.env.ADMIN_ID) return;
  let list = Object.values(users)
    .map(u => `${u.name || 'NoName'} - ${u.phone || 'N/A'} - ₦${u.balance}`)
    .join('\n');
  ctx.reply('📋 *Users List:*\n' + list, { parse_mode: 'Markdown' });
});

bot.launch();
console.log('✅ Clean Naija Bot is running...');
