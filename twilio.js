// twilio.js
require('dotenv').config();
const twilio = require('twilio');

// Load environment variables
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Send OTP via Twilio Verify
async function sendVerification(phone) {
  try {
    const verification = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verifications.create({ to: phone, channel: 'sms' });
    return verification.status; // 'pending'
  } catch (error) {
    console.error('Error starting verification:', error.message);
    throw error;
  }
}

// Check OTP code
async function checkVerification(phone, code) {
  try {
    const verificationCheck = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verificationChecks.create({ to: phone, code });
    return verificationCheck.status === 'approved';
  } catch (error) {
    console.error('Error verifying code:', error.message);
    return false;
  }
}

module.exports = { sendVerification, checkVerification };
