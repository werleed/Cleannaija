// mock-twilio.js
// Simple mock: generate OTP and pretend to "send". No external network.
const crypto = require('crypto');

module.exports = {
  generateOTP: (userId) => {
    const otp = Math.floor(1000 + Math.random() * 9000); // 4-digit
    // In a real Twilio integration you would send SMS. For now we return OTP to be saved by caller.
    console.log(`[mock-twilio] Generated OTP for ${userId}: ${otp}`);
    return otp;
  },

  sendOTP: async (phone) => {
    // simulate sending, success true for mock
    const otp = Math.floor(1000 + Math.random() * 9000);
    console.log(`[mock-twilio] sendOTP simulated to ${phone}: ${otp}`);
    return { success: true, otp };
  },

  // professional wrapper for future real Twilio integration
  sendSMS: async (phone, body) => {
    console.log(`[mock-twilio] sendSMS simulated to ${phone}: ${body}`);
    return { success: true, sid: 'MOCK123' };
  }
};
