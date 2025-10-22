// server.js - CommonJS
require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// require + start bot (bot.js will initialize the Telegraf bot)
require('./bot.js');

app.get('/', (req, res) => {
  res.send('OK - Clean Naija Bot is running');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
