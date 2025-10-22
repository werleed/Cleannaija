const twilio = require('twilio');
require('dotenv').config();

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

module.exports = {
  async startVerify(phone) {
    try {
      const verification = await client.verify.v2
        .services(process.env.TWILIO_VERIFY_SID)
        .verifications.create({ to: phone, channel: 'sms' });
      return { success: true, sid: verification.sid };
    } catch (err) {
      console.error('Twilio Verify error:', err.message);
      return { success: false, error: err.message };
    }
  },

  async checkVerify(phone, code) {
    try {
      const check = await client.verify.v2
        .services(process.env.TWILIO_VERIFY_SID)
        .verificationChecks.create({ to: phone, code });
      return check.status === 'approved';
    } catch (err) {
      console.error('Twilio Check error:', err.message);
      return false;
    }
  },
};
