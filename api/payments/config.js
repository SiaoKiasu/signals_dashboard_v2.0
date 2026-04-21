const { getMongoDb } = require("../_lib/mongo");

const CONFIG_COLLECTION = process.env.MONGODB_CONFIG_COLLECTION || "config";
const MEMBERS_COLLECTION = process.env.MONGODB_MEMBERS_COLLECTION || "members";

async function getPricingAndAddresses(db) {
  let pricing = null;
  if (db) {
    pricing = await db.collection(CONFIG_COLLECTION).findOne({ _id: "membership_pricing" });
  }
  const pro = pricing && Number(pricing.pro_month_usd);
  const ultra = pricing && Number(pricing.ultra_month_usd);
  const envPro = Number(process.env.PRO_MONTH_USD || 0);
  const envUltra = Number(process.env.ULTRA_MONTH_USD || 0);
  const pro_month_usd = Number.isFinite(pro) && pro > 0 ? pro : Number.isFinite(envPro) && envPro > 0 ? envPro : null;
  const ultra_month_usd =
    Number.isFinite(ultra) && ultra > 0 ? ultra : Number.isFinite(envUltra) && envUltra > 0 ? envUltra : null;
  return {
    pricing: { pro_month_usd, ultra_month_usd },
    addresses: {
      ethereum: "0x70FBd71c755aE9355f76ff88FF5b74B2a51889D7",
      bnb: "0x70FBd71c755aE9355f76ff88FF5b74B2a51889D7",
      solana: "8SWpuC45pvVmGGudGcMmdHGtyPqcPJZytQ5fH6tWVhvH",
      arbitrum: "0x70FBd71c755aE9355f76ff88FF5b74B2a51889D7",
    },
  };
}

function escapeRegex(v) {
  return String(v || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolveReferrer(db, rawInput) {
  const input = String(rawInput || "").trim();
  if (!input) return null;
  if (/^\d{6,30}$/.test(input)) {
    const byId =
      (await db.collection(MEMBERS_COLLECTION).findOne(
        { _id: input },
        { projection: { _id: 1, discord_user_id: 1, note: 1, tier: 1 } }
      )) ||
      (await db.collection(MEMBERS_COLLECTION).findOne(
        { discord_user_id: input },
        { projection: { _id: 1, discord_user_id: 1, note: 1, tier: 1 } }
      ));
    if (byId) return byId;
  }
  const byNote = await db.collection(MEMBERS_COLLECTION).findOne(
    { note: { $regex: `^${escapeRegex(input)}$`, $options: "i" } },
    { projection: { _id: 1, discord_user_id: 1, note: 1, tier: 1 } }
  );
  return byNote || null;
}

module.exports = async (req, res) => {
  try {
    const db = await getMongoDb();
    if (req.method === "POST") {
      if (!db) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "missing_mongodb" }));
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
        const query = String(obj.referrer || "").trim();
        if (!query) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: true, valid: false, error: "missing_referrer" }));
          return;
        }
        const member = await resolveReferrer(db, query);
        if (!member) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: true, valid: false, error: "referrer_not_found" }));
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            ok: true,
            valid: true,
            referrer: {
              discord_user_id: String(member._id || member.discord_user_id || ""),
              note: member.note || null,
              tier: member.tier || "basic",
            },
          })
        );
      });
      return;
    }

    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, POST");
      res.end("Method Not Allowed");
      return;
    }

    const data = await getPricingAndAddresses(db);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: true,
        pricing: data.pricing,
        addresses: data.addresses,
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "config_failed", detail: String(e && e.message ? e.message : e) }));
  }
};
