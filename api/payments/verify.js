const { parseCookies } = require("../_lib/cookies");
const { SESSION_COOKIE, verifySessionToken } = require("../_lib/session");
const { getMongoDb } = require("../_lib/mongo");
const { getTier, applyMembershipChange } = require("../_lib/tiers");

const MEMBERS_COLLECTION = process.env.MONGODB_MEMBERS_COLLECTION || "members";
const CONFIG_COLLECTION = process.env.MONGODB_CONFIG_COLLECTION || "config";
const PAYMENTS_COLLECTION = process.env.MONGODB_PAYMENTS_COLLECTION || "payments";
const PAYMENT_ORDERS_COLLECTION = process.env.MONGODB_PAYMENT_ORDERS_COLLECTION || "payment_orders";

// 会员时长计算
// - 统一按 31 天一个“月”
// - 允许小额差价（例如 168 的价格，充值到 167.5 也按足额 31 天给满）
const MEMBERSHIP_MONTH_DAYS = 31;
const MEMBERSHIP_MONTH_MINUTES = MEMBERSHIP_MONTH_DAYS * 24 * 60;
const MEMBERSHIP_PRICE_SHORTFALL_ALLOW_USD = 0.6;

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

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ERC20_TOKENS = {
  ethereum: {
    USDT: { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 },
    USDC: { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
  },
  bnb: {
    USDT: { address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18 },
    USDC: { address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18 },
  },
  arbitrum: {
    USDT: { address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6 },
    USDC: { address: "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", decimals: 6 },
  },
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

function normalizeAddress(addr) {
  return String(addr || "").toLowerCase();
}

function isTransferToAddress(logs, toAddress) {
  if (!Array.isArray(logs)) return null;
  const target = normalizeAddress(toAddress).replace(/^0x/, "");
  for (const log of logs) {
    if (!log || !Array.isArray(log.topics) || log.topics.length < 3) continue;
    if (String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    const topicTo = String(log.topics[2] || "").toLowerCase().replace(/^0x/, "");
    const to = topicTo.slice(-40);
    if (to === target) {
      return log.address || null;
    }
  }
  return null;
}

function parseErc20Transfer(logs, toAddress, tokenMap) {
  if (!Array.isArray(logs) || !tokenMap) return null;
  const target = normalizeAddress(toAddress).replace(/^0x/, "");
  for (const log of logs) {
    if (!log || !Array.isArray(log.topics) || log.topics.length < 3) continue;
    if (String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    const tokenAddr = normalizeAddress(log.address);
    const tokenEntry = Object.entries(tokenMap).find(([, meta]) => meta.address === tokenAddr);
    if (!tokenEntry) continue;
    const topicTo = String(log.topics[2] || "").toLowerCase().replace(/^0x/, "");
    const to = topicTo.slice(-40);
    if (to !== target) continue;
    const raw = hexToBigInt(log.data || "0x0");
    const [symbol, meta] = tokenEntry;
    const amount = Number(raw) / 10 ** meta.decimals;
    return { symbol, amount, token_address: tokenAddr };
  }
  return null;
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

function parseIsoMs(v) {
  const ms = Date.parse(String(v || ""));
  return Number.isFinite(ms) ? ms : null;
}

function buildPaymentId(network, txHash) {
  return `${String(network || "").trim().toLowerCase()}:${String(txHash || "").trim().toLowerCase()}`;
}

function escapeRegex(v) {
  return String(v || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getOrderForVerify(db, { orderToken, discordUserId, plan, network }) {
  const order = await db.collection(PAYMENT_ORDERS_COLLECTION).findOne({ _id: orderToken });
  if (!order) return { ok: false, statusCode: 400, error: "invalid_order_token" };
  if (String(order.discord_user_id || "") !== String(discordUserId || "")) {
    return { ok: false, statusCode: 403, error: "order_token_mismatch_user" };
  }
  if (String(order.plan || "") !== String(plan || "") || String(order.network || "") !== String(network || "")) {
    return { ok: false, statusCode: 400, error: "order_token_mismatch_payload" };
  }
  if (String(order.status || "") !== "issued") {
    return { ok: false, statusCode: 409, error: "order_token_used" };
  }
  const expMs = parseIsoMs(order.expires_at);
  if (!Number.isFinite(expMs) || expMs <= Date.now()) {
    return { ok: false, statusCode: 410, error: "order_token_expired" };
  }
  return { ok: true, order };
}

async function consumeOrderToken(db, { orderToken, discordUserId, plan, network, txHash }) {
  const nowIso = new Date().toISOString();
  const r = await db.collection(PAYMENT_ORDERS_COLLECTION).updateOne(
    {
      _id: orderToken,
      discord_user_id: String(discordUserId || ""),
      plan: String(plan || ""),
      network: String(network || ""),
      status: "issued",
    },
    {
      $set: {
        status: "consumed",
        consumed_at: nowIso,
        tx_hash: String(txHash || "").toLowerCase(),
      },
    }
  );
  return r && r.modifiedCount === 1;
}

async function releaseOrderToken(db, { orderToken, discordUserId, plan, network, txHash }) {
  await db.collection(PAYMENT_ORDERS_COLLECTION).updateOne(
    {
      _id: orderToken,
      discord_user_id: String(discordUserId || ""),
      plan: String(plan || ""),
      network: String(network || ""),
      status: "consumed",
      tx_hash: String(txHash || "").toLowerCase(),
    },
    {
      $set: { status: "issued" },
      $unset: { consumed_at: "", tx_hash: "" },
    }
  );
}

async function getBlockTimestampMs(network, blockNumberHex) {
  if (!blockNumberHex) return null;
  const block = await rpcCall(RPC_URLS[network], "eth_getBlockByNumber", [blockNumberHex, false]);
  if (!block || !block.timestamp) return null;
  const sec = Number(hexToBigInt(block.timestamp));
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return sec * 1000;
}

async function getMemberProfile(db, discordUserId) {
  const doc =
    (await db.collection(MEMBERS_COLLECTION).findOne(
      { _id: String(discordUserId || "") },
      { projection: { _id: 1, discord_user_id: 1, note: 1, tier: 1, payment_history: 1 } }
    )) ||
    (await db.collection(MEMBERS_COLLECTION).findOne(
      { discord_user_id: String(discordUserId || "") },
      { projection: { _id: 1, discord_user_id: 1, note: 1, tier: 1, payment_history: 1 } }
    ));
  return doc || null;
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

async function rewardReferrer(db, referrerId) {
  const tier = await getTier(referrerId);
  if (tier !== "pro" && tier !== "ultra") return { rewarded: false, reason: "referrer_not_member" };
  const result = await applyMembershipChange(referrerId, {
    tier,
    days: 10,
    is_upgrade: false,
  });
  return { rewarded: true, tier, membership: result.membership };
}

async function rewardBuyerByReferral(buyerId, tier) {
  if (tier !== "pro" && tier !== "ultra") return { rewarded: false, reason: "buyer_tier_not_supported" };
  const result = await applyMembershipChange(buyerId, {
    tier,
    days: 5,
    is_upgrade: false,
  });
  return { rewarded: true, tier, membership: result.membership };
}

async function reservePaymentTx(db, { network, txHash, discordUserId, plan, note }) {
  const paymentId = buildPaymentId(network, txHash);
  try {
    await db.collection(PAYMENTS_COLLECTION).insertOne({
      _id: paymentId,
      network: String(network || "").trim(),
      tx_hash: String(txHash || "").trim().toLowerCase(),
      discord_user_id: String(discordUserId || ""),
      note: String(note || "").trim() || null,
      plan: String(plan || "").trim(),
      status: "processing",
      created_at: new Date().toISOString(),
    });
    return { ok: true, paymentId };
  } catch (e) {
    if (e && e.code === 11000) {
      const existing = await db.collection(PAYMENTS_COLLECTION).findOne({ _id: paymentId });
      return { ok: false, duplicate: true, existing };
    }
    throw e;
  }
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
      const txHash = String(obj.tx_hash || "").trim().toLowerCase();
      const orderToken = String(obj.order_token || "").trim();
      const referrerInput = String(obj.referrer || "").trim();
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
      if (!/^[a-fA-F0-9]{32,128}$/.test(orderToken)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "invalid_order_token" }));
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
      const me = await getMemberProfile(db, id);
      const memberNote = String(me && me.note ? me.note : "").trim() || null;
      const hasPaidBefore = !!(me && Array.isArray(me.payment_history) && me.payment_history.length > 0);
      const orderCheck = await getOrderForVerify(db, { orderToken, discordUserId: id, plan, network });
      if (!orderCheck.ok) {
        res.statusCode = orderCheck.statusCode;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: orderCheck.error }));
        return;
      }
      const member = await db
        .collection(MEMBERS_COLLECTION)
        .findOne({ _id: id, "payment_history.tx_hash": txHash });
      if (member) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true, note: "already_processed" }));
        return;
      }
      let referrer = null;
      if (referrerInput) {
        if (hasPaidBefore) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "referrer_not_allowed_after_first_payment" }));
          return;
        }
        referrer = await resolveReferrer(db, referrerInput);
        if (!referrer) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "invalid_referrer" }));
          return;
        }
        const referrerId = String(referrer._id || referrer.discord_user_id || "");
        if (referrerId === id) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "invalid_referrer_self" }));
          return;
        }
      }

      const toAddress = ADDRESSES[network].toLowerCase();
      const tx = await rpcCall(RPC_URLS[network], "eth_getTransactionByHash", [txHash]);
      if (!tx) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "tx_not_found" }));
        return;
      }
      const receipt = await rpcCall(RPC_URLS[network], "eth_getTransactionReceipt", [txHash]);
      const blockNumberHex = tx.blockNumber || (receipt && receipt.blockNumber) || null;
      const txMinedAtMs = await getBlockTimestampMs(network, blockNumberHex);
      const orderCreatedMs = parseIsoMs(orderCheck.order && orderCheck.order.created_at);
      if (Number.isFinite(txMinedAtMs) && Number.isFinite(orderCreatedMs) && orderCreatedMs > txMinedAtMs) {
        res.statusCode = 409;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "order_token_created_after_tx" }));
        return;
      }
      const erc20 = parseErc20Transfer(receipt && receipt.logs, toAddress, ERC20_TOKENS[network]);
      if (!tx.to || normalizeAddress(tx.to) !== toAddress) {
        if (erc20) {
          const amountUsd = erc20.amount;
          const pricing = await getPricing(db);
          const threshold = plan === "pro" ? pricing.pro_month_usd : pricing.ultra_month_usd;
          if (!Number.isFinite(threshold) || threshold <= 0) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: "missing_pricing" }));
            return;
          }
          if (amountUsd < threshold - MEMBERSHIP_PRICE_SHORTFALL_ALLOW_USD) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: "amount_insufficient", amount_usd: amountUsd, threshold_usd: threshold }));
            return;
          }
          // 差价在允许范围内，按足额整月给满；否则按金额比例换算
          const effectiveUsd = amountUsd < threshold ? threshold : amountUsd;
          const minutes = Math.floor((MEMBERSHIP_MONTH_MINUTES * effectiveUsd) / threshold);
          if (minutes <= 0) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: "invalid_duration" }));
            return;
          }
          const currentTier = await getTier(id);
          const rank = { basic: 0, pro: 1, ultra: 2 };
          const isUpgrade = (rank[plan] || 0) > (rank[currentTier] || 0);
          const reserve = await reservePaymentTx(db, { network, txHash, discordUserId: id, plan, note: memberNote });
          if (!reserve.ok) {
            const sameUser = reserve.existing && String(reserve.existing.discord_user_id || "") === id;
            res.statusCode = sameUser ? 200 : 409;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify(
                sameUser
                  ? { ok: true, note: "already_processed" }
                  : { error: "tx_hash_already_used", tx_hash: txHash, network }
              )
            );
            return;
          }
          const consumed = await consumeOrderToken(db, { orderToken, discordUserId: id, plan, network, txHash });
          if (!consumed) {
            await db.collection(PAYMENTS_COLLECTION).deleteOne({ _id: reserve.paymentId, status: "processing" });
            res.statusCode = 409;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: "order_token_used" }));
            return;
          }

          let result;
          try {
            result = await applyMembershipChange(id, {
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
                    token: erc20.symbol,
                    token_address: erc20.token_address,
                    amount: erc20.amount,
                    amount_usd: amountUsd,
                    price_usd: 1,
                    note: memberNote,
                    referrer: referrerInput || null,
                    created_at: new Date().toISOString(),
                  },
                },
              }
            );
            let referralReward = null;
            if (referrer) {
              try {
                const referrerId = String(referrer._id || referrer.discord_user_id || "");
                const referrerReward = await rewardReferrer(db, referrerId);
                const buyerReward = await rewardBuyerByReferral(id, plan);
                referralReward = {
                  referrer: referrerReward,
                  buyer_bonus: buyerReward,
                };
              } catch {
                referralReward = { rewarded: false, reason: "reward_failed" };
              }
            }
            await db.collection(PAYMENTS_COLLECTION).updateOne(
              { _id: reserve.paymentId },
              {
                $set: {
                  status: "completed",
                  completed_at: new Date().toISOString(),
                  referrer_user_id: referrer ? String(referrer._id || referrer.discord_user_id || "") : null,
                  referrer_note: referrer && referrer.note ? referrer.note : null,
                  referral_reward: referralReward || null,
                },
              }
            );
          } catch (grantErr) {
            await releaseOrderToken(db, { orderToken, discordUserId: id, plan, network, txHash });
            await db.collection(PAYMENTS_COLLECTION).deleteOne({ _id: reserve.paymentId, status: "processing" });
            throw grantErr;
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: true, membership: result.membership }));
          return;
        }
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: "invalid_receiver",
            expected_receiver: ADDRESSES[network],
            actual_receiver: tx.to || null,
          })
        );
        return;
      }
      if (!tx.blockNumber) {
        res.statusCode = 202;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "tx_pending" }));
        return;
      }
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
      if (amountUsd < threshold - MEMBERSHIP_PRICE_SHORTFALL_ALLOW_USD) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "amount_insufficient", amount_usd: amountUsd, threshold_usd: threshold }));
        return;
      }
      // 差价在允许范围内，按足额整月给满；否则按金额比例换算
      const effectiveUsd = amountUsd < threshold ? threshold : amountUsd;
      const minutes = Math.floor((MEMBERSHIP_MONTH_MINUTES * effectiveUsd) / threshold);
      if (minutes <= 0) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "invalid_duration" }));
        return;
      }
      const currentTier = await getTier(id);
      const rank = { basic: 0, pro: 1, ultra: 2 };
      const isUpgrade = (rank[plan] || 0) > (rank[currentTier] || 0);

      const reserve = await reservePaymentTx(db, { network, txHash, discordUserId: id, plan, note: memberNote });
      if (!reserve.ok) {
        const sameUser = reserve.existing && String(reserve.existing.discord_user_id || "") === id;
        res.statusCode = sameUser ? 200 : 409;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify(
            sameUser
              ? { ok: true, note: "already_processed" }
              : { error: "tx_hash_already_used", tx_hash: txHash, network }
          )
        );
        return;
      }
      const consumed = await consumeOrderToken(db, { orderToken, discordUserId: id, plan, network, txHash });
      if (!consumed) {
        await db.collection(PAYMENTS_COLLECTION).deleteOne({ _id: reserve.paymentId, status: "processing" });
        res.statusCode = 409;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "order_token_used" }));
        return;
      }

      let result;
      try {
        result = await applyMembershipChange(id, {
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
                note: memberNote,
                referrer: referrerInput || null,
                created_at: new Date().toISOString(),
              },
            },
          }
        );
        let referralReward = null;
        if (referrer) {
          try {
            const referrerId = String(referrer._id || referrer.discord_user_id || "");
            const referrerReward = await rewardReferrer(db, referrerId);
            const buyerReward = await rewardBuyerByReferral(id, plan);
            referralReward = {
              referrer: referrerReward,
              buyer_bonus: buyerReward,
            };
          } catch {
            referralReward = { rewarded: false, reason: "reward_failed" };
          }
        }
        await db.collection(PAYMENTS_COLLECTION).updateOne(
          { _id: reserve.paymentId },
          {
            $set: {
              status: "completed",
              completed_at: new Date().toISOString(),
              referrer_user_id: referrer ? String(referrer._id || referrer.discord_user_id || "") : null,
              referrer_note: referrer && referrer.note ? referrer.note : null,
              referral_reward: referralReward || null,
            },
          }
        );
      } catch (grantErr) {
        await releaseOrderToken(db, { orderToken, discordUserId: id, plan, network, txHash });
        await db.collection(PAYMENTS_COLLECTION).deleteOne({ _id: reserve.paymentId, status: "processing" });
        throw grantErr;
      }

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
