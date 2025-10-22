// bot.js - CommonJS Telegraf + Twilio verify integration
require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const fs = require('fs-extra');
const path = require('path');
const Twilio = require('twilio');

const DATA_DIR = path.resolve(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

fs.ensureDirSync(DATA_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeJsonSync(USERS_FILE, { users: {} }, { spaces: 2 });

// load or save helpers
function loadUsers() {
  return fs.readJsonSync(USERS_FILE);
}
function saveUsers(data) {
  fs.writeJsonSync(USERS_FILE, data, { spaces: 2 });
}

// ENV vars (must be set)
const BOT_TOKEN = process.env.BOT_TOKEN;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID; // Twilio Verify Service SID (recommended)
const ADMINS = (process.env.ADMINS || '').split(',').map(s => s.trim()).filter(Boolean); // admin telegram IDs
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '+234'; // used when number starts with 0
const BOT_NAME = process.env.BOT_NAME || 'CleanNaijaBot';

if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN missing in env');
  process.exit(1);
}
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SERVICE_SID) {
  console.error('ERROR: Twilio credentials or Verify Service SID missing in env (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID)');
  // we won't exit; verification flows will fail but other features still run. Decide as needed.
}

const twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const bot = new Telegraf(BOT_TOKEN);

// in-memory states (for active verification steps)
const sessions = new Map(); // userId -> {step, phone}

// utilities
function detectLang(ctx) {
  // Use Telegram language_code if available; default 'en'
  try {
    const lc = ctx.from && ctx.from.language_code ? ctx.from.language_code.split('-')[0] : 'en';
    return lc;
  } catch (e) {
    return 'en';
  }
}
function t(ctx, enText, otherMap) {
  // very simple translator stub: otherMap: { 'fr': '...' }
  const lang = detectLang(ctx);
  return (otherMap && otherMap[lang]) || enText;
}
function humanReply(ctx, lines) {
  // mimic preloader/human feel
  return ctx.telegram.sendChatAction(ctx.chat.id, 'typing')
    .then(() => new Promise(res => setTimeout(res, 600)))
    .then(() => ctx.reply(lines));
}
function normalizePhone(input) {
  // Remove spaces, parentheses, dashes
  if (!input) return null;
  let s = input.trim().replace(/[\s()-]/g, '');
  // If already +...
  if (s.startsWith('+')) return s;
  // If starts with 00
  if (s.startsWith('00')) return '+' + s.slice(2);
  // If starts with 0, prepend default country
  if (s.startsWith('0')) {
    return DEFAULT_COUNTRY_CODE + s.slice(1);
  }
  // If is all digits and likely local: prepend default
  if (/^\d+$/.test(s)) return DEFAULT_COUNTRY_CODE + s;
  return s;
}

// referral and persistence helpers
function ensureUserRecord(user) {
  const db = loadUsers();
  const id = String(user.id);
  db.users[id] = db.users[id] || {
    id: id,
    tg_username: user.username || '',
    first_name: user.first_name || '',
    last_name: user.last_name || '',
    verified: false,
    phone: null,
    refBy: null,
    joined_at: new Date().toISOString()
  };
  // update basic profile
  db.users[id].tg_username = user.username || db.users[id].tg_username;
  db.users[id].first_name = user.first_name || db.users[id].first_name;
  db.users[id].last_name = user.last_name || db.users[id].last_name;
  saveUsers(db);
  return db.users[id];
}

// admin check
function isAdmin(ctx) {
  const id = String(ctx.from.id);
  return ADMINS.includes(id);
}

// start handler with referral: /start <ref>
bot.start(async (ctx) => {
  // referral handling: /start <refUserId>
  const payload = (ctx.startPayload || '').trim();
  const me = ensureUserRecord(ctx.from);
  if (payload) {
    // record ref
    const db = loadUsers();
    const refId = payload;
    if (db.users[me.id]) db.users[me.id].refBy = refId;
    saveUsers(db);
  }
  // Preloader / welcome typing
  await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
  await new Promise(r => setTimeout(r, 700));
  const welcome = `Hello ${ctx.from.first_name || ''}! 👋\nI am ${BOT_NAME}. I help verify phone numbers, manage admin tasks and more.`;
  const features = [
    '• Phone verification via SMS (Twilio Verify)',
    '• Admin moderation tools (admins only)',
    '• Referral tracking',
    '• Friendly, responsive flows'
  ].join('\n');

  // inline buttons
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('Verify number', 'verify_start')],
    [Markup.button.callback('Help / Commands', 'help')],
    [Markup.button.url('Contact Admin', `tg://user?id=${ADMINS[0] || 0}`)]
  ]);
  await ctx.reply(`${welcome}\n\nFeatures:\n${features}`, kb);
});

// help command
bot.command('help', (ctx) => {
  const msg = `Commands:\n/start - restart bot\n/verify - start phone verification\n/status - show your verification status\n/help - this help\n\nAdmins can use /admin`;
  return humanReply(ctx, msg);
});

// admin panel
bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('You are not an admin.');
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('List users', 'admin_list_users')],
    [Markup.button.callback('Broadcast', 'admin_broadcast')],
    [Markup.button.callback('Stats', 'admin_stats')]
  ]);
  await ctx.reply('Admin Panel:', kb);
});

// user menu buttons
bot.action('help', (ctx) => ctx.answerCbQuery().then(() => ctx.reply('Use /verify to start verification or /help for commands.')));
bot.action('verify_start', async (ctx) => {
  ctx.answerCbQuery();
  const lang = detectLang(ctx);
  sessions.set(String(ctx.from.id), { step: 'await_phone' });
  // ask for phone; include request contact button for convenience
  const requestContactKb = Markup.keyboard([
    Markup.button.contactRequest('Send my contact')
  ]).oneTime().resize();
  await ctx.reply(t(ctx, 'Please send your phone number (include country code) or share contact:', { }), requestContactKb);
});

// when user sends contact or text
bot.on('contact', async (ctx) => {
  const contact = ctx.message.contact;
  if (!contact || !contact.phone_number) return ctx.reply('Contact has no phone number.');
  const phone = normalizePhone(contact.phone_number);
  const uid = String(ctx.from.id);
  sessions.set(uid, { step: 'await_code_check', phone });
  ensureUserRecord(ctx.from);
  await ctx.reply(`We will send an SMS to ${phone}. Sending...`);
  // send via Twilio Verify
  try {
    await twilioClient.verify.services(TWILIO_VERIFY_SERVICE_SID)
      .verifications.create({ to: phone, channel: 'sms' });
    await ctx.reply('Verification code sent via SMS. Please enter the code here.');
  } catch (err) {
    console.error('Twilio send error', err && err.message);
    await ctx.reply('Failed to send verification SMS. Check Twilio settings. Contact admin.');
  }
});

bot.on('text', async (ctx) => {
  const uid = String(ctx.from.id);
  const s = sessions.get(uid);
  const text = ctx.message.text.trim();

  // Quick commands inside text
  if (text === '/verify') {
    sessions.set(uid, { step: 'await_phone' });
    const requestContactKb = Markup.keyboard([
      Markup.button.contactRequest('Send my contact')
    ]).oneTime().resize();
    return ctx.reply('Please send your phone number (include country code) or share contact:', requestContactKb);
  }
  if (text === '/status') {
    const db = loadUsers();
    const u = db.users[uid];
    if (!u) return ctx.reply('You have no record. Use /verify to start.');
    return ctx.reply(`Status:\nVerified: ${!!u.verified}\nPhone: ${u.phone || 'N/A'}\nReferrer: ${u.refBy || 'N/A'}`);
  }

  // If session waiting for phone
  if (s && s.step === 'await_phone') {
    const phone = normalizePhone(text);
    if (!phone) return ctx.reply('Could not understand that phone. Please send in format like +2348012345678 or 08012345678.');
    sessions.set(uid, { step: 'await_code_check', phone });
    ensureUserRecord(ctx.from);
    await ctx.reply(`Sending verification SMS to ${phone}...`);
    try {
      await twilioClient.verify.services(TWILIO_VERIFY_SERVICE_SID)
        .verifications.create({ to: phone, channel: 'sms' });
      await ctx.reply('SMS sent. Please enter the code you received.');
    } catch (err) {
      console.error('Twilio send error', err && err.message);
      await ctx.reply('Failed to send SMS. Make sure Twilio creds and phone number are correct. Contact admin.');
      sessions.delete(uid);
    }
    return;
  }

  // If session waiting for code
  if (s && s.step === 'await_code_check') {
    const code = text;
    const phone = s.phone;
    if (!phone) {
      sessions.delete(uid);
      return ctx.reply('Phone number missing. Please restart verification with /verify.');
    }
    await ctx.reply('Checking code...');
    try {
      const check = await twilioClient.verify.services(TWILIO_VERIFY_SERVICE_SID)
        .verificationChecks.create({ to: phone, code });
      if (check.status === 'approved') {
        // mark user verified
        const db = loadUsers();
        db.users[uid] = db.users[uid] || {};
        db.users[uid].verified = true;
        db.users[uid].phone = phone;
        db.users[uid].verified_at = new Date().toISOString();
        saveUsers(db);
        sessions.delete(uid);
        await ctx.reply('✅ Verified! Your phone has been saved.');
        // notify admin(s)
        for (const adminId of ADMINS) {
          try {
            await ctx.telegram.sendMessage(adminId, `User verified: ${ctx.from.first_name} (${uid}) - ${phone}`);
          } catch (e) { /* ignore */ }
        }
      } else {
        await ctx.reply('Code not valid. Please try again or request a new code with /verify.');
      }
    } catch (err) {
      console.error('Twilio check error', err && err.message);
      await ctx.reply('Error checking code. If incorrect, request a new code with /verify.');
    }
    return;
  }

  // Fallback: AI-like reply (templated)
  await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
  await new Promise(r => setTimeout(r, 800 + Math.random() * 600));
  // small diverse template
  const patterns = [
    `Nice question — ${ctx.from.first_name || 'friend'}, I can help with verification. Try /verify.`,
    `I got that. If you want to verify your number send /verify and follow the steps.`,
    `Thanks for the message! Type /help to view commands or /verify to begin phone verification.`,
    `I'm here to help — use /verify to get started with SMS verification.`
  ];
  const chosen = patterns[Math.floor(Math.random() * patterns.length)];
  return ctx.reply(chosen);
});

// admin actions - list users
bot.action('admin_list_users', async (ctx) => {
  ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Not admin.');
  const db = loadUsers();
  const users = Object.values(db.users || {});
  const lines = users.slice(0, 100).map(u => `${u.id} • ${u.first_name || ''} ${u.tg_username ? '(' + u.tg_username + ')' : ''} • verified: ${u.verified ? 'yes' : 'no'}`).join('\n') || 'No users';
  // if many users, send truncated + file
  if (lines.length < 3500) {
    return ctx.reply(`Users:\n${lines}`);
  } else {
    // write temp file
    const tmp = path.join(DATA_DIR, `users-${Date.now()}.json`);
    fs.writeJsonSync(tmp, db, { spaces: 2 });
    await ctx.replyWithDocument({ source: tmp, filename: 'users.json' });
    fs.removeSync(tmp);
  }
});

// admin stats
bot.action('admin_stats', (ctx) => {
  ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Not admin.');
  const db = loadUsers();
  const users = Object.values(db.users || {});
  const verified = users.filter(u => u.verified).length;
  const total = users.length;
  return ctx.reply(`Stats:\nTotal users: ${total}\nVerified: ${verified}`);
});

// broadcast flow (simple)
bot.action('admin_broadcast', async (ctx) => {
  ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Not admin.');
  sessions.set(String(ctx.from.id), { step: 'await_broadcast' });
  await ctx.reply('Send the broadcast message text now (it will be sent to all users).');
});

// admin sending broadcast message
bot.on('text', async (ctx) => {
  const uid = String(ctx.from.id);
  const s = sessions.get(uid);
  if (s && s.step === 'await_broadcast' && isAdmin(ctx)) {
    const text = ctx.message.text;
    sessions.delete(uid);
    const db = loadUsers();
    const users = Object.values(db.users || {});
    await ctx.reply(`Broadcasting to ${users.length} users...`);
    let sent = 0, fail = 0;
    for (const u of users) {
      try {
        await ctx.telegram.sendMessage(u.id, `📣 Admin broadcast:\n\n${text}`);
        sent++;
      } catch (e) {
        fail++;
      }
    }
    return ctx.reply(`Broadcast complete. Sent: ${sent}, Failed: ${fail}`);
  }
});

// graceful launch
bot.launch().then(() => {
  console.log('Bot launched');
}).catch(err => {
  console.error('Failed to launch bot', err);
});

// handle shutdown signals for proper Telegram stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
