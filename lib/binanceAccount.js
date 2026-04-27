const crypto = require("crypto");

const SNAPSHOT_COLLECTION =
  process.env.MONGODB_BINANCE_COLLECTION || process.env.MONGODB_HISTORY_COLLECTION || "portal_data";
const SNAPSHOT_DOC_ID = process.env.MONGODB_BINANCE_DOC_ID || "binance_account_snapshot";
const BINANCE_BASE_URL = process.env.BINANCE_FAPI_BASE_URL || "https://fapi.binance.com";
const BINANCE_RECV_WINDOW = Math.max(1000, Number(process.env.BINANCE_RECV_WINDOW || 10000));
const CURVE_LIMIT = Math.max(30, Number(process.env.BINANCE_ACCOUNT_CURVE_LIMIT || 180));
const TRADE_LIMIT = Math.max(1, Number(process.env.BINANCE_ACCOUNT_TRADE_LIMIT || 20));
const ACCOUNT_EXCHANGE = process.env.BINANCE_ACCOUNT_EXCHANGE || "Binance";
const ACCOUNT_NAME = process.env.BINANCE_ACCOUNT_NAME || "Subaccount Perps";
const ACCOUNT_CURRENCY = process.env.BINANCE_ACCOUNT_EQUITY_CURRENCY || "USDT";

function snapshotCollection(db) {
  return db.collection(SNAPSHOT_COLLECTION);
}

function hasBinanceAccountConfig() {
  return !!(process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET);
}

function parseNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function signQuery(queryString, secret) {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

async function binanceSignedGet(pathname, params = {}) {
  const apiKey = String(process.env.BINANCE_API_KEY || "").trim();
  const apiSecret = String(process.env.BINANCE_API_SECRET || "").trim();
  if (!apiKey || !apiSecret) {
    throw new Error("missing_binance_env");
  }
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === "") return;
    query.set(key, String(value));
  });
  query.set("timestamp", String(Date.now()));
  query.set("recvWindow", String(BINANCE_RECV_WINDOW));
  const queryString = query.toString();
  const signature = signQuery(queryString, apiSecret);
  const url = `${BINANCE_BASE_URL}${pathname}?${queryString}&signature=${signature}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-MBX-APIKEY": apiKey,
      accept: "application/json",
    },
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw new Error(
      `binance_request_failed:${response.status}:${parsed && parsed.msg ? parsed.msg : text || "unknown_error"}`
    );
  }
  if (parsed && typeof parsed === "object" && parsed.code && Number(parsed.code) < 0) {
    throw new Error(`binance_api_error:${parsed.code}:${parsed.msg || "unknown_error"}`);
  }
  return parsed;
}

function formatTradeTime(timestamp) {
  const ms = parseNumber(timestamp, null);
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function inferTradeSide(record) {
  const hint = String(record && (record.info || record.symbol || "")).toUpperCase();
  if (hint.includes("SHORT")) return "short";
  if (hint.includes("LONG")) return "long";
  const pnl = parseNumber(record && record.income, 0);
  return pnl < 0 ? "short" : "long";
}

function getConfiguredInitialCapital(existingSnapshot) {
  const fromEnv = parseNumber(process.env.BINANCE_ACCOUNT_INITIAL_CAPITAL, null);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const existing = parseNumber(existingSnapshot && existingSnapshot.account && existingSnapshot.account.initial_capital, null);
  if (Number.isFinite(existing) && existing > 0) return existing;
  const firstPoint =
    existingSnapshot && Array.isArray(existingSnapshot.equity_curve) && existingSnapshot.equity_curve.length
      ? parseNumber(existingSnapshot.equity_curve[0].equity, null)
      : null;
  if (Number.isFinite(firstPoint) && firstPoint > 0) return firstPoint;
  return null;
}

function mergeCurve(existingCurve, equity, initialCapital, updatedAt) {
  const date = String(updatedAt || "").slice(0, 10);
  const base = Array.isArray(existingCurve) ? existingCurve : [];
  const filtered = base
    .map((item) => ({
      date: String(item && item.date ? item.date : ""),
      equity: parseNumber(item && item.equity, null),
      return: parseNumber(item && item.return, null),
    }))
    .filter((item) => item.date && Number.isFinite(item.equity))
    .filter((item) => item.date !== date);
  const nextReturn = Number.isFinite(initialCapital) && initialCapital > 0 ? equity / initialCapital - 1 : null;
  filtered.push({
    date,
    equity,
    return: Number.isFinite(nextReturn) ? nextReturn : 0,
  });
  filtered.sort((a, b) => a.date.localeCompare(b.date));
  return filtered.slice(-CURVE_LIMIT);
}

function computeMaxDrawdown(curve) {
  let peak = null;
  let maxDrawdown = 0;
  for (const point of Array.isArray(curve) ? curve : []) {
    const equity = parseNumber(point && point.equity, null);
    if (!Number.isFinite(equity)) continue;
    if (peak == null || equity > peak) peak = equity;
    if (peak && peak > 0) {
      const drawdown = equity / peak - 1;
      if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    }
  }
  return maxDrawdown;
}

function normalizeTrades(records, initialCapital) {
  const list = Array.isArray(records) ? records : [];
  return list
    .map((item) => {
      const pnl = parseNumber(item && item.income, null);
      if (!Number.isFinite(pnl) || pnl === 0) return null;
      return {
        time: formatTradeTime(item.time),
        symbol: String(item.symbol || item.asset || "-"),
        side: inferTradeSide(item),
        pnl,
        return:
          Number.isFinite(initialCapital) && initialCapital > 0 ? Number((pnl / initialCapital).toFixed(6)) : null,
        status: "Closed",
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.time).localeCompare(String(a.time)))
    .slice(0, TRADE_LIMIT);
}

function computeWinRate(trades) {
  const list = Array.isArray(trades) ? trades : [];
  if (!list.length) return null;
  const wins = list.filter((item) => parseNumber(item && item.pnl, 0) > 0).length;
  return wins / list.length;
}

async function readBinanceAccountSnapshot(db) {
  return snapshotCollection(db).findOne({ _id: SNAPSHOT_DOC_ID });
}

async function fetchAndStoreBinanceAccountSnapshot(db) {
  const existing = await readBinanceAccountSnapshot(db);
  const [accountData, incomeHistory] = await Promise.all([
    binanceSignedGet("/fapi/v2/account"),
    binanceSignedGet("/fapi/v1/income", { incomeType: "REALIZED_PNL", limit: TRADE_LIMIT }),
  ]);
  const updatedAt = new Date().toISOString();
  const equity =
    parseNumber(accountData && accountData.totalMarginBalance, null) ??
    parseNumber(accountData && accountData.totalWalletBalance, null) ??
    0;
  const initialCapital = getConfiguredInitialCapital(existing) ?? equity;
  const equityCurve = mergeCurve(existing && existing.equity_curve, equity, initialCapital, updatedAt);
  const trades = normalizeTrades(incomeHistory, initialCapital);
  const snapshot = {
    _id: SNAPSHOT_DOC_ID,
    updated_at: updatedAt,
    account: {
      exchange: ACCOUNT_EXCHANGE,
      account_name: ACCOUNT_NAME,
      equity_currency: ACCOUNT_CURRENCY,
      equity,
      initial_capital: initialCapital,
      total_return: Number.isFinite(initialCapital) && initialCapital > 0 ? equity / initialCapital - 1 : 0,
      max_drawdown: computeMaxDrawdown(equityCurve),
      win_rate: computeWinRate(trades),
      trading_days: equityCurve.length,
    },
    equity_curve: equityCurve,
    trades,
  };
  await snapshotCollection(db).updateOne({ _id: SNAPSHOT_DOC_ID }, { $set: snapshot }, { upsert: true });
  return snapshot;
}

function getPublicBinanceAccountSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    updated_at: snapshot.updated_at || null,
    equity_curve: Array.isArray(snapshot.equity_curve) ? snapshot.equity_curve : [],
  };
}

function getTieredBinanceAccountSnapshot(snapshot, tier) {
  if (!snapshot) return null;
  const normalizedTier = String(tier || "basic").toLowerCase();
  if (normalizedTier !== "pro" && normalizedTier !== "ultra") return null;
  const out = {
    updated_at: snapshot.updated_at || null,
    account: snapshot.account || null,
  };
  if (normalizedTier === "ultra") {
    out.trades = Array.isArray(snapshot.trades) ? snapshot.trades : [];
  }
  return out;
}

module.exports = {
  SNAPSHOT_COLLECTION,
  SNAPSHOT_DOC_ID,
  hasBinanceAccountConfig,
  readBinanceAccountSnapshot,
  fetchAndStoreBinanceAccountSnapshot,
  getPublicBinanceAccountSnapshot,
  getTieredBinanceAccountSnapshot,
};
