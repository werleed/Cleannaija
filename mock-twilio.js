/**
 * mock-twilio.js
 * Simple offline verification service for development.
 * - send(phone) -> stores a code in-memory and returns success
 * - check(phone, code) -> validates code
 *
 * This is intentionally simple and ephemeral (in-memory).
 */

const codes = new Map();

function genCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

module.exports = {
  send: async (phone) => {
    const code = genCode();
    codes.set(phone, { code, ts: Date.now() });
    // In dev we log but do not send SMS
    console.log(`[mock-twilio] Sent code ${code} to ${phone} (mock).`);
    return { success: true, sid: `mock-${Date.now()}` };
  },
  check: async (phone, code) => {
    const entry = codes.get(phone);
    if (!entry) return { success: false };
    // expire after 10 minutes
    const age = Date.now() - (entry.ts || 0);
    if (age > 10 * 60 * 1000) {
      codes.delete(phone);
      return { success: false, reason: "expired" };
    }
    const ok = entry.code === code.toString();
    if (ok) codes.delete(phone);
    return { success: ok };
  },
};
