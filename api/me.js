const { parseCookies } = require("./_lib/cookies");
const { SESSION_COOKIE, verifySessionToken } = require("./_lib/session");
const { getTier, getMemberRecord } = require("./_lib/tiers");

module.exports = async (req, res) => {
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
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      authenticated: true,
      discord_user_id: payload.discord_user_id,
      tier,
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

