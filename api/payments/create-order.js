const crypto = require("crypto");
const { parseCookies } = require("../_lib/cookies");
const { SESSION_COOKIE, verifySessionToken } = require("../_lib/session");
const { getMongoDb } = require("../_lib/mongo");

const PAYMENT_ORDERS_COLLECTION = process.env.MONGODB_PAYMENT_ORDERS_COLLECTION || "payment_orders";
const PAYMENT_ORDER_EXPIRE_MINUTES = Number(process.env.PAYMENT_ORDER_EXPIRE_MINUTES || 30);
const SUPPORTED_NETWORKS = new Set(["ethereum", "bnb", "arbitrum"]);

function createOrderToken() {
  return crypto.randomBytes(24).toString("hex");
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
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

    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (!token) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const payload = verifySessionToken(token, sessionSecret);
    if (!payload || !payload.discord_user_id) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "unauthorized" }));
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

      const plan = String(obj.plan || "").trim();
      const network = String(obj.network || "").trim();
      if (plan !== "pro" && plan !== "ultra") {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "invalid_plan" }));
        return;
      }
      if (!SUPPORTED_NETWORKS.has(network)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "unsupported_network" }));
        return;
      }

      const db = await getMongoDb();
      if (!db) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "missing_mongodb" }));
        return;
      }

      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const expMs = now + Math.max(5, Math.floor(PAYMENT_ORDER_EXPIRE_MINUTES)) * 60 * 1000;
      const expiresAt = new Date(expMs).toISOString();
      const discordUserId = String(payload.discord_user_id);
      const orderToken = createOrderToken();

      await db.collection(PAYMENT_ORDERS_COLLECTION).insertOne({
        _id: orderToken,
        discord_user_id: discordUserId,
        plan,
        network,
        status: "issued",
        created_at: nowIso,
        expires_at: expiresAt,
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: true,
          order_token: orderToken,
          expires_at: expiresAt,
        })
      );
    });
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "create_order_failed", detail: String(e && e.message ? e.message : e) }));
  }
};
