const { setTier, applyMembershipChange } = require("../_lib/tiers");

module.exports = async (req, res) => {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "missing_env", need: ["ADMIN_SECRET"] }));
    return;
  }

  const provided = (req.headers["x-admin-secret"] || "").toString();
  if (provided !== adminSecret) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let obj;
    try {
      obj = JSON.parse(body || "{}");
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "invalid_json" }));
      return;
    }

    const discord_user_id = String(obj.discord_user_id || "").trim();
    const tier = String(obj.tier || "").trim();
    const days = obj.days;
    const hours = obj.hours;
    const minutes = obj.minutes;
    const is_upgrade = obj.is_upgrade;
    if (!discord_user_id || !/^\d+$/.test(discord_user_id)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "invalid_discord_user_id" }));
      return;
    }
    if (tier !== "basic" && tier !== "pro" && tier !== "ultra") {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "invalid_tier", allowed: ["basic", "pro", "ultra"] }));
      return;
    }

    try {
      const hasDuration = days != null || hours != null || minutes != null;
      if (hasDuration) {
        const result = await applyMembershipChange(discord_user_id, {
          tier,
          days,
          hours,
          minutes,
          is_upgrade,
        });
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            ok: true,
            mode: "timed_membership",
            discord_user_id,
            tier,
            is_upgrade: !!is_upgrade,
            membership: result.membership,
          })
        );
        return;
      }

      await setTier(discord_user_id, tier);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: true,
          mode: "manual_tier_only",
          discord_user_id,
          tier,
          tip: "如需按首充/续费时长计算到期，请传 days/hours/minutes",
        })
      );
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "set_tier_failed", detail: String(e && e.message ? e.message : e) }));
    }
  });
};

