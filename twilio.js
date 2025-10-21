const axios = require('axios');
require('dotenv').config();
const ACCOUNT_SID = process.env.TWILIO_SID || '';
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const VERIFY_SID = process.env.TWILIO_VERIFY_SID || '';
const baseUrl = 'https://verify.twilio.com/v2/Services';

async function startVerify(phone) {
  if (!ACCOUNT_SID || !AUTH_TOKEN || !VERIFY_SID) {
    return { success: true, simulated: true, phone };
  }
  try {
    const resp = await axios.post(`${baseUrl}/${VERIFY_SID}/Verifications`, new URLSearchParams({
      To: phone,
      Channel: 'sms'
    }).toString(), {
      auth: { username: ACCOUNT_SID, password: AUTH_TOKEN },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return { success: true, status: resp.data.status };
  } catch (err) {
    return { success: false, error: err.response && err.response.data ? JSON.stringify(err.response.data) : err.message };
  }
}
async function checkVerify(phone, code) {
  if (!ACCOUNT_SID || !AUTH_TOKEN || !VERIFY_SID) {
    if (code === '123456') return { success: true, simulated: true };
    return { success: false, error: 'In test mode use code 123456' };
  }
  try {
    const resp = await axios.post(`${baseUrl}/${VERIFY_SID}/VerificationCheck`, new URLSearchParams({
      To: phone,
      Code: code
    }).toString(), {
      auth: { username: ACCOUNT_SID, password: AUTH_TOKEN },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (resp.data && resp.data.status === 'approved') return { success: true };
    return { success: false, error: 'not_approved:' + (resp.data.status||'') };
  } catch (err) {
    return { success: false, error: err.response && err.response.data ? JSON.stringify(err.response.data) : err.message };
  }
}
module.exports = { startVerify, checkVerify };
