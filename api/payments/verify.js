const { parseCookies } = require("../_lib/cookies");
const { SESSION_COOKIE, verifySessionToken } = require("../_lib/session");
const { getMongoDb } = require("../_lib/mongo");
const { getTier, applyMembershipChange } = require("../_lib/tiers");

const MEMBERS_COLLECTION = process.env.MONGODB_MEMBERS_COLLECTION || "members";
const CONFIG_COLLECTION = process.env.MONGODB_CONFIG_COLLECTION || "config";

const ADDRESSES = {
  ethereum: "0x70FBd71c755aE9355f76ff88FF5b74B2a51889D7",
  bnb: "0x70FBd71c755aE9355f76ff88FF5b74B2a51889D7",
  arbitrum: "0x70FBd71c755aE9355f76ff88FF5b74B2a51889D7",
};

const RPC_URLS = {
  ethereum: process.env.ETH_RPC_URL || "",
  bnb: process.env.BSC_RPC_URL || "",
  arbitrum: process.env.ARB_RPC_URL || "",
};

const PRICE_IDS = {
  ethereum: "ethereum",
  bnb: "binancecoin",
  arbitrum: "ethereum",
};

let priceCache = { ts: 0, data: {} };

async function rpcCall(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`rpc_failed:${r.status}:${t}`);
  }
  const j = await r.json();
  if (j.error) throw new Error(`rpc_error:${j.error.message || "unknown"}`);
  return j.result;
}

function hexToBigInt(hex) {
  if (!hex) return 0n;
  return BigInt(hex);
}

async function getPriceUsd(chain) {
  const now = Date.now();
  if (now - priceCache.ts < 60 * 1000 && priceCache.data[chain]) return priceCache.data[chain];
  const id = PRICE_IDS[chain];
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
    id
  )}&vs_currencies=usd`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const price = j && j[id] ? Number(j[id].usd) : null;
  if (!Number.isFinite(price)) return null;
  priceCache = { ts: now, data: { ...priceCache.data, [chain]: price } };
  return price;
}

async function getPricing(db) {
  const doc = db ? await db.collection(CONFIG_COLLECTION).findOne({ _id: "membership_pricing" }) : null;
  const pro = doc && Number(doc.pro_month_usd);
  const ultra = doc && Number(doc.ultra_month_usd);
  const envPro = Number(process.env.PRO_MONTH_USD || 0);
  const envUltra = Number(process.env.ULTRA_MONTH_USD || 0);
  const pro_month_usd = Number.isFinite(pro) && pro > 0 ? pro : Number.isFinite(envPro) && envPro > 0 ? envPro : null;
  const ultra_month_usd =
    Number.isFinite(ultra) && ultra > 0 ? ultra : Number.isFinite(envUltra) && envUltra > 0 ? envUltra : null;
  return { pro_month_usd, ultra_month_usd };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
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
    const payload = verifySessionToken(token);
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
      const txHash = String(obj.tx_hash || "").trim();
      if (plan !== "pro" && plan !== "ultra") {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "invalid_plan" }));
        return;
      }
      if (!RPC_URLS[network]) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "unsupported_network" }));
        return;
      }
      if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "invalid_tx_hash" }));
        return;
      }

      const db = await getMongoDb();
      if (!db) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "missing_mongodb" }));
        return;
      }
      const id = String(payload.discord_user_id);
      const member = await db
        .collection(MEMBERS_COLLECTION)
        .findOne({ _id: id, "payment_history.tx_hash": txHash });
      if (member) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true, note: "already_processed" }));
        return;
      }

      const toAddress = ADDRESSES[network].toLowerCase();
      const tx = await rpcCall(RPC_URLS[network], "eth_getTransactionByHash", [txHash]);
      if (!tx) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "tx_not_found" }));
        return;
      }
      if (!tx.to || String(tx.to).toLowerCase() !== toAddress) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "invalid_receiver" }));
        return;
      }
      if (!tx.blockNumber) {
        res.statusCode = 202;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "tx_pending" }));
        return;
      }
      const receipt = await rpcCall(RPC_URLS[network], "eth_getTransactionReceipt", [txHash]);
      if (!receipt || receipt.status !== "0x1") {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "tx_failed" }));
        return;
      }
      const valueWei = hexToBigInt(tx.value);
      const amount = Number(valueWei) / 1e18;
      const priceUsd = await getPriceUsd(network);
      if (!Number.isFinite(priceUsd)) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "price_unavailable" }));
        return;
      }
      const amountUsd = amount * priceUsd;

      const pricing = await getPricing(db);
      const threshold = plan === "pro" ? pricing.pro_month_usd : pricing.ultra_month_usd;
      if (!Number.isFinite(threshold) || threshold <= 0) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "missing_pricing" }));
        return;
      }
      if (amountUsd < threshold - 3) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "amount_insufficient", amount_usd: amountUsd, threshold_usd: threshold }));
        return;
      }
      const minutes = Math.floor((30 * 24 * 60 * amountUsd) / threshold);
      if (minutes <= 0) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "invalid_duration" }));
        return;
      }
      const currentTier = await getTier(id);
      const rank = { basic: 0, pro: 1, ultra: 2 };
      const isUpgrade = (rank[plan] || 0) > (rank[currentTier] || 0);

      const result = await applyMembershipChange(id, {
        tier: plan,
        minutes,
        is_upgrade: isUpgrade,
      });

      await db.collection(MEMBERS_COLLECTION).updateOne(
        { _id: id },
        {
          $push: {
            payment_history: {
              plan,
              network,
              tx_hash: txHash,
              tx_from: tx.from || null,
              tx_to: tx.to || null,
              amount,
              amount_usd: amountUsd,
              price_usd: priceUsd,
              created_at: new Date().toISOString(),
            },
          },
        }
      );

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true, membership: result.membership }));
    });
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "verify_failed", detail: String(e && e.message ? e.message : e) }));
  }
};
