const { parseCookies, serializeCookie } = require("./_lib/cookies");
const { SESSION_COOKIE, verifySessionToken } = require("./_lib/session");
const { getTier, getMemberRecord } = require("./_lib/tiers");
const { getMongoDb } = require("./_lib/mongo");
const { readBinanceAccountSnapshot, getTieredBinanceAccountSnapshot } = require("../lib/binanceAccount");

module.exports = async (req, res) => {
  if (req.method === "POST") {
    res.setHeader(
      "Set-Cookie",
      serializeCookie(SESSION_COOKIE, "", {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 0,
      })
    );
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
    return;
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "missing_env", need: ["SESSION_SECRET"] }));
    return;
  }

  const cookies = parseCookies(req.headers.cookie || "");
  const tok = cookies[SESSION_COOKIE];
  const payload = tok ? verifySessionToken(tok, sessionSecret) : null;
  if (!payload) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ authenticated: false }));
    return;
  }

  const tier = await getTier(payload.discord_user_id);
  const member = await getMemberRecord(payload.discord_user_id);
  const db = await getMongoDb();
  const accountSnapshot = db ? await readBinanceAccountSnapshot(db) : null;
  const tieredAccountSnapshot = getTieredBinanceAccountSnapshot(accountSnapshot, tier);
  const paymentHistoryCount = member && Array.isArray(member.payment_history) ? member.payment_history.length : 0;
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      authenticated: true,
      discord_user_id: payload.discord_user_id,
      note: member && member.note ? member.note : null,
      can_use_referral: paymentHistoryCount === 0,
      tier,
      account_snapshot: tieredAccountSnapshot,
      membership: member
        ? {
            tier: member.tier || "basic",
            first_opened_at: member.first_opened_at || null,
            expires_at: member.expires_at || null,
            last_recharge_at: member.last_recharge_at || null,
            last_recharge_duration: member.last_recharge_duration || null,
            last_operation: member.last_operation || null,
          }
        : null,
    })
  );
};

