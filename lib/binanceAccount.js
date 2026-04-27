const crypto = require("crypto");

const ACCOUNT_DATA_COLLECTION = process.env.MONGODB_ACCOUNT_DATA_COLLECTION || "account_data";
const EQUITY_DOC_ID = process.env.MONGODB_ACCOUNT_EQUITY_DOC_ID || "equity_history";
const RETURN_DOC_ID = process.env.MONGODB_ACCOUNT_RETURN_DOC_ID || "return_history";
const TRADE_DOC_ID = process.env.MONGODB_ACCOUNT_TRADE_DOC_ID || "trade_history";
const BINANCE_BASE_URL = process.env.BINANCE_FAPI_BASE_URL || "https://fapi.binance.com";
const BINANCE_RECV_WINDOW = Math.max(1000, Number(process.env.BINANCE_RECV_WINDOW || 10000));
const INCOME_PAGE_LIMIT = Math.min(1000, Math.max(100, Number(process.env.BINANCE_ACCOUNT_INCOME_PAGE_LIMIT || 1000)));
const BINANCE_ACCOUNT_START_DATE = process.env.BINANCE_ACCOUNT_START_DATE || "2026-01-01";
const USER_TRADE_SYMBOLS = String(process.env.BINANCE_ACCOUNT_SYMBOLS || "")
  .split(",")
  .map((item) => item.trim().toUpperCase())
  .filter(Boolean);
const ACCOUNT_EXCHANGE = process.env.BINANCE_ACCOUNT_EXCHANGE || "Binance";
const ACCOUNT_NAME = process.env.BINANCE_ACCOUNT_NAME || "合约子账户3";
const ACCOUNT_CURRENCY = process.env.BINANCE_ACCOUNT_EQUITY_CURRENCY || "USDT";
const EXCLUDED_EQUITY_INCOME_TYPES = new Set(
  String(
    process.env.BINANCE_ACCOUNT_EXCLUDED_INCOME_TYPES ||
      "TRANSFER,INTERNAL_TRANSFER,CROSS_COLLATERAL_TRANSFER,STRATEGY_UMFUTURES_TRANSFER,COIN_SWAP_DEPOSIT,COIN_SWAP_WITHDRAW"
  )
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)
);

function accountDataCollection(db) {
  return db.collection(ACCOUNT_DATA_COLLECTION);
}

function parseNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function hasBinanceAccountConfig() {
  return !!(process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET);
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

async function fetchAllIncomeHistory(params = {}) {
  const out = [];
  let page = 1;
  while (true) {
    const rows = await binanceSignedGet("/fapi/v1/income", {
      ...params,
      page,
      limit: INCOME_PAGE_LIMIT,
    });
    const list = Array.isArray(rows) ? rows : [];
    out.push(...list);
    if (list.length < INCOME_PAGE_LIMIT) break;
    page += 1;
    if (page > 200) break;
  }
  return out;
}

function startOfUtcDay(input) {
  const d = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function addUtcDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function configuredStartDate() {
  const raw = String(BINANCE_ACCOUNT_START_DATE || "").trim() || "2026-01-01";
  const parsed = startOfUtcDay(raw);
  if (Number.isNaN(parsed.getTime())) {
    return startOfUtcDay("2026-01-01T00:00:00Z");
  }
  return parsed;
}

function dateRangeChunks(startDate, endDate, chunkDays = 7) {
  const out = [];
  let cursor = startOfUtcDay(startDate);
  const end = new Date(endDate.getTime());
  while (cursor <= end) {
    const next = addUtcDays(cursor, chunkDays);
    const chunkEnd = new Date(Math.min(next.getTime() - 1, end.getTime()));
    out.push({ startTime: cursor.getTime(), endTime: chunkEnd.getTime() });
    cursor = next;
  }
  return out;
}

async function fetchIncomeHistoryInRange(params = {}, startDate = configuredStartDate()) {
  const end = new Date();
  const start = startOfUtcDay(startDate);
  const chunks = dateRangeChunks(start, end, 7);
  const out = [];
  for (const chunk of chunks) {
    const rows = await fetchAllIncomeHistory({
      ...params,
      startTime: chunk.startTime,
      endTime: chunk.endTime,
    });
    out.push(...rows);
  }
  out.sort((a, b) => (parseNumber(a && a.time, 0) || 0) - (parseNumber(b && b.time, 0) || 0));
  return out;
}

async function fetchUserTradesChunk(symbol, startTime, endTime) {
  const rows = await binanceSignedGet("/fapi/v1/userTrades", {
    symbol,
    startTime,
    endTime,
    limit: 1000,
  });
  const list = Array.isArray(rows) ? rows : [];
  if (list.length < 1000 || endTime - startTime <= 6 * 60 * 60 * 1000) {
    return list;
  }
  const mid = Math.floor((startTime + endTime) / 2);
  const [left, right] = await Promise.all([
    fetchUserTradesChunk(symbol, startTime, mid),
    fetchUserTradesChunk(symbol, mid + 1, endTime),
  ]);
  return [...left, ...right];
}

async function fetchAllUserTrades(symbols, startDate = configuredStartDate()) {
  const out = [];
  if (!Array.isArray(symbols) || !symbols.length) return out;
  const end = new Date();
  const start = startOfUtcDay(startDate);
  const chunks = dateRangeChunks(start, end, 7);
  for (const symbol of symbols) {
    for (const chunk of chunks) {
      const rows = await fetchUserTradesChunk(symbol, chunk.startTime, chunk.endTime);
      out.push(...rows);
    }
  }
  out.sort((a, b) => (parseNumber(a && a.time, 0) || 0) - (parseNumber(b && b.time, 0) || 0));
  return out;
}

function toDateKey(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function formatTradeTime(timestamp) {
  const ms = parseNumber(timestamp, null);
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function inferTradeSide(record) {
  const hint = String(record && (record.info || "")).toUpperCase();
  if (hint.includes("SHORT")) return "short";
  if (hint.includes("LONG")) return "long";
  const pnl = parseNumber(record && record.income, 0);
  return pnl < 0 ? "short" : "long";
}

function getInitialCapital(currentWalletBalance, netIncomes, existingEquityDoc) {
  const fromEnv = parseNumber(process.env.BINANCE_ACCOUNT_INITIAL_CAPITAL, null);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const fromDoc = parseNumber(existingEquityDoc && existingEquityDoc.initial_capital, null);
  if (Number.isFinite(fromDoc) && fromDoc > 0) return fromDoc;
  const totalNetIncome = netIncomes.reduce((sum, item) => sum + (parseNumber(item.net_income, 0) || 0), 0);
  if (Number.isFinite(currentWalletBalance)) {
    return Number((currentWalletBalance - totalNetIncome).toFixed(8));
  }
  return null;
}

function buildDailyNetIncome(allIncomeRows) {
  const grouped = new Map();
  for (const item of Array.isArray(allIncomeRows) ? allIncomeRows : []) {
    const incomeType = String(item && item.incomeType ? item.incomeType : "").toUpperCase();
    if (EXCLUDED_EQUITY_INCOME_TYPES.has(incomeType)) continue;
    const date = toDateKey(parseNumber(item && item.time, null));
    if (!date) continue;
    const income = parseNumber(item && item.income, 0) || 0;
    grouped.set(date, (grouped.get(date) || 0) + income);
  }
  return Array.from(grouped.entries())
    .map(([date, net_income]) => ({ date, net_income: Number(net_income.toFixed(8)) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildEquityPoints(startingEquity, dailyNetIncome, currentWalletBalance, startDate = configuredStartDate()) {
  if (!Number.isFinite(startingEquity)) return [];
  const netByDate = new Map(dailyNetIncome.map((item) => [item.date, parseNumber(item.net_income, 0) || 0]));
  const firstDate = startOfUtcDay(startDate);
  const todayDate = startOfUtcDay(new Date());
  const uniqueDates = [];
  for (let cursor = new Date(firstDate.getTime()); cursor <= todayDate; cursor = addUtcDays(cursor, 1)) {
    uniqueDates.push(toDateKey(cursor));
  }
  let running = startingEquity;
  const out = [];
  for (const date of uniqueDates) {
    running += netByDate.get(date) || 0;
    out.push({ date, equity: Number(running.toFixed(8)) });
  }
  if (Number.isFinite(currentWalletBalance) && out.length) {
    out[out.length - 1].equity = Number(currentWalletBalance.toFixed(8));
  }
  return out;
}

function buildReturnPoints(equityPoints, initialCapital) {
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) return [];
  return equityPoints.map((item) => ({
    date: item.date,
    return: Number(((item.equity - initialCapital) / initialCapital).toFixed(8)),
  }));
}

function normalizeTrades(realizedPnlRows, initialCapital) {
  return (Array.isArray(realizedPnlRows) ? realizedPnlRows : [])
    .map((item) => {
      const pnl = parseNumber(item && item.income, null);
      if (!Number.isFinite(pnl) || pnl === 0) return null;
      return {
        time: formatTradeTime(item.time),
        timestamp: parseNumber(item.time, null),
        date: toDateKey(parseNumber(item.time, null)),
        symbol: String(item.symbol || item.asset || "-"),
        side: inferTradeSide(item),
        pnl: Number(pnl.toFixed(8)),
        return:
          Number.isFinite(initialCapital) && initialCapital > 0 ? Number((pnl / initialCapital).toFixed(8)) : null,
        status: "Closed",
        income_type: String(item.incomeType || "REALIZED_PNL"),
        trade_id: item.tradeId || item.tranId || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

function normalizeSideFromTrade(item) {
  const positionSide = String(item && item.positionSide ? item.positionSide : "").toUpperCase();
  if (positionSide === "SHORT") return "short";
  if (positionSide === "LONG") return "long";
  const side = String(item && item.side ? item.side : "").toUpperCase();
  return side === "SELL" ? "short" : "long";
}

function aggregateUserTrades(userTrades, initialCapital) {
  const groups = new Map();
  for (const item of Array.isArray(userTrades) ? userTrades : []) {
    const symbol = String(item && item.symbol ? item.symbol : "").toUpperCase();
    const orderId = String(item && item.orderId != null ? item.orderId : "");
    if (!symbol || !orderId) continue;
    const key = `${symbol}:${orderId}`;
    const current = groups.get(key) || {
      symbol,
      order_id: orderId,
      side: normalizeSideFromTrade(item),
      first_time: parseNumber(item.time, null),
      last_time: parseNumber(item.time, null),
      pnl: 0,
      commission: 0,
      qty: 0,
      quote_qty: 0,
      fills: 0,
      status: "Closed",
    };
    current.first_time = Math.min(current.first_time || Number.MAX_SAFE_INTEGER, parseNumber(item.time, Number.MAX_SAFE_INTEGER));
    current.last_time = Math.max(current.last_time || 0, parseNumber(item.time, 0));
    current.pnl += parseNumber(item.realizedPnl, 0) || 0;
    current.commission += parseNumber(item.commission, 0) || 0;
    current.qty += parseNumber(item.qty, 0) || 0;
    current.quote_qty += parseNumber(item.quoteQty, 0) || 0;
    current.fills += 1;
    groups.set(key, current);
  }
  return Array.from(groups.values())
    .filter((item) => Number.isFinite(item.pnl) && item.pnl !== 0)
    .map((item) => ({
      time: formatTradeTime(item.last_time),
      timestamp: item.last_time,
      date: toDateKey(item.last_time),
      symbol: item.symbol,
      side: item.side,
      pnl: Number(item.pnl.toFixed(8)),
      return:
        Number.isFinite(initialCapital) && initialCapital > 0 ? Number((item.pnl / initialCapital).toFixed(8)) : null,
      status: item.status,
      order_id: item.order_id,
      fills: item.fills,
      commission: Number(item.commission.toFixed(8)),
      qty: Number(item.qty.toFixed(8)),
      quote_qty: Number(item.quote_qty.toFixed(8)),
    }))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

function computeWinRate(trades) {
  const list = Array.isArray(trades) ? trades : [];
  if (!list.length) return null;
  const wins = list.filter((item) => parseNumber(item && item.pnl, 0) > 0).length;
  return wins / list.length;
}

function computeTradingDays(trades) {
  return new Set((Array.isArray(trades) ? trades : []).map((item) => item.date).filter(Boolean)).size;
}

function computeMaxDrawdown(equityPoints) {
  let peak = null;
  let maxDrawdown = 0;
  for (const point of Array.isArray(equityPoints) ? equityPoints : []) {
    const equity = parseNumber(point && point.equity, null);
    if (!Number.isFinite(equity)) continue;
    if (peak == null || equity > peak) peak = equity;
    if (peak && peak > 0) {
      const drawdown = equity / peak - 1;
      if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    }
  }
  return Number(maxDrawdown.toFixed(8));
}

function latestEquity(equityPoints) {
  if (!Array.isArray(equityPoints) || !equityPoints.length) return null;
  return parseNumber(equityPoints[equityPoints.length - 1].equity, null);
}

async function readAccountDocs(db) {
  const [equityDoc, returnDoc, tradeDoc] = await Promise.all([
    accountDataCollection(db).findOne({ _id: EQUITY_DOC_ID }),
    accountDataCollection(db).findOne({ _id: RETURN_DOC_ID }),
    accountDataCollection(db).findOne({ _id: TRADE_DOC_ID }),
  ]);
  return { equityDoc, returnDoc, tradeDoc };
}

async function readBinanceAccountSnapshot(db) {
  const { equityDoc, returnDoc, tradeDoc } = await readAccountDocs(db);
  if (!equityDoc && !returnDoc && !tradeDoc) return null;
  const equityPoints = Array.isArray(equityDoc && equityDoc.points) ? equityDoc.points : [];
  const returnPoints = Array.isArray(returnDoc && returnDoc.points) ? returnDoc.points : [];
  const returnMap = new Map(returnPoints.map((item) => [item.date, parseNumber(item.return, null)]));
  const mergedCurve = equityPoints.map((item) => ({
    date: item.date,
    equity: parseNumber(item.equity, null),
    return: returnMap.has(item.date) ? returnMap.get(item.date) : null,
  }));
  const initialCapital = parseNumber(equityDoc && equityDoc.initial_capital, null);
  const latestReturn =
    returnPoints.length > 0 ? parseNumber(returnPoints[returnPoints.length - 1].return, null) : null;
  const trades = Array.isArray(tradeDoc && tradeDoc.trades) ? tradeDoc.trades : [];
  return {
    updated_at:
      (equityDoc && equityDoc.updated_at) || (returnDoc && returnDoc.updated_at) || (tradeDoc && tradeDoc.updated_at) || null,
    account: {
      exchange: (equityDoc && equityDoc.exchange) || ACCOUNT_EXCHANGE,
      account_name: (equityDoc && equityDoc.account_name) || ACCOUNT_NAME,
      equity_currency: (equityDoc && equityDoc.equity_currency) || ACCOUNT_CURRENCY,
      equity: latestEquity(equityPoints),
      initial_capital: initialCapital,
      total_return: latestReturn,
      max_drawdown: computeMaxDrawdown(equityPoints),
      win_rate:
        tradeDoc && tradeDoc.summary ? parseNumber(tradeDoc.summary.win_rate, null) : computeWinRate(trades),
      trading_days:
        tradeDoc && tradeDoc.summary ? parseNumber(tradeDoc.summary.trading_days, null) : computeTradingDays(trades),
    },
    equity_curve: mergedCurve,
    trades,
  };
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
    out.trades = Array.isArray(snapshot.trades) ? snapshot.trades.slice(0, 100) : [];
  }
  return out;
}

async function syncBinanceAccountData(db) {
  const existingDocs = await readAccountDocs(db);
  const startDate = configuredStartDate();
  const [accountData, allIncomeRows, realizedPnlRows] = await Promise.all([
    binanceSignedGet("/fapi/v2/account"),
    fetchIncomeHistoryInRange({}, startDate),
    fetchIncomeHistoryInRange({ incomeType: "REALIZED_PNL" }, startDate),
  ]);
  const currentWalletBalance =
    parseNumber(accountData && accountData.totalWalletBalance, null) ??
    parseNumber(accountData && accountData.totalMarginBalance, null) ??
    0;
  const dailyNetIncome = buildDailyNetIncome(allIncomeRows);
  const initialCapital = getInitialCapital(currentWalletBalance, dailyNetIncome, existingDocs.equityDoc);
  const periodNetIncome = dailyNetIncome.reduce((sum, item) => sum + (parseNumber(item.net_income, 0) || 0), 0);
  const periodStartingEquity = Number((currentWalletBalance - periodNetIncome).toFixed(8));
  const equityPoints = buildEquityPoints(periodStartingEquity, dailyNetIncome, currentWalletBalance, startDate);
  const returnPoints = buildReturnPoints(equityPoints, initialCapital);
  const tradeSymbols = Array.from(
    new Set([...USER_TRADE_SYMBOLS, ...realizedPnlRows.map((item) => String(item && item.symbol ? item.symbol : "").toUpperCase()).filter(Boolean)])
  );
  const userTrades = await fetchAllUserTrades(tradeSymbols, startDate);
  const trades = userTrades.length ? aggregateUserTrades(userTrades, initialCapital) : normalizeTrades(realizedPnlRows, initialCapital);
  const firstIncomeDate = dailyNetIncome.length ? dailyNetIncome[0].date : null;
  if (firstIncomeDate && firstIncomeDate > toDateKey(startDate)) {
    console.warn(
      `[binance-account] income history starts at ${firstIncomeDate}, later than requested ${toDateKey(
        startDate
      )}; Binance income API may be truncating older history`
    );
  }
  const summary = {
    win_rate: computeWinRate(trades),
    trading_days: computeTradingDays(trades),
    total_trades: trades.length,
    total_wins: trades.filter((item) => parseNumber(item.pnl, 0) > 0).length,
    total_losses: trades.filter((item) => parseNumber(item.pnl, 0) < 0).length,
  };
  const updatedAt = new Date().toISOString();
  await accountDataCollection(db).bulkWrite([
    {
      updateOne: {
        filter: { _id: EQUITY_DOC_ID },
        update: {
          $set: {
            updated_at: updatedAt,
            exchange: ACCOUNT_EXCHANGE,
            account_name: ACCOUNT_NAME,
            equity_currency: ACCOUNT_CURRENCY,
            initial_capital: initialCapital,
            current_equity: latestEquity(equityPoints),
            max_drawdown: computeMaxDrawdown(equityPoints),
            points: equityPoints,
          },
        },
        upsert: true,
      },
    },
    {
      updateOne: {
        filter: { _id: RETURN_DOC_ID },
        update: {
          $set: {
            updated_at: updatedAt,
            initial_capital: initialCapital,
            total_return: returnPoints.length ? returnPoints[returnPoints.length - 1].return : null,
            points: returnPoints,
          },
        },
        upsert: true,
      },
    },
    {
      updateOne: {
        filter: { _id: TRADE_DOC_ID },
        update: {
          $set: {
            updated_at: updatedAt,
            summary,
            trades,
          },
        },
        upsert: true,
      },
    },
  ]);
  const snapshot = await readBinanceAccountSnapshot(db);
  return {
    snapshot,
    docs: {
      equity_history: { points: equityPoints.length },
      return_history: { points: returnPoints.length },
      trade_history: { trades: trades.length, symbols: tradeSymbols.length },
    },
    summary,
    start_date: toDateKey(startDate),
    first_income_date: firstIncomeDate,
  };
}

module.exports = {
  ACCOUNT_DATA_COLLECTION,
  EQUITY_DOC_ID,
  RETURN_DOC_ID,
  TRADE_DOC_ID,
  ACCOUNT_EXCHANGE,
  ACCOUNT_NAME,
  ACCOUNT_CURRENCY,
  hasBinanceAccountConfig,
  readBinanceAccountSnapshot,
  getPublicBinanceAccountSnapshot,
  getTieredBinanceAccountSnapshot,
  syncBinanceAccountData,
  configuredStartDate,
};
