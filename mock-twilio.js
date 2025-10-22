// mock-twilio.js
// Simple offline mock verify service. Stores OTPs in-memory and in ./data/otp_store.json
const fs = require("fs");
const path = require("path");
const DATA_DIR = path.resolve(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const OTP_FILE = path.join(DATA_DIR, "otp_store.json");
const read = () => {
  try { return JSON.parse(fs.readFileSync(OTP_FILE)); } catch (e) { return {}; }
};
const write = (o) => fs.writeFileSync(OTP_FILE, JSON.stringify(o, null, 2));

module.exports = {
  send: async (phone) => {
    // generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const otps = read();
    otps[phone] = { code, ts: Date.now() };
    write(otps);
    console.log(`[mock-twilio] OTP for ${phone}: ${code}`);
    // simulate async Twilio response
    return { success: true, sid: `mock_${Date.now()}`, codeSent: code };
  },
  check: async (phone, code) => {
    const otps = read();
    const entry = otps[phone];
    if (!entry) return { success: false, reason: "no_otp" };
    // otp expires after 10 minutes
    if (Date.now() - entry.ts > 10 * 60 * 1000) { delete otps[phone]; write(otps); return { success: false, reason: "expired" }; }
    const ok = entry.code === code;
    if (ok) { delete otps[phone]; write(otps); }
    return { success: ok, reason: ok ? "approved" : "wrong_code" };
  }
};
