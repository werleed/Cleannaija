// server.js
require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const twilio = require('twilio');

const app = express();
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

// === Directories & files ===
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const FILES = {
  users: path.join(DATA_DIR, 'users.json'),
  complaints: path.join(DATA_DIR, 'complaints.json'),
  withdrawals: path.join(DATA_DIR, 'withdrawals.json'),
  referrals: path.join(DATA_DIR, 'referrals.json')
};
for (const file of Object.values(FILES)) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]');
}

// === Helper functions ===
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

function findUser(id) {
  return read(FILES.users).find(u => u.telegram_id === id);
}
function saveUser(user) {
  const users = read(FILES.users);
  const i = users.findIndex(u => u.telegram_id === user.telegram_id);
  if (i > -1) users[i] = user;
  else users.push(user);
  write(FILES.users, users);
}

// === Twilio Verification ===
async function sendVerification(phone) {
  try {
    await client.verify.v2.services(process.env.TWILIO_VERIFY_SID)
      .verifications
      .create({ to: phone, channel: 'sms' });
    return { success: true };
  } catch (err) {
    console.error('Twilio verify error:', err.message);
    return { success: false, error: err.message };
  }
}

async function checkVerification(phone, code) {
  try {
    const res = await client.verify.v2.services(process.env.TWILIO_VERIFY_SID)
      .verificationChecks
      .create({ to: phone, code });
    return res.status === 'approved';
  } catch (err) {
    return false;
  }
}

// === Bot Commands ===
bot.start(async (ctx) => {
  const tgId = ctx.from.id;
  let user = findUser(tgId);
  if (!user) {
    user = {
      telegram_id: tgId,
      username: ctx.from.username || '',
      first_name: ctx.from.first_name || '',
      verified: false
    };
    saveUser(user);
  }

  const ipData = await axios.get('https://ipapi.co/json/').then(res => res.data).catch(() => ({}));
  const country = ipData.country_name || 'Unknown';
  const welcome = `👋 Welcome ${ctx.from.first_name || ''}!\nYou are connecting from 🌍 ${country}.\n\nPlease verify your phone number to continue.`;

  await ctx.reply(welcome, Markup.keyboard([
    [Markup.button.contactRequest('📱 Share Contact')]
  ]).resize());
});

// === Handle contact share ===
bot.on('contact', async (ctx) => {
  const contact = ctx.message.contact;
  const tgId = ctx.from.id;
  let user = findUser(tgId) || { telegram_id: tgId };
  user.phone = contact.phone_number.startsWith('+') ? contact.phone_number : `+${contact.phone_number}`;
  saveUser(user);

  const res = await sendVerification(user.phone);
  if (res.success) {
    ctx.reply(`✅ OTP sent to ${user.phone}. Please enter the 6-digit code.`);
  } else {
    ctx.reply('❌ Failed to send OTP: ' + res.error);
  }
});

// === Handle OTP ===
bot.hears(/^\d{6}$/, async (ctx) => {
  const tgId = ctx.from.id;
  const user = findUser(tgId);
  if (!user || !user.phone) return ctx.reply('Please share your phone number first.');

  const ok = await checkVerification(user.phone, ctx.message.text.trim());
  if (ok) {
    user.verified = true;
    saveUser(user);
    ctx.reply('🎉 Phone verified successfully!');
    return showMainMenu(ctx);
  } else {
    ctx.reply('❌ Invalid or expired code. Please try again.');
  }
});

// === Main Menu ===
function showMainMenu(ctx) {
  return ctx.reply(
    '✅ Verification complete! Choose an option:',
    Markup.keyboard([
      ['💵 Withdrawals', '📞 Complaints'],
      ['👥 Referrals', 'ℹ️ My Info']
    ]).resize()
  );
}

// === Menu handlers ===
bot.hears('ℹ️ My Info', (ctx) => {
  const u = findUser(ctx.from.id);
  if (!u) return ctx.reply('User not found.');
  ctx.reply(`👤 Name: ${u.first_name}\n📞 Phone: ${u.phone}\n✅ Verified: ${u.verified ? 'Yes' : 'No'}`);
});

bot.hears('📞 Complaints', (ctx) => {
  ctx.reply('📝 Please type your complaint below:');
  bot.once('text', (msgCtx) => {
    const complaints = read(FILES.complaints);
    complaints.push({ id: msgCtx.from.id, name: msgCtx.from.first_name, text: msgCtx.message.text, date: new Date().toISOString() });
    write(FILES.complaints, complaints);
    msgCtx.reply('✅ Complaint submitted successfully.');
  });
});

bot.hears('💵 Withdrawals', (ctx) => {
  ctx.reply('💰 Enter the amount you want to withdraw:');
  bot.once('text', (msgCtx) => {
    const amount = msgCtx.message.text;
    const withdrawals = read(FILES.withdrawals);
    withdrawals.push({ id: msgCtx.from.id, amount, date: new Date().toISOString() });
    write(FILES.withdrawals, withdrawals);
    msgCtx.reply(`✅ Withdrawal request of ₦${amount} received. You’ll be contacted soon.`);
  });
});

bot.hears('👥 Referrals', (ctx) => {
  const refLink = `https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}`;
  ctx.reply(`🔗 Your referral link:\n${refLink}`);
});

// === Admin controls ===
bot.command('admin', (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_ID)) return;
  ctx.reply('👑 Admin Menu', Markup.keyboard([
    ['📋 Users', '📢 Broadcast'],
    ['💬 Complaints', '💰 Withdrawals']
  ]).resize());
});

bot.hears('📋 Users', (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_ID)) return;
  const users = read(FILES.users);
  ctx.reply(`👥 Total users: ${users.length}`);
});

bot.hears('💬 Complaints', (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_ID)) return;
  const complaints = read(FILES.complaints);
  if (!complaints.length) return ctx.reply('No complaints yet.');
  const list = complaints.map(c => `🗓️ ${c.date}\n👤 ${c.name}\n💬 ${c.text}`).join('\n\n');
  ctx.reply(list);
});

bot.hears('💰 Withdrawals', (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_ID)) return;
  const w = read(FILES.withdrawals);
  if (!w.length) return ctx.reply('No withdrawals yet.');
  const list = w.map(x => `🗓️ ${x.date}\n👤 ${x.id}\n💵 ${x.amount}`).join('\n\n');
  ctx.reply(list);
});

bot.hears('📢 Broadcast', (ctx) => {
  if (String(ctx.from.id) !== String(process.env.ADMIN_ID)) return;
  ctx.reply('✉️ Send the message you want to broadcast:');
  bot.once('text', (msgCtx) => {
    const users = read(FILES.users);
    users.forEach(u => {
      bot.telegram.sendMessage(u.telegram_id, msgCtx.message.text).catch(() => {});
    });
    msgCtx.reply('✅ Broadcast sent.');
  });
});

// === Express Keepalive ===
app.get('/', (req, res) => res.send('🤖 Bot server running...'));
app.listen(process.env.PORT || 3000, () => console.log('Server active ✅'));
bot.launch();
