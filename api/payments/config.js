const { getMongoDb } = require("../_lib/mongo");

const CONFIG_COLLECTION = process.env.MONGODB_CONFIG_COLLECTION || "config";

module.exports = async (req, res) => {
  try {
    const db = await getMongoDb();
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

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: true,
        pricing: { pro_month_usd, ultra_month_usd },
        addresses: {
          ethereum: "0x70FBd71c755aE9355f76ff88FF5b74B2a51889D7",
          bnb: "0x70FBd71c755aE9355f76ff88FF5b74B2a51889D7",
          solana: "8SWpuC45pvVmGGudGcMmdHGtyPqcPJZytQ5fH6tWVhvH",
          arbitrum: "0x70FBd71c755aE9355f76ff88FF5b74B2a51889D7",
        },
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "config_failed", detail: String(e && e.message ? e.message : e) }));
  }
};
