const { sendJson, requireApiKey, toDateKey, fetchJson } = require("./_lib");

const ETF_SYMBOLS = {
  BTC: "https://open-api-v4.coinglass.com/api/etf/bitcoin/flow-history",
  ETH: "https://open-api-v4.coinglass.com/api/etf/ethereum/flow-history",
  SOL: "https://open-api-v4.coinglass.com/api/etf/solana/flow-history",
  XRP: "https://open-api-v4.coinglass.com/api/etf/xrp/flow-history",
};

const ETF_TICKERS = {
  BTC: ["IBIT", "FBTC", "ARKB", "GBTC"],
  ETH: ["ETHA", "FETH", "ETHW"],
  SOL: ["BSOL", "VSOL", "FSOL"],
  XRP: [],
};

async function fetchBinancePrice(symbol) {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
  const r = await fetch(url);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`binance_failed:${r.status}:${t}`);
  }
  const j = await r.json();
  return Number(j.price);
}

async function getPrices() {
  const [btc, eth, usdc] = await Promise.all([
    fetchBinancePrice("BTCUSDT"),
    fetchBinancePrice("ETHUSDT"),
    fetchBinancePrice("USDCUSDT"),
  ]);
  return { btc, eth, usdc };
}

async function getCoinbasePremium(key) {
  const url = "https://open-api-v4.coinglass.com/api/coinbase-premium-index?interval=1d";
  const data = await fetchJson(url, { "CG-API-KEY": key, accept: "application/json" });
  const list = Array.isArray(data && data.data) ? data.data : [];
  if (!list.length) return { premium_rate: null };
  list.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
  const latest = list[list.length - 1];
  return { premium_rate: Number(latest.premium_rate) };
}

async function getOi(key) {
  const url =
    "https://open-api-v4.coinglass.com/api/futures/open-interest/aggregated-history?symbol=BTC&interval=1d";
  const data = await fetchJson(url, { "CG-API-KEY": key, accept: "application/json" });
  const list = Array.isArray(data && data.data) ? data.data : [];
  const dates = [];
  const values = [];
  for (const item of list) {
    if (!item) continue;
    const d = toDateKey(item.time || item.date || item.timestamp || item.t);
    if (!d) continue;
    const v = Number(item.close ?? item.openInterest ?? item.value ?? item.oi ?? item.open ?? 0);
    dates.push(d);
    values.push(Number.isFinite(v) ? v : 0);
  }
  return { dates, values };
}

async function getFunding(key) {
  const url =
    "https://open-api-v4.coinglass.com/api/futures/funding-rate/history?exchange=Binance&symbol=BTCUSDT&interval=1d";
  const data = await fetchJson(url, { "CG-API-KEY": key, accept: "application/json" });
  const list = Array.isArray(data && data.data) ? data.data : [];
  const dates = [];
  const values = [];
  for (const item of list) {
    if (!item) continue;
    const d = toDateKey(item.time || item.date || item.timestamp || item.t);
    if (!d) continue;
    const v = Number(
      item.fundingRate ??
        item.funding_rate ??
        item.rate ??
        item.value ??
        item.close ??
        item.open ??
        0
    );
    dates.push(d);
    values.push(Number.isFinite(v) ? v : 0);
  }
  return { dates, values };
}

async function getLiquidation(key) {
  const url = "https://open-api-v4.coinglass.com/api/futures/liquidation/exchange-list?range=1d";
  const data = await fetchJson(url, { "CG-API-KEY": key, accept: "application/json" });
  const list = Array.isArray(data && data.data) ? data.data : [];
  const TARGETS = ["All", "Binance", "OKX", "Bybit", "Hyperliquid", "Bitget"];
  const rows = [];
  for (const item of list) {
    if (!item || !TARGETS.includes(item.exchange)) continue;
    const total = Number(item.liquidation_usd ?? 0);
    const long = Number(item.longLiquidation_usd ?? item.long_liquidation_usd ?? 0);
    const short = Number(item.shortLiquidation_usd ?? item.short_liquidation_usd ?? 0);
    rows.push({ exchange: item.exchange, total, long, short });
  }
  rows.sort((a, b) => b.total - a.total);
  return {
    exchanges: rows.map((r) => r.exchange),
    long: rows.map((r) => r.long),
    short: rows.map((r) => r.short),
  };
}

async function getEtf(key) {
  const out = {};
  for (const [symbol, url] of Object.entries(ETF_SYMBOLS)) {
    const tickers = ETF_TICKERS[symbol] || [];
    const data = await fetchJson(url, { "CG-API-KEY": key, accept: "application/json" });
    const list = Array.isArray(data && data.data) ? data.data : [];
    const dates = [];
    const total = [];
    const detail = {};
    for (const t of tickers) detail[t] = [];
    const others = [];
    for (const item of list) {
      if (!item) continue;
      const d = toDateKey(item.timestamp);
      if (!d) continue;
      dates.push(d);
      const flows = Array.isArray(item.etf_flows) ? item.etf_flows : [];
      const map = {};
      for (const f of flows) {
        if (!f) continue;
        const tk = f.etf_ticker;
        if (!tk) continue;
        map[tk] = Number(f.flow_usd ?? 0);
      }
      const dayTotal = Object.values(map).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
      let tracked = 0;
      for (const t of tickers) {
        const v = Number(map[t] ?? 0);
        detail[t].push(Number.isFinite(v) ? v : 0);
        tracked += Number.isFinite(v) ? v : 0;
      }
      total.push(dayTotal);
      others.push(dayTotal - tracked);
    }
    out[symbol] = { dates, total, detail, others, tickers };
  }
  return out;
}

async function getExchangeBalance(key) {
  const url = "https://open-api-v4.coinglass.com/api/exchange/balance/chart?symbol=BTC";
  const data = await fetchJson(url, { "CG-API-KEY": key, accept: "application/json" });
  const payload = data && data.data ? data.data : {};
  const timeList = Array.isArray(payload.time_list) ? payload.time_list : [];
  const priceList = Array.isArray(payload.price_list) ? payload.price_list : [];
  const dataMap = payload.data_map || {};
  const dates = timeList.map((t) => toDateKey(t));
  const total = new Array(dates.length).fill(0);
  for (const arr of Object.values(dataMap)) {
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < total.length; i += 1) {
      const v = Number(arr[i] ?? 0);
      total[i] += Number.isFinite(v) ? v : 0;
    }
  }
  const prices = priceList.map((p) => (Number.isFinite(Number(p)) ? Number(p) : 0));
  if (prices.length < total.length) {
    prices.push(...new Array(total.length - prices.length).fill(0));
  }
  return { dates, total, prices };
}

module.exports = async (req, res) => {
  try {
    const key = requireApiKey();
    const urlObj = new URL(req.url, "http://localhost");
    const scope = String(urlObj.searchParams.get("scope") || "all");

    if (scope === "prices") {
      const [prices, premium] = await Promise.all([getPrices(), getCoinbasePremium(key)]);
      sendJson(res, 200, { prices, premium });
      return;
    }

    const [prices, premium, oi, funding, liquidation, etf, exchangeBalance] = await Promise.all([
      getPrices(),
      getCoinbasePremium(key),
      getOi(key),
      getFunding(key),
      getLiquidation(key),
      getEtf(key),
      getExchangeBalance(key),
    ]);

    sendJson(res, 200, { prices, premium, oi, funding, liquidation, etf, exchangeBalance });
  } catch (e) {
    sendJson(res, 500, { error: "market_summary_failed", detail: String(e && e.message ? e.message : e) });
  }
};
