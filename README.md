CleanNaijaBot - Final Starter Bundle
====================================
This bundle includes:
- bot.js (Telegram bot with Twilio OTP test mode, admin commands, pickup & withdrawal simulation)
- twilio.js (Twilio helper - test mode accepts 123456)
- package.json
- README.md (this file)
- data/ (auto-created JSON files when you run the bot)
- homepage/index.html (professional single-page landing page to host on BergeHost)

Quick start (phone using Termux):
1. Install Termux and run: pkg update && pkg install nodejs git -y
2. Copy the zip to your phone and extract.
3. In extracted folder run: npm install
4. Copy .env.example to .env and set TELEGRAM_TOKEN and ADMIN_TELEGRAM_ID (get your Telegram ID from @userinfobot).
   Leave Twilio env vars blank for test mode (OTP 123456).
5. Start the bot: node bot.js
6. Open Telegram -> your bot -> /start and test flows.

Admin commands (use your Telegram numeric ID as ADMIN_TELEGRAM_ID):
- /setrate <amount>        — set payout rate per kg (₦)
- /viewusers               — list users
- /listpickups             — list pickup requests
- /markcollected <id> [kg] — mark pickup collected, optionally set actual kg (credits user)
- /approve <withdrawal_id> — approve withdrawal and simulate payout
- /broadcast <message>     — send message to all users

Notes:
- Persistence uses JSON files in data/ (no external DB required).
- Twilio is optional; in test mode the OTP code is 123456.
- Withdrawals are simulated — integrate a real payout provider when ready (Paystack/Flutterwave).
