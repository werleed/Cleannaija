// twilio.js
require('dotenv').config();
const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const VERIFY_SID = process.env.TWILIO_VERIFY_SID;

module.exports = {
  // Start OTP verification
  async startVerify(phone) {
    try {
      const res = await client.verify.v2
        .services(VERIFY_SID)
        .verifications.create({ to: `+${phone}`, channel: 'sms' });
      return { success: true, sid: res.sid };
    } catch (err) {
      console.error('Twilio startVerify error:', err.message);
      return { success: false, error: err.message };
    }
  },

  // Check OTP code
  async checkVerify(phone, code) {
    try {
      const res = await client.verify.v2
        .services(VERIFY_SID)
        .verificationChecks.create({ to: `+${phone}`, code });
      if (res.status === 'approved') {
        return { success: true };
      }
      return { success: false, error: 'Invalid code' };
    } catch (err) {
      console.error('Twilio checkVerify error:', err.message);
      return { success: false, error: err.message };
    }
  },
};
