const { setTier } = require("../_lib/tiers");

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
      await setTier(discord_user_id, tier);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true, discord_user_id, tier }));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "set_tier_failed", detail: String(e && e.message ? e.message : e) }));
    }
  });
};

