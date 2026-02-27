const crypto = require("crypto");

const SESSION_COOKIE = "sl_portal_session";
const STATE_COOKIE = "sl_oauth_state";

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replaceAll("=", "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

function unbase64url(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(b64, "base64");
}

function sign(payloadB64, secret) {
  const h = crypto.createHmac("sha256", secret).update(payloadB64).digest();
  return base64url(h);
}

function makeSessionToken({ discord_user_id, tier }, secret, ttlSeconds = 60 * 60 * 24 * 7) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = { discord_user_id, tier, exp };
  const payloadB64 = base64url(JSON.stringify(payload));
  const sig = sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

function verifySessionToken(token, secret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expected = sign(payloadB64, secret);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try {
    payload = JSON.parse(unbase64url(payloadB64).toString("utf-8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (!payload.discord_user_id) return null;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function makeStateToken(secret, ttlSeconds = 10 * 60) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = { nonce, exp };
  const payloadB64 = base64url(JSON.stringify(payload));
  const sig = sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

function verifyStateToken(token, secret) {
  const p = verifySessionToken(token, secret);
  // state token 与 session token payload 不同；但 verifySessionToken 的字段校验不适用
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expected = sign(payloadB64, secret);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try {
    payload = JSON.parse(unbase64url(payloadB64).toString("utf-8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (!payload.nonce) return null;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

module.exports = {
  SESSION_COOKIE,
  STATE_COOKIE,
  makeSessionToken,
  verifySessionToken,
  makeStateToken,
  verifyStateToken,
};

